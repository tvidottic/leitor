// Sincroniza as anotações para dentro do arquivo PDF (via worker com pdf-lib) e grava o resultado
// no destino vinculado: arquivo local (File System Access), Google Drive ou Dropbox.

import { db, settings } from './db.js';
import { debounce } from './utils.js';
import { getProvider } from './cloud.js';

export class PdfSync extends EventTarget {
  constructor(reader) {
    super();
    this.reader = reader;
    this.worker = null;
    this.pending = new Map();
    this.status = 'clean';   // clean | dirty | saving | saved | error | needs-permission | offline
    this.message = '';
    this.busy = false;
    this.queued = false;
    this.schedule = debounce(() => this.run(), 2500);
  }

  setStatus(status, message = '') {
    this.status = status; this.message = message;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, message } }));
  }

  /** Chamado a cada alteração de anotação. */
  changed() {
    if (this.status !== 'saving') this.setStatus('dirty');
    this.schedule();
  }

  get book() { return this.reader.book; }

  /** Gera os bytes do PDF com as anotações atuais (sem gravar em lugar nenhum). */
  async buildBytes() {
    const book = this.book;
    const blob = await this.reader.app.library.getFile(book.id);
    if (!blob) throw new Error('Arquivo não encontrado.');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const annotations = this.reader.ann.items.filter(a => a.bookId === book.id).map(a => ({
      id: a.id, page: a.page, type: a.type, color: a.color, rects: a.rects, paths: a.paths, width: a.width,
      note: a.note, author: a.author, createdAt: a.createdAt, updatedAt: a.updatedAt,
    }));
    return this.callWorker({ bytes, annotations, author: (settings().author || '').trim() || 'Leitor' });
  }

  callWorker(payload) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./pdf-writer.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => {
        const { id, ok, bytes, error } = e.data;
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        ok ? p.resolve(bytes) : p.reject(new Error(error));
      };
      this.worker.onerror = (e) => { for (const p of this.pending.values()) p.reject(new Error(e.message || 'Falha no worker')); this.pending.clear(); };
    }
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...payload }, [payload.bytes.buffer]);
    });
  }

  /** Grava as anotações no PDF armazenado e no destino vinculado. */
  async run({ force = false } = {}) {
    const book = this.book;
    if (!book) return;
    if (!force && !this.reader.ann.dirty) { return; }
    if (this.busy) { this.queued = true; return; }
    this.busy = true;
    this.setStatus('saving');
    try {
      const bytes = await this.buildBytes();
      if (this.book !== book) return; // livro trocado durante a gravação
      await db.put('files', { id: book.id, blob: new Blob([bytes], { type: 'application/pdf' }) });
      book.size = bytes.byteLength;
      this.reader.ann.markSaved();
      await this.writeBack(book, bytes);
      // anotações apagadas/alteradas que o documento aberto ainda desenha: recarrega o documento
      if (this.reader.ann.needsReload && this.book === book) await this.reader.reloadFromBytes(bytes);
    } catch (err) {
      console.warn('Falha ao gravar anotações no PDF:', err);
      this.setStatus('error', err.message || String(err));
    } finally {
      this.busy = false;
      if (this.queued) { this.queued = false; this.schedule(); }
    }
  }

  async writeBack(book, bytes) {
    const src = book.source;
    if (!src) { this.setStatus('saved', 'Anotações gravadas na cópia do aplicativo'); return; }
    if (src.type === 'fsa') {
      const handle = src.handle;
      if (!handle) { this.setStatus('saved'); return; }
      let perm = await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
      if (perm !== 'granted') { this.setStatus('needs-permission', 'Toque para permitir salvar no arquivo'); return; }
      const w = await handle.createWritable();
      await w.write(bytes);
      await w.close();
      book.source.savedAt = Date.now();
      await this.reader.app.library.updateBook(book);
      this.setStatus('saved', `Salvo em ${src.name}`);
      return;
    }
    if (!navigator.onLine) { this.setStatus('offline', 'Sem conexão: será enviado à nuvem ao reconectar'); book.source.pendingUpload = true; await this.reader.app.library.updateBook(book); return; }
    const provider = getProvider(src.type);
    if (!provider) { this.setStatus('saved'); return; }
    try {
      await provider.upload(src, bytes);
      book.source.savedAt = Date.now(); book.source.pendingUpload = false;
      await this.reader.app.library.updateBook(book);
      this.setStatus('saved', `Salvo no ${provider.name}`);
    } catch (err) {
      if (err.code === 'AUTH') { book.source.pendingUpload = true; await this.reader.app.library.updateBook(book); this.setStatus('needs-permission', `Toque para entrar no ${provider.name} e salvar`); return; }
      throw err;
    }
  }

  /** Ação do usuário (clique) para conceder permissão / reautenticar e gravar. */
  async resolvePermission() {
    const book = this.book;
    const src = book?.source;
    if (!src) return;
    if (src.type === 'fsa') {
      const perm = await src.handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied');
      if (perm !== 'granted') { this.setStatus('error', 'Permissão negada'); return; }
    } else {
      const provider = getProvider(src.type);
      await provider.authorize(true);
    }
    this.reader.ann.dirty = true;
    await this.run({ force: true });
  }

  /** Força a gravação imediata (fechar livro, exportar). */
  async flush() {
    if (this.reader.ann?.dirty) await this.run({ force: true });
    else if (this.book?.source?.pendingUpload) await this.run({ force: true });
  }
}
