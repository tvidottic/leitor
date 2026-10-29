// Ponto de entrada: biblioteca ↔ leitor, configurações, tema, nuvem, backup e PWA.

import { loadSettings, saveSettings, settings, db, storageEstimate, requestPersistence } from './db.js';
import { Library } from './library.js';
import { Reader } from './reader.js';
import { handleOAuthRedirect } from './cloud.js';
import { $, el, toast, LANGS, formatBytes, downloadText } from './utils.js';

class App {
  constructor() {
    this.appEl = $('#app');
    this.library = new Library({ onOpen: (id) => this.openBook(id) });
    this.reader = null;
  }

  async init() {
    await loadSettings();
    this.applyTheme();
    this.reader = new Reader(this);
    if (new URLSearchParams(location.search).has('diag')) import('./diag.js').then(m => m.startDiag(this.reader)).catch(err => console.error(err));
    this._bindSettings();
    $('#btn-settings-lib').addEventListener('click', () => this.openSettings());
    await this.library.refresh();
    requestPersistence();
    this._registerSw();
    this._handleLaunchFiles();
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.applyTheme());
    window.addEventListener('popstate', () => { if (!this.reader.el.hidden) this.showLibrary(false); });
    window.addEventListener('online', () => this.reader?.sync?.flush());
    window.addEventListener('pagehide', () => this.reader?.stopSession?.());

