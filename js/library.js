// Biblioteca: importação (dispositivo, arquivo vinculado, nuvem), listagem e gerenciamento dos livros.

import { db } from './db.js';
import { $, el, icon, uid, toast, confirmDialog, formatBytes, formatDate } from './utils.js';
import { pdfjsLib } from './viewer.js';
import { pickCloudFile, getProvider } from './cloud.js';

export const hasFSA = () => typeof window.showOpenFilePicker === 'function';
const PDF_TYPES = [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }];

export class Library {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.grid = $('#book-grid');
    this.books = [];
    this.filter = '';
    this._bind();
  }

  _bind() {
    const input = $('#file-input');
    $('#btn-import').addEventListener('click', (e) => this.openMenu(e.currentTarget));
    input.addEventListener('change', () => { this.importFiles(input.files); input.value = ''; });

    const dz = $('#dropzone');
    dz.addEventListener('click', () => this.openMenu(dz));
    const lib = $('#library');
    ['dragenter', 'dragover'].forEach(ev => lib.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => lib.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
    lib.addEventListener('drop', e => this.onDrop(e));

    $('#lib-search').addEventListener('input', e => { this.filter = e.target.value.trim().toLowerCase(); this.render(); });
    this.grid.addEventListener('click', e => this._onGridClick(e));
    this.grid.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('book-card')) this.onOpen(e.target.dataset.id); });
  }

  openMenu(anchor) {
    const items = [
      el('button', { onclick: () => { close(); $('#file-input').click(); } }, icon('file'), hasFSA() ? 'Do dispositivo (cópia)' : 'Do dispositivo'),
    ];
    if (hasFSA()) items.push(el('button', { onclick: () => { close(); this.openLinked(); } }, icon('link'), 'Do dispositivo, vinculado ao arquivo'));
    items.push(
      el('button', { onclick: () => { close(); this.importFromCloud('gdrive'); } }, icon('cloud'), 'Google Drive'),
      el('button', { onclick: () => { close(); this.importFromCloud('dropbox'); } }, icon('cloud'), 'Dropbox'),
    );
    const menu = el('div', { class: 'ctx-menu' }, ...items,
      el('p', { class: 'muted', style: { margin: '6px 10px 4px', fontSize: '12px', maxWidth: '260px' } }, hasFSA()
        ? 'Arquivos vinculados (inclusive em pastas sincronizadas do OneDrive, Google Drive, iCloud ou Dropbox) recebem as anotações diretamente.'
        : 'Neste navegador, use o Google Drive ou o Dropbox para que as anotações sejam salvas no arquivo original.'));
    const close = () => { menu.remove(); document.removeEventListener('pointerdown', onDoc, true); };
    const onDoc = (ev) => { if (!menu.contains(ev.target)) close(); };
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
    setTimeout(() => document.addEventListener('pointerdown', onDoc, true));
  }

  async onDrop(e) {
    const items = Array.from(e.dataTransfer.items || []);
    if (hasFSA() && items.some(i => typeof i.getAsFileSystemHandle === 'function')) {
      const handles = (await Promise.all(items.filter(i => i.kind === 'file').map(i => i.getAsFileSystemHandle().catch(() => null)))).filter(h => h && h.kind === 'file');
      if (handles.length) { await this.importHandles(handles); return; }
    }
    this.importFiles(e.dataTransfer.files);
  }

  async refresh() {
    this.books = (await db.all('books')).sort((a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt));
    this.render();
  }

  render() {
    const list = this.filter ? this.books.filter(b => `${b.title} ${b.author || ''} ${b.fileName}`.toLowerCase().includes(this.filter)) : this.books;
    $('#dropzone').classList.toggle('compact', this.books.length > 0);
    if (!list.length) {
      this.grid.replaceChildren(el('div', { class: 'empty' }, this.books.length ? 'Nenhum livro corresponde à busca.' : 'Sua biblioteca está vazia. Abra um PDF para começar.'));
      return;
    }
    this.grid.replaceChildren(...list.map(b => this._card(b)));
  }

  _card(b) {
    const pct = b.pages ? Math.round(((b.lastPage || 1) - 1) / Math.max(1, b.pages - 1) * 100) : 0;
    const src = b.source;
    const badge = src ? el('span', { class: 'src-badge', title: sourceLabel(src) }, icon(src.type === 'fsa' ? 'link' : 'cloud'), src.type === 'fsa' ? '' : (src.type === 'gdrive' ? 'Drive' : 'Dropbox')) : null;
    const cover = el('div', { class: 'book-cover' }, b.cover ? el('img', { src: b.cover, alt: '', loading: 'lazy' }) : icon('book'), badge);
    const time = b.readingSeconds ? formatDuration(b.readingSeconds) : '';
    return el('div', { class: 'book-card', dataset: { id: b.id }, tabindex: 0, title: b.title },
      cover,
      el('div', { class: 'book-info' },
        el('div', { class: 'title', text: b.title }),
        el('div', { class: 'meta' }, el('span', { text: b.pages ? `${b.lastPage || 1}/${b.pages} pág.` : '' }), el('span', { text: time || `${pct}%` })),
        el('div', { class: 'progress' }, el('span', { style: { width: `${pct}%` } })),
      ),
      el('button', { class: 'btn icon ghost card-menu', dataset: { menu: b.id }, title: 'Opções', 'aria-label': 'Opções do livro' }, icon('more')),
    );
  }

  _onGridClick(e) {
    const menuBtn = e.target.closest('[data-menu]');
    if (menuBtn) { e.stopPropagation(); this._showMenu(menuBtn, menuBtn.dataset.menu); return; }
    const card = e.target.closest('.book-card');
    if (card) this.onOpen(card.dataset.id);
  }

  _showMenu(anchor, id) {
    const book = this.books.find(b => b.id === id);
    if (!book) return;
    document.querySelectorAll('.ctx-menu').forEach(m => m.remove());
    const menu = el('div', { class: 'ctx-menu' },
      el('button', { onclick: () => { menu.remove(); this.onOpen(id); } }, icon('book'), 'Abrir'),
      el('button', { onclick: async () => { menu.remove(); const t = prompt('Título do livro:', book.title); if (t && t.trim()) { book.title = t.trim(); await db.put('books', book); this.render(); } } }, icon('text'), 'Renomear'),
      book.source ? el('button', { onclick: async () => { menu.remove(); await this.unlink(book); } }, icon('link'), `Desvincular (${sourceLabel(book.source)})`) : null,
      hasFSA() ? el('button', { onclick: async () => { menu.remove(); await this.saveAs(book); } }, icon('link'), 'Salvar como… (vincular a arquivo)') : null,
      el('button', { onclick: async () => { menu.remove(); if (book.lastPage > 1 && await confirmDialog('Voltar ao início do livro?', 'Reiniciar')) { book.lastPage = 1; book.yRatio = 0; await db.put('books', book); this.render(); } } }, icon('back'), 'Reiniciar leitura'),
      el('button', { onclick: async () => { menu.remove(); await this.exportFile(book); } }, icon('download'), 'Baixar PDF com anotações'),
      el('button', { class: 'danger', onclick: async () => { menu.remove(); if (await confirmDialog(`Excluir “${book.title}” da biblioteca?${book.source ? ' O arquivo original não será apagado.' : ''}`, 'Excluir')) await this.remove(id); } }, icon('trash'), 'Excluir'),
    );
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(r.bottom + 4, innerHeight - menu.offsetHeight - 8)}px`;
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true));
  }

  // ------------------------------------------------------------ importação
  async importFiles(files, sources = []) {
    const pdfs = Array.from(files || []).filter(f => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (!pdfs.length) { toast('Selecione arquivos PDF.'); return; }
    let lastId = null;
    for (let i = 0; i < pdfs.length; i++) {
      const f = pdfs[i];
      try {
        toast(`Importando “${f.name}”…`, 6000);
        lastId = await this.importFile(f, sources[i] || null);
      } catch (err) {
        console.error(err);
        toast(`Não foi possível abrir “${f.name}”: ${err.message || err}`, 5000);
      }
    }
    await this.refresh();
    if (lastId) { toast(pdfs.length > 1 ? `${pdfs.length} livros importados.` : 'Livro importado.'); if (pdfs.length === 1) this.onOpen(lastId); }
  }

  async openLinked() {
    try {
      const handles = await window.showOpenFilePicker({ types: PDF_TYPES, multiple: true });
      await this.importHandles(handles);
    } catch (err) { if (err?.name !== 'AbortError') toast(`Não foi possível abrir: ${err.message}`); }
  }

  async importHandles(handles) {
    const files = [], sources = [];
    for (const h of handles) {
      try { const f = await h.getFile(); files.push(f); sources.push({ type: 'fsa', handle: h, name: f.name }); }
      catch (err) { toast(`Não foi possível ler ${h.name}: ${err.message}`); }
    }
    await this.importFiles(files, sources);
  }

  async importFromCloud(providerId) {
    const res = await pickCloudFile(providerId);
    if (!res) return;
    const { provider, file } = res;
    const source = provider.makeSource(file);
    toast(`Baixando “${file.name}” do ${provider.name}…`, 8000);
    try {
      const blob = await provider.download(source);
      const f = new File([blob], file.name, { type: 'application/pdf' });
      await this.importFiles([f], [source]);
    } catch (err) {
      toast(err.code === 'AUTH' ? `Entre no ${provider.name} e tente de novo.` : `Falha ao baixar: ${err.message}`, 5000);
    }
  }

  async importFile(file, source = null) {
    const buf = await file.arrayBuffer();
    const hash = await digest(buf);
    const existing = this.books.find(b => b.hash === hash);
    if (existing) {
      if (source && !existing.source) { existing.source = source; await db.put('books', existing); toast(`“${existing.title}” agora está vinculado a ${sourceLabel(source)}.`); }
      else toast('Este livro já está na biblioteca.');
      return existing.id;
    }
    // mesmo arquivo de origem (mudou o conteúdo, ex.: anotado em outro app): atualiza o livro existente
    const sameSource = source && this.books.find(b => b.source && sameSourceRef(b.source, source));
    if (sameSource) {
      await db.put('files', { id: sameSource.id, blob: new Blob([buf], { type: 'application/pdf' }) });
      sameSource.hash = hash; sameSource.size = file.size; sameSource.source = source;
      await db.put('books', sameSource);
      toast(`“${sameSource.title}” atualizado a partir do arquivo.`);
      return sameSource.id;
    }

    const task = pdfjsLib.getDocument({ data: buf.slice(0), isEvalSupported: false });
    const pdf = await task.promise;
    let title = file.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
    let author = '';
    try {
      const meta = await pdf.getMetadata();
      const t = meta.info?.Title?.trim();
      if (t && t.length > 2 && !/^untitled|microsoft word|\.(docx?|indd|pdf)$/i.test(t)) title = t;
      author = meta.info?.Author?.trim() || '';
    } catch { /* ignore */ }
    let cover = null;
    try {
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 300 / base.width });
      const canvas = el('canvas'); canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
      cover = canvas.toDataURL('image/jpeg', 0.78);
    } catch { /* ignore */ }
    const pages = pdf.numPages;
    await task.destroy();

    const id = uid();
    const book = { id, title, author, fileName: file.name, size: file.size, pages, hash, cover, source, addedAt: Date.now(), lastOpenedAt: 0, lastPage: 1, yRatio: 0, zoomMode: 'auto', bookmarks: [], readingSeconds: 0 };
    await db.put('files', { id, blob: new Blob([buf], { type: 'application/pdf' }) });
    await db.put('books', book);
    this.books.unshift(book);
    return id;
  }

  /** Vincula o livro a um novo arquivo no disco (Salvar como…). */
  async saveAs(book) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: book.fileName || `${book.title}.pdf`, types: PDF_TYPES });
      const f = await db.get('files', book.id);
      const w = await handle.createWritable();
      await w.write(f.blob); await w.close();
      book.source = { type: 'fsa', handle, name: handle.name, savedAt: Date.now() };
      await this.updateBook(book);
      this.render();
      toast(`Vinculado a ${handle.name}. As anotações passam a ser salvas nesse arquivo.`);
      return true;
    } catch (err) { if (err?.name !== 'AbortError') toast(`Não foi possível salvar: ${err.message}`); return false; }
  }

  async unlink(book) {
    book.source = null;
    await this.updateBook(book);
    this.render();
    toast('Livro desvinculado: as anotações continuam na cópia do aplicativo.');
  }

  async exportFile(book) {
    const f = await db.get('files', book.id);
    if (!f) return;
    const url = URL.createObjectURL(f.blob);
    const a = el('a', { href: url, download: book.fileName || `${book.title}.pdf` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async remove(id) {
    const anns = await db.byIndex('annotations', 'bookId', id);
    await db.delMany('annotations', anns.map(a => a.id));
    await db.del('files', id);
    await db.del('books', id);
    await this.refresh();
    toast('Livro excluído.');
  }

  async getBook(id) { return db.get('books', id); }
  async getFile(id) { const f = await db.get('files', id); return f?.blob; }
  async updateBook(book) { await db.put('books', book); const i = this.books.findIndex(b => b.id === book.id); if (i >= 0) this.books[i] = book; }

  /** Reabre o arquivo de origem para verificar se mudou fora do app (ex.: anotado no Acrobat). */
  async refreshFromSource(book) {
    const src = book.source;
    if (!src) return false;
    try {
      let blob = null;
      if (src.type === 'fsa') {
        const perm = await src.handle.queryPermission({ mode: 'read' }).catch(() => 'denied');
        if (perm !== 'granted') return false;
        blob = await src.handle.getFile();
      } else {
        const provider = getProvider(src.type);
        if (!provider || src.pendingUpload) return false;
        blob = await provider.download(src);
      }
      const buf = await blob.arrayBuffer();
      const hash = await digest(buf);
      if (hash === book.hash) return false;
      await db.put('files', { id: book.id, blob: new Blob([buf], { type: 'application/pdf' }) });
      book.hash = hash; book.size = buf.byteLength;
      await this.updateBook(book);
      return true;
    } catch { return false; }
  }
}

export function sourceLabel(src) {
  if (!src) return '';
  if (src.type === 'fsa') return `arquivo ${src.name || ''}`.trim();
  if (src.type === 'gdrive') return `Google Drive: ${src.name}`;
  if (src.type === 'dropbox') return `Dropbox: ${src.path || src.name}`;
  return src.name || '';
}
function sameSourceRef(a, b) {
  if (a.type !== b.type) return false;
  if (a.type === 'gdrive') return a.fileId === b.fileId;
  if (a.type === 'dropbox') return a.path === b.path;
  return false; // handles do disco são comparados pelo conteúdo (hash)
}
export function formatDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}
async function digest(buf) {
  try {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return `${buf.byteLength}-${Date.now()}`; }
}
export { formatBytes, formatDate };