    // volta do login do Dropbox (PKCE)
    if (await handleOAuthRedirect()) {
      try {
        const ret = JSON.parse(sessionStorage.getItem('leitor.dbx.return') || 'null');
        sessionStorage.removeItem('leitor.dbx.return');
        if (ret?.book) await this.openBook(ret.book);
      } catch { /* ignore */ }
    }
  }

  // ------------------------------------------------------------ navegação
  async openBook(id) {
    const book = await this.library.getBook(id);
    const blob = await this.library.getFile(id);
    if (!book || !blob) { toast('Arquivo não encontrado.'); return; }
    $('#library').hidden = true;
    this.appEl.dataset.view = 'reader';
    if (!history.state?.reader) history.pushState({ reader: true }, '');
    await this.reader.open(book, blob);
  }

  async showLibrary(pop = true) {
    if (!this.reader.el.hidden) await this.reader.close();
    $('#library').hidden = false;
    this.appEl.dataset.view = 'library';
    if (pop && history.state?.reader) history.back();
    await this.library.refresh();
  }

  // ------------------------------------------------------------ tema
  applyTheme() {
    const t = settings().theme;
    const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = t === 'sepia' ? 'sepia' : dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]').content = dark ? '#1f2430' : t === 'sepia' ? '#faf3e3' : '#ffffff';
  }

  // ------------------------------------------------------------ configurações
  _bindSettings() {
    const tl = $('#set-tl'), sl = $('#set-sl');
    sl.append(el('option', { value: 'auto', text: 'Detectar automaticamente' }));
    for (const [code, name] of LANGS) { tl.append(el('option', { value: code, text: name })); sl.append(el('option', { value: code, text: name })); }
    const dlg = $('#settings-dialog');
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'ok') return;
      const patch = {
        tl: tl.value, sl: sl.value,
        autoPopup: $('#set-autopopup').checked, tapWord: $('#set-tapword').checked, dict: $('#set-dict').checked, customSel: $('#set-customsel').value,
        theme: $('#set-theme').value, night: $('#set-night').checked, tapZones: $('#set-tapzones').checked,
        author: $('#set-author').value.trim(), wakeLock: $('#set-wakelock').checked,
        apiKey: $('#set-apikey').value.trim(), model: $('#set-model').value, effort: $('#set-effort').value, level: $('#set-level').value,
        gClientId: $('#set-gclient').value.trim(), dbxAppKey: $('#set-dbxkey').value.trim(),
      };
      await saveSettings(patch);
      this.applyTheme();
      if (this.reader) {
        this.reader.applyNight(patch.night);
        this.reader.tapMode = patch.tapWord; this.reader.applyTapMode();
        this.reader.panel.tlSelect.value = patch.tl;
        this.reader.applySelectionMode();
      }
      toast('Configurações salvas.');
    });
    $('#btn-clear-cache').addEventListener('click', async () => { await db.clear('trcache'); toast('Cache de traduções limpo.'); this._updateStorageInfo(); });
    $('#btn-backup').addEventListener('click', () => this.backup());
    $('#btn-restore').addEventListener('click', () => $('#restore-input').click());
    $('#restore-input').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) await this.restore(f); });
  }

  async openSettings() {
    const s = settings();
    $('#set-tl').value = s.tl; $('#set-sl').value = s.sl;
    $('#set-autopopup').checked = s.autoPopup; $('#set-tapword').checked = s.tapWord; $('#set-dict').checked = s.dict; $('#set-customsel').value = s.customSel || 'auto';
    $('#set-theme').value = s.theme; $('#set-night').checked = s.night; $('#set-tapzones').checked = s.tapZones !== false;
    $('#set-author').value = s.author || ''; $('#set-wakelock').checked = s.wakeLock !== false;
    $('#set-apikey').value = s.apiKey || ''; $('#set-model').value = s.model; $('#set-effort').value = s.effort; $('#set-level').value = s.level;
    $('#set-gclient').value = s.gClientId || ''; $('#set-dbxkey').value = s.dbxAppKey || '';
    this._updateStorageInfo();
    $('#settings-dialog').showModal();
  }

  async _updateStorageInfo() {
    const info = $('#storage-info');
    const [books, est, cache] = await Promise.all([db.count('books'), storageEstimate(), db.count('trcache')]);
    info.textContent = `${books} livro(s) · ${cache} tradução(ões) em cache` + (est?.usage ? ` · ${formatBytes(est.usage)} usados${est.quota ? ` de ${formatBytes(est.quota)}` : ''}` : '');
  }

  // ------------------------------------------------------------ backup
  async backup() {
    const [books, annotations, vocab] = await Promise.all([db.all('books'), db.all('annotations'), db.all('vocab')]);
    const data = {
      app: 'leitor', version: 2, exportedAt: new Date().toISOString(),
      books: books.map(({ cover, source, ...b }) => ({ ...b, source: source ? { type: source.type, name: source.name, fileId: source.fileId, path: source.path } : null })),
      annotations, vocab,
    };
    downloadText(`leitor-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
    toast('Backup gerado. Os PDFs em si podem ser baixados pelo menu de cada livro.');
  }

  async restore(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'leitor') throw new Error('Arquivo não é um backup do Leitor.');
      const books = await db.all('books');
      const byHash = new Map(books.map(b => [b.hash, b]));
      const idMap = new Map();
      let skipped = 0;
      for (const b of data.books || []) {
        const local = byHash.get(b.hash);
        if (local) {
          idMap.set(b.id, local.id);
          local.bookmarks = mergeBookmarks(local.bookmarks, b.bookmarks);
          local.readingSeconds = Math.max(local.readingSeconds || 0, b.readingSeconds || 0);
          if ((b.lastOpenedAt || 0) > (local.lastOpenedAt || 0)) { local.lastPage = b.lastPage; local.yRatio = b.yRatio; }
          await db.put('books', local);
        } else skipped++;
      }
      const anns = (data.annotations || []).filter(a => idMap.has(a.bookId)).map(a => ({ ...a, bookId: idMap.get(a.bookId) }));
      const existing = new Set((await db.all('annotations')).map(a => a.id));
      await db.putMany('annotations', anns.filter(a => !existing.has(a.id)));
      const vocabExisting = new Set((await db.all('vocab')).map(v => v.wordKey));
      await db.putMany('vocab', (data.vocab || []).filter(v => !vocabExisting.has(v.wordKey)).map(v => ({ ...v, bookId: idMap.get(v.bookId) || v.bookId })));
      await this.library.refresh();
      toast(`Backup restaurado: ${anns.length} anotação(ões), ${(data.vocab || []).length} palavra(s).${skipped ? ` ${skipped} livro(s) do backup não estão nesta biblioteca; importe os PDFs e restaure de novo.` : ''}`, 7000);
    } catch (err) { toast(`Não foi possível restaurar: ${err.message}`, 5000); }
  }

  // ------------------------------------------------------------ PWA
  _registerSw() {
    if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('Service worker não registrado:', err));
  }
  _handleLaunchFiles() {
    if ('launchQueue' in window) {
      window.launchQueue.setConsumer(async (params) => {
        const handles = (params.files || []).filter(h => h.kind === 'file');
        if (handles.length) this.library.importHandles(handles);
      });
    }
  }
}

function mergeBookmarks(a = [], b = []) {
  const map = new Map((a || []).map(x => [x.page, x]));
  for (const x of b || []) if (!map.has(x.page)) map.set(x.page, x);
  return [...map.values()].sort((x, y) => x.page - y.page);
}

const app = new App();
app.init().catch(err => { console.error(err); toast(`Erro ao iniciar: ${err.message || err}`, 6000); });
window.leitor = app;
