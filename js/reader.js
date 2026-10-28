// Tela de leitura: barra de ferramentas, painel lateral, seleção de texto, caneta, marcadores,
// histórico de navegação, leitura em voz alta, tela imersiva e gravação das anotações no PDF.

import { PdfViewer } from './viewer.js';
import { AnnotationManager, COLORS } from './annotations.js';
import { TranslationPanel } from './panel.js';
import { PdfSync } from './pdfsync.js';
import { InkTool } from './ink.js';
import { translate } from './translate.js';
import { saveVocab, listVocab, removeVocab, updateVocab, vocabToCsv } from './vocab.js';
import { settings, saveSettings } from './db.js';
import { hasFSA } from './library.js';
import { $, $$, el, icon, debounce, rafThrottle, toast, copyText, speak, normalizeText, isSingleWord, downloadText, clamp, isCoarsePointer, escapeHtml, langToBcp47 } from './utils.js';

export class Reader {
  constructor(app) {
    this.app = app;
    this.el = $('#reader');
    this.container = $('#viewer-container');
    this.viewer = new PdfViewer(this.container, $('#viewer'));
    this.ann = new AnnotationManager(this.viewer);
    this.panel = new TranslationPanel(this);
    this.sync = new PdfSync(this);
    this.ink = new InkTool(this.viewer, this.ann);
    this.book = null;
    this.lastColor = 'yellow';
    this.tapMode = false;
    this.syncReady = false;
    this.history = [];
    this.selToolbar = $('#sel-toolbar');
    this.wordPopup = $('#word-popup');
    this.annMenu = $('#ann-menu');
    this.sidebar = $('#sidebar');
    this.thumbObserver = null;
    this.popupAbort = null;
    this.searchAbort = null;
    this.vocabItems = [];
    this.tts = { active: false, paused: false, page: 0, index: 0, paras: [], lang: null, utter: null };
    this._bindToolbar();
    this._bindMoreMenu();
    this._bindInkBar();
    this._bindTts();
    this._bindSidebar();
    this._bindSelection();
    this._bindKeyboard();
    this._bindViewerEvents();
    this._bindImmersive();
    this.ann.addEventListener('change', () => { this.renderAnnotList(); if (this.syncReady && this.ann.dirty) this.sync.changed(); });
    this.sync.addEventListener('status', (e) => this.renderSaveStatus(e.detail));
  }

  // =============================================================== abrir / fechar
  async open(book, blob) {
    this.book = book;
    this.el.hidden = false;
    this.syncReady = false;
    this.history = []; $('#btn-hist-back').hidden = true;
    $('#book-title').textContent = book.title;
    document.title = `${book.title} — Leitor`;
    $('#loading').hidden = false;
    $('#loading-text').textContent = 'Carregando o livro…';
    this.clearSelectionUi();
    this.panel.hide();
    this.stopTts();
    this.setInk(false);
    this.tapMode = !!settings().tapWord;
    this.applyTapMode();
    this.applyNight(settings().night);
    const s = settings();
    const sidebarOpen = s.sidebarOpen ?? (window.innerWidth > 1100);
    this.sidebar.hidden = !sidebarOpen;
    this.renderSaveStatus({ status: book.source ? 'saved' : 'clean', message: '' });

    try {
      // arquivo vinculado alterado fora do app (ex.: anotado no Acrobat)? recarrega os bytes
      if (book.source && (book.source.type === 'fsa' || (navigator.onLine && Date.now() - (book.source.checkedAt || 0) > 10 * 60_000))) {
        $('#loading-text').textContent = 'Verificando o arquivo de origem…';
        const changed = await this.app.library.refreshFromSource(book).catch(() => false);
        book.source.checkedAt = Date.now();
        if (changed) { blob = await this.app.library.getFile(book.id); toast('Arquivo atualizado a partir da origem.'); }
      }
      const data = await blob.arrayBuffer();
      await this.viewer.load(data, { page: book.lastPage || 1, yRatio: book.yRatio || 0, zoomMode: book.zoomMode || 'auto', rotation: book.rotation || 0, cropMargins: !!book.cropMargins, pageMode: book.pageMode || 'scroll' });
      $('#loading').hidden = true;
      await this.ann.load(book.id);
      $('#page-count').textContent = this.viewer.numPages;
      $('#page-input').max = this.viewer.numPages;
      $('#page-input').value = this.viewer.currentPage;
      this.updateZoomSelect();
      this.buildThumbs();
      this.buildOutline();
      this.renderBookmarks();
      this.refreshVocab();
      $('#pagetr-list').replaceChildren();
      $('#search-results').replaceChildren(); $('#search-status').textContent = '';
      $('#more-link-file').hidden = !hasFSA();
      book.lastOpenedAt = Date.now();
      await this.app.library.updateBook(book);
      this.startSession();
      // importa anotações já existentes no PDF antes de permitir gravações
      const n = await this.ann.importFromPdf();
      if (n) toast(`${n} anotação(ões) do PDF importada(s).`);
      this.syncReady = true;
      if (book.source?.pendingUpload) this.sync.flush();
    } catch (err) {
      console.error(err);
      toast(`Não foi possível abrir o livro: ${err.message || err}`, 5000);
      this.app.showLibrary();
    } finally {
      $('#loading').hidden = true;
      this.container.focus({ preventScroll: true });
    }
  }

  async close() {
    this.stopTts();
    this.setInk(false);
    this.stopSession();
    await this.savePositionNow();
    if (this.syncReady) {
      this.renderSaveStatus({ status: 'saving' });
      await this.sync.flush();
    }
    this.syncReady = false;
    await this.viewer.closeDocument();
    this.el.hidden = true;
    this.book = null;
    document.title = 'Leitor — PDF, anotações e tradução';
    this.clearSelectionUi();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  layoutChanged() { this.viewer.onResize(); }

  /** Recarrega o documento a partir de novos bytes (após gravar anotações), mantendo a posição. */
  async reloadFromBytes(bytes) {
    const v = this.viewer;
    const pos = v.getPosition();
    const copy = bytes.slice(0);
    await v.load(copy.buffer, { page: pos.page, yRatio: pos.yRatio, zoomMode: v.zoomMode, rotation: v.rotation, cropMargins: v.cropMargins, pageMode: v.pageMode });
    this.ann.needsReload = false;
    await this.ann.importFromPdf();
    for (const p of v.pages) if (p.rendered) this.ann.renderPage(p.num);
  }

  savePosition = debounce(() => this.savePositionNow(), 600);
  async savePositionNow() {
    if (!this.book || !this.viewer.pdf) return;
    const pos = this.viewer.getPosition();
    Object.assign(this.book, { lastPage: pos.page, yRatio: pos.yRatio, zoomMode: this.viewer.zoomMode, rotation: this.viewer.rotation, cropMargins: this.viewer.cropMargins, pageMode: this.viewer.pageMode, lastOpenedAt: Date.now() });
    await this.app.library.updateBook(this.book);
  }

  // ---- tempo de leitura
  startSession() { this.sessionStart = Date.now(); this._sessionTimer = setInterval(() => this.flushSession(), 60_000); document.addEventListener('visibilitychange', this._onVis = () => { document.hidden ? this.flushSession(true) : this.sessionStart = Date.now(); }); }
  flushSession(pause = false) {
    if (!this.book || !this.sessionStart) return;
    const secs = Math.round((Date.now() - this.sessionStart) / 1000);
    if (secs > 0 && secs < 3600 * 6) this.book.readingSeconds = (this.book.readingSeconds || 0) + secs;
    this.sessionStart = pause ? null : Date.now();
    this.app.library.updateBook(this.book);
  }
  stopSession() { this.flushSession(true); clearInterval(this._sessionTimer); if (this._onVis) document.removeEventListener('visibilitychange', this._onVis); }

  // =============================================================== barra de ferramentas
  _bindToolbar() {
    $('#btn-back').addEventListener('click', () => this.app.showLibrary());
    $('#btn-sidebar').addEventListener('click', () => this.toggleSidebar());
    $('#btn-prev').addEventListener('click', () => this.viewer.prevPage());
    $('#btn-next').addEventListener('click', () => this.viewer.nextPage());
    $('#btn-hist-back').addEventListener('click', () => this.historyBack());
    const pageInput = $('#page-input');
    pageInput.addEventListener('change', () => { this.jumpTo(parseInt(pageInput.value, 10) || 1); this.container.focus(); });
    pageInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pageInput.blur(); this.jumpTo(parseInt(pageInput.value, 10) || 1); } });
    $('#btn-zoom-in').addEventListener('click', () => this.viewer.zoomStep(1));
    $('#btn-zoom-out').addEventListener('click', () => this.viewer.zoomStep(-1));
    $('#zoom-select').addEventListener('change', e => this.viewer.setZoom(e.target.value));
    $('#btn-tap-mode').addEventListener('click', () => { this.tapMode = !this.tapMode; this.applyTapMode(); saveSettings({ tapWord: this.tapMode }); toast(this.tapMode ? 'Modo toque: toque em uma palavra para traduzi-la.' : 'Modo toque desativado.'); });
    $('#btn-ink').addEventListener('click', () => this.setInk(!this.ink.active));
    $('#btn-bookmark').addEventListener('click', () => this.toggleBookmark());
    $('#btn-search').addEventListener('click', () => { this.showSidebar('search'); $('#search-input').focus(); });
    $('#btn-panel').addEventListener('click', () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && this.selectionInViewer(sel)) this.translateSelection('quick');
      else this.panel.toggle();
    });
    $('#btn-more').addEventListener('click', (e) => { e.stopPropagation(); this.toggleMoreMenu(); });
    $('#save-status').addEventListener('click', () => { if (this.sync.status === 'needs-permission') this.sync.resolvePermission(); else if (this.sync.status === 'error') { this.ann.dirty = true; this.sync.run({ force: true }); } });
  }

  applyTapMode() { $('#btn-tap-mode').classList.toggle('active', this.tapMode); this.container.classList.toggle('tap-mode', this.tapMode); }
  applyNight(on) { this.container.classList.toggle('night', !!on); }
  updateZoomSelect() {
    const sel = $('#zoom-select');
    const mode = this.viewer.zoomMode;
    const custom = sel.querySelector('option[data-custom]');
    if (mode === 'auto' || mode === 'page-fit' || [...sel.options].some(o => o.value === mode && !o.dataset.custom)) { custom?.remove(); sel.value = mode; }
    else {
      const opt = custom || el('option', { dataset: { custom: '1' } });
      opt.value = mode; opt.textContent = `${Math.round(this.viewer.scale * 100)}%`;
      if (!custom) sel.append(opt);
      sel.value = mode;
    }
  }

  renderSaveStatus({ status, message }) {
    const chip = $('#save-status');
    if (!this.book) { chip.hidden = true; return; }
    const linked = !!this.book.source;
    const labels = { clean: linked ? 'Salvo' : '', dirty: 'Não salvo', saving: 'Salvando…', saved: 'Salvo', error: 'Erro ao salvar', 'needs-permission': 'Permitir salvar', offline: 'Sem conexão' };
    const text = labels[status] ?? '';
    chip.hidden = !text;
    chip.className = `save-status ${status}`;
    chip.textContent = text;
    chip.title = message || (linked ? `Anotações gravadas em ${this.book.source.name || 'arquivo vinculado'}` : 'Anotações gravadas na cópia do aplicativo. Use “Baixar PDF com anotações” ou vincule a um arquivo.');
  }

  _bindViewerEvents() {
    this.viewer.addEventListener('pagechange', e => {
      $('#page-input').value = e.detail.page;
      this.markCurrentThumb(e.detail.page);
      this.updateBookmarkButton();
      this.savePosition();
    });
    this.viewer.addEventListener('scalechange', () => { this.updateZoomSelect(); this.savePosition(); this.repositionSelectionUi(); });
    this.viewer.addEventListener('scroll', () => { this.savePosition(); this.repositionSelectionUi(); });
    this.container.addEventListener('scroll', rafThrottle(() => this.repositionSelectionUi()), { passive: true });
    this.viewer.addEventListener('linkclick', async (e) => {
      const { dest, url } = e.detail;
      if (url) { window.open(url, '_blank', 'noopener'); return; }
      const t = await this.viewer.resolveDest(dest);
      if (t) this.jumpTo(t.page, t.yRatio);
    });
  }

  // ---- histórico de navegação
  jumpTo(page, yRatio = 0) {
    const pos = this.viewer.getPosition();
    if (pos.page !== Math.round(page)) {
      this.history.push(pos);
      if (this.history.length > 50) this.history.shift();
      $('#btn-hist-back').hidden = false;
    }
    this.viewer.goTo(page, yRatio);
  }
  historyBack() {
    const pos = this.history.pop();
    if (!pos) return;
    this.viewer.goTo(pos.page, pos.yRatio);
    $('#btn-hist-back').hidden = !this.history.length;
  }

  // ---- marcadores
  get bookmarks() { return this.book?.bookmarks || []; }
  async toggleBookmark() {
    const page = this.viewer.currentPage;
    const list = this.bookmarks;
    const i = list.findIndex(b => b.page === page);
    if (i >= 0) { list.splice(i, 1); toast('Marcador removido.'); }
    else {
      let label = '';
      try { const { text } = await this.viewer.getPageText(page); label = normalizeText(text).slice(0, 60); } catch { /* ignore */ }
      list.push({ page, label, createdAt: Date.now() });
      list.sort((a, b) => a.page - b.page);
      toast(`Página ${page} marcada.`);
    }
    this.book.bookmarks = list;
    await this.app.library.updateBook(this.book);
    this.updateBookmarkButton();
    this.renderBookmarks();
  }
  updateBookmarkButton() { $('#btn-bookmark').classList.toggle('active', this.bookmarks.some(b => b.page === this.viewer.currentPage)); }
  renderBookmarks() {
    const wrap = $('#bookmarks');
    this.updateBookmarkButton();
    if (!this.bookmarks.length) { wrap.replaceChildren(); return; }
    wrap.replaceChildren(el('div', { class: 'bm-list' }, el('div', { class: 'menu-section' }, 'Marcadores'),
      ...this.bookmarks.map(b => el('button', { class: 'outline-item', onclick: () => { this.jumpTo(b.page); if (window.innerWidth <= 860) this.toggleSidebar(false); } },
        icon('bookmark'), el('span', { text: `Pág. ${b.page}` }), el('span', { class: 'muted', style: { fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: b.label ? ` · ${b.label}` : '' }),
        el('span', { class: 'btn icon ghost del', title: 'Remover', onclick: async (e) => { e.stopPropagation(); this.book.bookmarks = this.bookmarks.filter(x => x !== b); await this.app.library.updateBook(this.book); this.renderBookmarks(); } }, icon('close'))))));
  }

  // =============================================================== menu "mais"
  _bindMoreMenu() {
    const menu = $('#more-menu');
    menu.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-more]');
      if (!btn) return;
      const act = btn.dataset.more;
      if (act !== 'crop' && act !== 'night' && act !== 'scroll' && act !== 'paged') this.toggleMoreMenu(false);
      switch (act) {
        case 'scroll': case 'paged': this.viewer.setPageMode(act); this.updateMoreMenu(); this.savePosition(); break;
        case 'crop': await this.viewer.setCropMargins(!this.viewer.cropMargins); this.updateMoreMenu(); this.savePosition(); break;
        case 'rotate': this.viewer.setRotation(this.viewer.rotation + 90); this.savePosition(); break;
        case 'night': { const n = !settings().night; await saveSettings({ night: n }); this.applyNight(n); this.updateMoreMenu(); break; }
        case 'tts': this.startTts(); break;
        case 'fullscreen': this.toggleFullscreen(); break;
        case 'download': await this.downloadPdf(); break;
        case 'link-file': { const ok = await this.app.library.saveAs(this.book); if (ok) { this.ann.dirty = true; this.sync.run({ force: true }); } break; }
        case 'reimport': { const n = await this.ann.importFromPdf(); toast(n ? `${n} anotação(ões) importada(s) do PDF.` : 'Nenhuma anotação nova no PDF.'); break; }
        case 'settings': this.app.openSettings(); break;
      }
    });
    document.addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target) && !$('#btn-more').contains(e.target)) this.toggleMoreMenu(false); });
  }
  toggleMoreMenu(force) {
    const menu = $('#more-menu');
    const open = force ?? menu.hidden;
    menu.hidden = !open;
    if (open) {
      this.updateMoreMenu();
      const r = $('#btn-more').getBoundingClientRect();
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.left = `${Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
    }
  }
  updateMoreMenu() {
    const menu = $('#more-menu');
    $('[data-more="scroll"]', menu).classList.toggle('active', this.viewer.pageMode === 'scroll');
    $('[data-more="paged"]', menu).classList.toggle('active', this.viewer.pageMode === 'paged');
    $('[data-more="crop"]', menu).classList.toggle('on', this.viewer.cropMargins);
    $('[data-more="night"]', menu).classList.toggle('on', !!settings().night);
  }
  toggleFullscreen() { if (document.fullscreenElement) document.exitFullscreen(); else (this.el.requestFullscreen || document.documentElement.requestFullscreen)?.call(this.el).catch?.(() => toast('Tela cheia não disponível neste navegador.')); }
  async downloadPdf() {
    toast('Gravando anotações no PDF…', 4000);
    await this.sync.flush();
    await this.app.library.exportFile(this.book);
  }

  // ---- tela imersiva
  _bindImmersive() {
    document.addEventListener('fullscreenchange', () => {
      const on = !!document.fullscreenElement;
      this.el.classList.toggle('immersive', on);
      this.el.classList.toggle('show-ui', false);
      setTimeout(() => this.layoutChanged(), 150);
    });
    let hideTimer;
    const showUi = () => { this.el.classList.add('show-ui'); clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!$('#toolbar').matches(':hover')) this.el.classList.remove('show-ui'); }, 2500); };
    document.addEventListener('mousemove', (e) => { if (this.el.classList.contains('immersive') && e.clientY < 10) showUi(); });
    this._immersiveTap = () => { if (!this.el.classList.contains('immersive')) return false; if (this.el.classList.contains('show-ui')) this.el.classList.remove('show-ui'); else showUi(); return true; };
  }

  // =============================================================== caneta
  _bindInkBar() {
    const bar = $('#ink-bar');
    bar.addEventListener('click', (e) => {
      const sw = e.target.closest('[data-ink-color]');
      const wb = e.target.closest('[data-ink-width]');
      if (sw) { this.ink.color = sw.dataset.inkColor; $$('[data-ink-color]', bar).forEach(x => x.classList.toggle('active', x === sw)); this.ink.eraser = false; $('#btn-eraser').classList.remove('active'); }
      if (wb) { this.ink.width = wb.dataset.inkWidth; $$('[data-ink-width]', bar).forEach(x => x.classList.toggle('active', x === wb)); }
    });
    $('#btn-eraser').addEventListener('click', () => { this.ink.eraser = !this.ink.eraser; $('#btn-eraser').classList.toggle('active', this.ink.eraser); });
    $('#btn-pen-only').addEventListener('click', () => { this.ink.penOnly = !this.ink.penOnly; $('#btn-pen-only').classList.toggle('active', this.ink.penOnly); });
    $('#btn-ink-done').addEventListener('click', () => this.setInk(false));
  }
  setInk(on) {
    this.ink.setActive(on);
    $('#btn-ink').classList.toggle('active', on);
    $('#ink-bar').hidden = !on;
    if (on) { this.clearSelectionUi(); window.getSelection()?.removeAllRanges(); }
    this.layoutChanged();
  }

  // =============================================================== leitura em voz alta
  _bindTts() {
    $('#tts-play').addEventListener('click', () => {
      if (!this.tts.active) return;
      if (speechSynthesis.paused || this.tts.paused) { speechSynthesis.resume(); this.tts.paused = false; }
      else { speechSynthesis.pause(); this.tts.paused = true; }
      this.updateTtsBar();
    });
    $('#tts-stop').addEventListener('click', () => this.stopTts());
    $('#tts-rate').addEventListener('change', () => { if (this.tts.active) { const { page, index } = this.tts; speechSynthesis.cancel(); this.tts.index = index; this.speakCurrent(); } });
  }
  async startTts(page = this.viewer.currentPage) {
    if (!('speechSynthesis' in window)) { toast('Leitura em voz alta não disponível neste navegador.'); return; }
    speechSynthesis.cancel();
    this.tts.active = true; this.tts.paused = false; this.tts.page = page; this.tts.index = 0;
    $('#tts-bar').hidden = false; this.layoutChanged();
    $('#tts-status').textContent = `Preparando a página ${page}…`;
    this.tts.paras = await this.viewer.getParagraphs(page);
    if (!this.tts.active) return;
    if (!this.tts.paras.length) { $('#tts-status').textContent = `Página ${page} sem texto.`; return this.ttsNextPage(); }
    if (!this.tts.lang) {
      const s = settings();
      if (s.sl !== 'auto') this.tts.lang = s.sl;
      else { try { this.tts.lang = (await translate(this.tts.paras[0].slice(0, 200), { sl: 'auto', tl: s.tl })).src || 'en'; } catch { this.tts.lang = 'en'; } }
    }
    this.speakCurrent();
  }
  speakCurrent() {
    const t = this.tts;
    if (!t.active) return;
    if (t.index >= t.paras.length) return this.ttsNextPage();
    const text = t.paras[t.index];
    $('#tts-status').textContent = `Página ${t.page} · parágrafo ${t.index + 1}/${t.paras.length}`;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langToBcp47(t.lang || 'en');
    u.rate = parseFloat($('#tts-rate').value) || 1;
    u.onend = () => { if (t.active && t.utter === u) { t.index++; this.speakCurrent(); } };
    u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') { toast('Falha na síntese de voz.'); this.stopTts(); } };
    t.utter = u;
    speechSynthesis.speak(u);
    this.updateTtsBar();
  }
  ttsNextPage() {
    const t = this.tts;
    if (t.page >= this.viewer.numPages) { toast('Fim do documento.'); return this.stopTts(); }
    this.viewer.goTo(t.page + 1);
    this.startTts(t.page + 1);
  }
  stopTts() {
    if (!this.tts.active && $('#tts-bar').hidden) return;
    this.tts.active = false; this.tts.utter = null;
    try { speechSynthesis.cancel(); } catch { /* ignore */ }
    $('#tts-bar').hidden = true;
    this.layoutChanged();
  }
  updateTtsBar() { $('#tts-play use').setAttribute('href', this.tts.paused ? '#i-play' : '#i-pause'); }

  // =============================================================== painel lateral
  toggleSidebar(force) {
    const open = force ?? this.sidebar.hidden;
    this.sidebar.hidden = !open;
    saveSettings({ sidebarOpen: open });
    this.layoutChanged();
  }
  showSidebar(tab) { if (this.sidebar.hidden) this.toggleSidebar(true); if (tab) this.selectTab(tab); }
  selectTab(name) {
    $$('.tab', this.sidebar).forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel', this.sidebar).forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    if (name === 'thumbs') this.markCurrentThumb(this.viewer.currentPage, true);
  }

  _bindSidebar() {
    $$('.tab', this.sidebar).forEach(t => t.addEventListener('click', () => this.selectTab(t.dataset.tab)));
    this.container.addEventListener('pointerdown', () => { if (window.innerWidth <= 860 && !this.sidebar.hidden) this.toggleSidebar(false); });
    $('#btn-export-annots').addEventListener('click', () => {
      if (!this.ann.items.length) { toast('Nenhuma anotação para exportar.'); return; }
      downloadText(`${safeName(this.book.title)} - anotações.md`, this.ann.toMarkdown(this.book.title), 'text/markdown');
    });
    $('#btn-export-vocab').addEventListener('click', async () => {
      const items = await listVocab();
      if (!items.length) { toast('Nenhuma palavra salva.'); return; }
      downloadText('vocabulario.csv', vocabToCsv(items), 'text/csv');
    });
    $('#btn-vocab-review').addEventListener('click', () => this.startReview());
    $('#search-form').addEventListener('submit', e => { e.preventDefault(); this.runSearch($('#search-input').value); });
    $('#btn-translate-page').addEventListener('click', () => this.translatePage());
  }

  buildThumbs() {
    const wrap = $('#thumbs');
    this.thumbObserver?.disconnect();
    const frag = document.createDocumentFragment();
    const ratio = this.viewer.defaultBase0 ? this.viewer.defaultBase0.width / this.viewer.defaultBase0.height : 0.707;
    for (let n = 1; n <= this.viewer.numPages; n++) {
      frag.append(el('div', { class: 'thumb', dataset: { page: n }, style: { '--ratio': ratio }, onclick: () => { this.jumpTo(n); if (window.innerWidth <= 860) this.toggleSidebar(false); } },
        el('div', { class: 'thumb-img' }), el('div', { text: n })));
    }
    wrap.replaceChildren(frag);
    this.thumbObserver = new IntersectionObserver(entries => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const t = en.target; this.thumbObserver.unobserve(t);
        const n = parseInt(t.dataset.page, 10);
        const canvas = el('canvas');
        this.viewer.renderThumbnail(n, canvas, 120).then(r => { t.style.setProperty('--ratio', r); $('.thumb-img', t).replaceChildren(canvas); }).catch(() => {});
      }
    }, { root: wrap, rootMargin: '200px' });
    $$('.thumb', wrap).forEach(t => this.thumbObserver.observe(t));
    this.markCurrentThumb(this.viewer.currentPage, true);
  }
  markCurrentThumb(page, scroll = false) {
    const wrap = $('#thumbs');
    wrap.querySelector('.thumb.current')?.classList.remove('current');
    const t = wrap.querySelector(`.thumb[data-page="${page}"]`);
    if (t) { t.classList.add('current'); if (scroll && !this.sidebar.hidden) t.scrollIntoView({ block: 'nearest' }); }
  }

  async buildOutline() {
    const wrap = $('#outline');
    const items = await this.viewer.getOutline();
    if (!items.length) { wrap.replaceChildren(el('p', { class: 'muted pad', text: 'Este documento não tem sumário.' })); return; }
    const build = (list, depth) => el('div', { class: depth ? 'outline-children' : '' }, list.map(it => [
      el('button', { class: 'outline-item', text: it.title || '(sem título)', onclick: async () => { const t = it.url ? null : await this.viewer.resolveDest(it.dest); if (t) { this.jumpTo(t.page, t.yRatio); if (window.innerWidth <= 860) this.toggleSidebar(false); } else if (it.url) window.open(it.url, '_blank', 'noopener'); } }),
      it.items?.length && depth < 4 ? build(it.items, depth + 1) : null,
    ]));
    wrap.replaceChildren(el('div', { class: 'menu-section' }, 'Sumário'), build(items, 0));
  }

  // ---- anotações
  renderAnnotList() {
    const list = $('#annots-list');
    const items = this.ann.items;
    $('#annots-count').textContent = `${items.length} ${items.length === 1 ? 'anotação' : 'anotações'}`;
    if (!items.length) { list.replaceChildren(el('p', { class: 'muted pad', text: 'Selecione um trecho do texto e escolha uma cor para destacar, ou use a caneta. Tudo é gravado dentro do PDF.' })); return; }
    list.replaceChildren(...items.map(a => el('div', { class: 'list-item', onclick: () => this.goToAnnotation(a) },
      el('div', { class: 'li-head' }, el('span', { class: `dot ${a.type === 'underline' || a.type === 'strikeout' ? 'underline' : a.type === 'ink' ? 'ink' : a.color}` }), `Pág. ${a.page}`, a.type === 'ink' ? '· caneta' : '', a.source === 'pdf' && a.author ? el('span', { class: 'muted', text: `· ${a.author}` }) : null,
        el('div', { class: 'li-actions' },
          a.text ? el('button', { class: 'btn icon ghost', title: 'Traduzir', onclick: (e) => { e.stopPropagation(); this.panel.show({ text: a.text, page: a.page, annId: a.id }); } }, icon('translate')) : null,
          el('button', { class: 'btn icon ghost', title: a.note ? 'Editar nota' : 'Adicionar nota', onclick: (e) => { e.stopPropagation(); this.editNote(a); } }, icon('note')),
          el('button', { class: 'btn icon ghost danger', title: 'Excluir', onclick: async (e) => { e.stopPropagation(); await this.ann.remove(a.id); } }, icon('trash')))),
      a.text ? el('div', { class: 'li-text', text: a.text.length > 220 ? `${a.text.slice(0, 220)}…` : a.text }) : null,
      a.note ? el('div', { class: 'li-note', text: a.note }) : null,
    )));
  }
  annRect(a) {
    if (a.type === 'ink') { const p = a.paths[0] || []; const xs = [], ys = []; for (let i = 0; i < p.length; i += 2) { xs.push(p[i]); ys.push(p[i + 1]); } return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null; }
    return a.rects[0] || null;
  }
  goToAnnotation(a) {
    this.jumpTo(a.page, this.viewer.yRatioOf(a.page, this.annRect(a)));
    setTimeout(() => this.ann.flash(a.id), 350);
    if (window.innerWidth <= 860) this.toggleSidebar(false);
  }

  async editNote(a) {
    const dlg = $('#note-dialog');
    $('#note-excerpt').textContent = a.text || (a.type === 'ink' ? 'Traço de caneta' : '');
    const ta = $('#note-text'); ta.value = a.note || '';
    const result = await new Promise(res => { const h = () => { dlg.removeEventListener('close', h); res(dlg.returnValue); }; dlg.addEventListener('close', h); dlg.showModal(); ta.focus(); });
    if (result === 'ok') { await this.ann.update(a.id, { note: ta.value.trim(), modified: true }); toast('Anotação salva.'); return true; }
    return false;
  }

  async saveAiAsNote(cur, text) {
    const sel = window.getSelection();
    let ann = null;
    if (cur.annId) ann = this.ann.get(cur.annId);
    if (!ann && sel && !sel.isCollapsed && this.selectionInViewer(sel)) { const created = await this.ann.addFromSelection(sel, { type: 'highlight', color: this.lastColor }); ann = created[0]; }
    if (!ann) ann = this.ann.items.find(a => a.page === cur.page && a.text === cur.text);
    if (!ann) { toast('Selecione o trecho novamente para anexar a explicação como anotação.'); return; }
    await this.ann.update(ann.id, { note: (ann.note ? `${ann.note}\n\n` : '') + stripMd(text), modified: true });
    toast('Explicação salva como anotação (e no PDF).');
  }

  // ---- vocabulário
  async refreshVocab() {
    this.vocabItems = await listVocab(this.book?.id);
    const list = $('#vocab-list');
    $('#vocab-count').textContent = `${this.vocabItems.length} ${this.vocabItems.length === 1 ? 'palavra' : 'palavras'}`;
    if (!this.vocabItems.length) { list.replaceChildren(el('p', { class: 'muted pad', text: 'Ao traduzir uma palavra, use “Salvar no vocabulário” para montar sua lista de estudo.' })); return; }
    list.replaceChildren(...this.vocabItems.map(v => el('div', { class: 'list-item', onclick: () => { if (v.page) this.jumpTo(v.page); this.panel.show({ text: v.word, page: v.page || this.viewer.currentPage }); } },
      el('div', { class: 'li-head' }, el('strong', { style: { color: 'var(--text)', fontSize: '14px' }, text: v.word }), v.page ? `pág. ${v.page}` : '',
        el('div', { class: 'li-actions' },
          el('button', { class: 'btn icon ghost', title: 'Ouvir', onclick: (e) => { e.stopPropagation(); speak(v.word, v.sl || 'en'); } }, icon('speaker')),
          el('button', { class: 'btn icon ghost danger', title: 'Remover', onclick: async (e) => { e.stopPropagation(); await removeVocab(v.id); this.refreshVocab(); } }, icon('trash')))),
      el('div', { class: 'li-text', text: v.translation || '' }),
      v.context ? el('div', { class: 'muted', style: { fontSize: '12.5px', fontStyle: 'italic' }, text: v.context.length > 160 ? `${v.context.slice(0, 160)}…` : v.context }) : null,
    )));
  }
  async saveSelectionToVocab(cur) {
    if (!cur?.text) return;
    const s = settings();
    let translation = cur.translation;
    if (!translation) { try { translation = (await translate(cur.text, { sl: s.sl, tl: s.tl })).text; } catch { translation = ''; } }
    let context = cur.context || '';
    if (!context && cur.page) { const c = await this.getSentenceContext(cur.page, cur.text).catch(() => null); context = c?.sentence || ''; }
    const { created } = await saveVocab({ bookId: this.book.id, bookTitle: this.book.title, word: cur.text, translation, context, sl: cur.src || s.sl, tl: s.tl, page: cur.page });
    toast(created ? `“${cur.text}” salvo no vocabulário.` : `“${cur.text}” atualizado no vocabulário.`);
    this.refreshVocab();
  }
  async startReview() {
    const items = (await listVocab(this.book?.id)).filter(v => v.translation);
    if (!items.length) { toast('Salve algumas palavras antes de revisar.'); return; }
    const deck = items.sort(() => Math.random() - 0.5).slice(0, 30);
    const dlg = $('#review-dialog'), body = $('#review-body'), prog = $('#review-progress');
    let i = 0, flipped = false;
    const render = () => {
      const v = deck[i];
      prog.textContent = `${i + 1} / ${deck.length}`;
      body.replaceChildren(el('div', { class: 'flashcard', onclick: flip },
        el('div', { class: 'fc-word', text: v.word }),
        flipped ? el('div', { class: 'fc-trans', text: v.translation }) : el('div', { class: 'muted', text: 'Toque para ver a tradução' }),
        flipped && v.context ? el('div', { class: 'fc-ctx', text: v.context }) : null));
    };
    const flip = () => { flipped = !flipped; render(); };
    const next = async () => {
      const v = deck[i]; v.reviews = (v.reviews || 0) + 1; v.lastReview = Date.now(); await updateVocab(v);
      i++; flipped = false;
      if (i >= deck.length) { dlg.close(); toast('Revisão concluída!'); return; }
      render();
    };
    $('#review-flip').onclick = flip; $('#review-next').onclick = next;
    render();
    dlg.showModal();
  }

  // ---- busca
  async runSearch(q) {
    const status = $('#search-status'), list = $('#search-results');
    this.searchAbort?.abort();
    if (!q.trim()) { list.replaceChildren(); status.textContent = ''; return; }
    const ctrl = new AbortController(); this.searchAbort = ctrl;
    list.replaceChildren(); status.textContent = 'Buscando…';
    try {
      const results = await this.viewer.search(q, (n, total, count) => { if (!ctrl.signal.aborted) status.textContent = `Página ${n}/${total} · ${count} resultado(s)`; }, ctrl.signal);
      if (ctrl.signal.aborted) return;
      status.textContent = results.length ? `${results.length} resultado(s)${results.length >= 500 ? ' (limitado)' : ''}` : 'Nenhum resultado.';
      list.replaceChildren(...results.map(r => el('div', { class: 'list-item', onclick: () => {
        const rects = this.viewer.rectsForTextRange(r.page, r.start, r.end);
        this.jumpTo(r.page, this.viewer.yRatioOf(r.page, rects[0], 100));
        this.viewer.flashRange(r.page, r.start, r.end);
        if (window.innerWidth <= 860) this.toggleSidebar(false);
      } },
        el('div', { class: 'li-head', text: `Pág. ${r.page}` }),
        el('div', { class: 'li-text', html: `…${escapeHtml(r.before)}<mark>${escapeHtml(r.match)}</mark>${escapeHtml(r.after)}…` }))));
    } catch (err) { if (err?.name !== 'AbortError') status.textContent = `Erro: ${err.message}`; }
  }

  // ---- tradução da página
  async translatePage() {
    const page = this.viewer.currentPage;
    const list = $('#pagetr-list');
    const s = settings();
    list.replaceChildren(el('p', { class: 'muted pad', text: `Extraindo o texto da página ${page}…` }));
    const paras = await this.viewer.getParagraphs(page);
    if (!paras.length) { list.replaceChildren(el('p', { class: 'muted pad', text: 'Esta página não tem texto selecionável (pode ser uma imagem digitalizada).' })); return; }
    const rows = paras.map(p => el('div', { class: 'pagetr-item' }, el('div', { class: 'orig', text: p }), el('div', { class: 'trans' }, el('span', { class: 'spinner inline-spinner' }))));
    list.replaceChildren(el('p', { class: 'muted pad', text: `Página ${page} · ${paras.length} parágrafo(s)` }), ...rows);
    let idx = 0;
    const worker = async () => {
      while (idx < paras.length) {
        const i = idx++;
        try { const r = await translate(paras[i], { sl: s.sl, tl: s.tl }); $('.trans', rows[i]).textContent = r.text; }
        catch (err) { $('.trans', rows[i]).textContent = `Falha: ${err.message}`; }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  // =============================================================== seleção de texto
  _bindSelection() {
    const onSelChange = debounce(() => this.onSelectionChange(), isCoarsePointer() ? 350 : 120);
    document.addEventListener('selectionchange', onSelChange);
    this.container.addEventListener('pointerdown', e => {
      const tl = e.target.closest?.('.textLayer');
      if (tl) tl.classList.add('selecting');
      if (!this.selToolbar.contains(e.target)) this.hideSelToolbar();
      if (!this.wordPopup.contains(e.target)) this.hideWordPopup();
      if (!this.annMenu.contains(e.target)) this.annMenu.hidden = true;
    });
    document.addEventListener('pointerup', () => $$('.textLayer.selecting').forEach(t => t.classList.remove('selecting')));
    this.container.addEventListener('click', e => this.onViewerClick(e));

    this.selToolbar.addEventListener('click', e => {
      const sw = e.target.closest('.swatch');
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (sw) this.highlightSelection('highlight', sw.dataset.color);
      else if (act) this.selectionAction(act);
    });
    this.annMenu.addEventListener('click', e => {
      const id = this.annMenu.dataset.id;
      const a = this.ann.get(id);
      if (!a) return;
      const sw = e.target.closest('.swatch');
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (sw) { this.ann.update(id, { color: sw.dataset.color, modified: true }); this.lastColor = sw.dataset.color; }
      else if (act === 'note') { this.annMenu.hidden = true; this.editNote(a); }
      else if (act === 'translate') { this.annMenu.hidden = true; if (a.text) this.panel.show({ text: a.text, page: a.page, annId: a.id }); }
      else if (act === 'copy') { copyText(a.text || ''); toast('Texto copiado.'); this.annMenu.hidden = true; }
      else if (act === 'delete') { this.ann.remove(id); this.annMenu.hidden = true; }
    });
    window.addEventListener('resize', () => this.repositionSelectionUi());
  }

  selectionInViewer(sel) {
    if (!sel.rangeCount) return false;
    const n = sel.getRangeAt(0).commonAncestorContainer;
    return this.container.contains(n.nodeType === 1 ? n : n.parentNode);
  }
  getSelectedText() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !this.selectionInViewer(sel)) return '';
    return normalizeText(sel.toString());
  }
  selectionPage() {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return this.viewer.currentPage;
    const n = sel.getRangeAt(0).startContainer;
    const div = (n.nodeType === 1 ? n : n.parentElement)?.closest('.page');
    return div ? parseInt(div.dataset.page, 10) : this.viewer.currentPage;
  }
  onSelectionChange() {
    const sel = window.getSelection();
    const text = this.getSelectedText();
    if (!text) { this.hideSelToolbar(); this.hideWordPopup(); return; }
    if (text.length > 20000) return;
    this.showSelToolbar(sel);
    if (settings().autoPopup) this.showWordPopup(text, sel);
  }
  showSelToolbar(sel) {
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const r = rects.length ? rects[0] : range.getBoundingClientRect();
    const last = rects.length ? rects[rects.length - 1] : r;
    this.selToolbar.hidden = false;
    this.selAnchor = { top: r.top, left: r.left, bottom: last.bottom, right: last.right, bbox: range.getBoundingClientRect() };
    this.positionSelToolbar();
  }
  positionSelToolbar() {
    if (this.selToolbar.hidden || !this.selAnchor) return;
    const a = this.selAnchor;
    const tw = this.selToolbar.offsetWidth, th = this.selToolbar.offsetHeight;
    const cr = this.container.getBoundingClientRect();
    let top = a.top - th - 10;
    if (top < cr.top + 4) top = a.bottom + 10;
    const cx = a.bbox.left + a.bbox.width / 2;
    this.selToolbar.style.top = `${clamp(top, 4, window.innerHeight - th - 4)}px`;
    this.selToolbar.style.left = `${clamp(cx - tw / 2, 8, window.innerWidth - tw - 8)}px`;
  }
  hideSelToolbar() { this.selToolbar.hidden = true; this.selAnchor = null; }
  hideWordPopup() { this.wordPopup.hidden = true; this.popupAbort?.abort(); }
  clearSelectionUi() { this.hideSelToolbar(); this.hideWordPopup(); this.annMenu.hidden = true; }
  repositionSelectionUi() {
    const sel = window.getSelection();
    if (!this.selToolbar.hidden || !this.wordPopup.hidden) {
      if (!sel || sel.isCollapsed || !this.selectionInViewer(sel)) { this.hideSelToolbar(); this.hideWordPopup(); return; }
      this.showSelToolbar(sel);
      this.positionWordPopup();
    }
  }

  async showWordPopup(text, sel) {
    const s = settings();
    this.popupAbort?.abort();
    const ctrl = new AbortController(); this.popupAbort = ctrl;
    const page = this.selectionPage();
    const popup = this.wordPopup;
    const single = isSingleWord(text);
    popup.replaceChildren(
      el('div', { class: 'wp-word' }, el('span', { text: text.length > 60 ? `${text.slice(0, 60)}…` : text })),
      el('div', { class: 'wp-trans' }, el('span', { class: 'spinner inline-spinner' })));
    popup.hidden = false;
    this.positionWordPopup();
    try {
      const r = await translate(text, { sl: s.sl, tl: s.tl, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      this.lastQuick = { text, page, translation: r.text, src: r.src };
      const trans = r.text.length > 420 ? `${r.text.slice(0, 420)}…` : r.text;
      const alts = (r.dict?.[0]?.terms || r.alternatives || []).filter(t => t.toLowerCase() !== r.text.toLowerCase()).slice(0, 4);
      popup.replaceChildren(
        el('div', { class: 'wp-word' }, el('span', { text: text.length > 60 ? `${text.slice(0, 60)}…` : text }),
          single ? el('button', { class: 'btn icon ghost', style: { width: '26px', minHeight: '26px' }, title: 'Ouvir', onclick: () => speak(text, r.src || 'en') }, icon('speaker')) : null,
          el('span', { class: 'lang-badge', text: `${r.src || '?'} → ${s.tl}` })),
        el('div', { class: 'wp-trans', text: trans }),
        alts.length ? el('div', { class: 'wp-alt', text: alts.join(' · ') }) : null,
        el('div', { class: 'wp-actions' },
          el('button', { class: 'btn ghost', title: 'Salvar no vocabulário', onclick: () => this.saveSelectionToVocab(this.lastQuick) }, icon('star'), 'Salvar'),
          el('button', { class: 'btn ghost', title: 'Explicar no contexto (IA)', onclick: () => { this.hideWordPopup(); this.panel.show({ text, page, mode: 'ai' }); } }, icon('sparkle'), 'Contexto'),
          el('button', { class: 'btn primary', onclick: () => { this.hideWordPopup(); this.panel.show({ text, page }); } }, 'Mais')));
      this.positionWordPopup();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      popup.replaceChildren(el('div', { class: 'wp-alt', text: `Sem conexão com o tradutor: ${err.message}` }));
    }
  }
  positionWordPopup() {
    if (this.wordPopup.hidden) return;
    const sel = window.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    const bbox = range.getBoundingClientRect();
    const last = rects.length ? rects[rects.length - 1] : bbox;
    const pw = this.wordPopup.offsetWidth, ph = this.wordPopup.offsetHeight;
    let top = last.bottom + 8;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, bbox.top - ph - (this.selToolbar.hidden ? 8 : this.selToolbar.offsetHeight + 16));
    this.wordPopup.style.top = `${top}px`;
    this.wordPopup.style.left = `${clamp(bbox.left + bbox.width / 2 - pw / 2, 8, window.innerWidth - pw - 8)}px`;
  }

  async highlightSelection(type, color) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    this.lastColor = color || this.lastColor;
    const created = await this.ann.addFromSelection(sel, { type, color: this.lastColor });
    if (created.length) { sel.removeAllRanges(); this.clearSelectionUi(); }
    return created;
  }
  async selectionAction(act) {
    const text = this.getSelectedText();
    const page = this.selectionPage();
    if (!text) return;
    switch (act) {
      case 'underline': return this.highlightSelection('underline', this.lastColor);
      case 'strikeout': return this.highlightSelection('strikeout', this.lastColor);
      case 'note': {
        const created = await this.highlightSelection('highlight', this.lastColor);
        if (created?.[0]) { const ok = await this.editNote(created[0]); if (!ok) await this.ann.remove(created[0].id); }
        return;
      }
      case 'translate': return this.translateSelection('quick');
      case 'context': return this.translateSelection('ai');
      case 'vocab': return this.saveSelectionToVocab(this.lastQuick?.text === text ? this.lastQuick : { text, page });
      case 'speak': return speak(text, this.lastQuick?.text === text ? this.lastQuick.src : (settings().sl !== 'auto' ? settings().sl : 'en'));
      case 'copy': { await copyText(text); toast('Texto copiado.'); return; }
    }
  }
  translateSelection(mode) {
    const text = this.getSelectedText();
    if (!text) { this.panel.toggle(); return; }
    this.hideWordPopup();
    this.panel.show({ text, page: this.selectionPage(), mode });
  }

  onViewerClick(e) {
    if (this.ink.active) return;
    const pin = e.target.closest('.note-pin');
    if (pin) { const a = this.ann.get(pin.dataset.id); if (a) this.editNote(a); return; }
    if (e.target.closest('.pdf-link')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const pageDiv = e.target.closest('.page');
    if (!pageDiv) return;
    const page = parseInt(pageDiv.dataset.page, 10);
    const { x, y } = this.viewer.clientToPdf(page, e.clientX, e.clientY);
    const hit = this.ann.hitTest(page, x, y);
    if (hit) { this.showAnnMenu(hit, e.clientX, e.clientY); return; }
    if (this.tapMode && e.target.closest('.textLayer')) { this.selectWordAt(e.clientX, e.clientY); return; }
    // modo página a página: toque nas bordas vira a página
    if (this.viewer.pageMode === 'paged' && settings().tapZones !== false) {
      const r = this.container.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      if (fx < 0.18) { this.viewer.prevPage(); return; }
      if (fx > 0.82) { this.viewer.nextPage(); return; }
    }
    this._immersiveTap?.();
  }
  showAnnMenu(a, cx, cy) {
    this.annMenu.dataset.id = a.id;
    $('.swatches', this.annMenu).hidden = a.type === 'ink';
    $('[data-act="translate"]', this.annMenu).hidden = !a.text;
    this.annMenu.hidden = false;
    const w = this.annMenu.offsetWidth, h = this.annMenu.offsetHeight;
    this.annMenu.style.left = `${clamp(cx - w / 2, 8, window.innerWidth - w - 8)}px`;
    this.annMenu.style.top = `${clamp(cy - h - 14, 8, window.innerHeight - h - 8)}px`;
  }
  selectWordAt(x, y) {
    let node, offset;
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (!p) return; node = p.offsetNode; offset = p.offset; }
    else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (!r) return; node = r.startContainer; offset = r.startOffset; }
    if (!node || node.nodeType !== 3) return;
    const t = node.textContent;
    const isWord = (ch) => /[\p{L}\p{M}\d'’-]/u.test(ch);
    let s = offset, e = offset;
    while (s > 0 && isWord(t[s - 1])) s--;
    while (e < t.length && isWord(t[e])) e++;
    if (e <= s) return;
    const range = document.createRange();
    range.setStart(node, s); range.setEnd(node, e);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    const text = normalizeText(range.toString());
    if (!text) return;
    this.showSelToolbar(sel);
    this.showWordPopup(text, sel);
  }

  async getSentenceContext(page, selText) {
    const { text } = await this.viewer.getPageText(page);
    const norm = normalizeText(text);
    const needle = normalizeText(selText);
    if (!needle) return null;
    let idx = norm.indexOf(needle), len = needle.length;
    if (idx < 0) idx = norm.toLowerCase().indexOf(needle.toLowerCase());
    if (idx < 0) { const head = needle.slice(0, Math.min(40, needle.length)); idx = norm.indexOf(head); len = head.length; if (idx < 0) return null; }
    const endSel = idx + len;
    const re = /[.!?…]+["”’)\]]*\s+(?=[A-ZÀ-Ý“"(\d])/g;
    let start = 0, m;
    while ((m = re.exec(norm)) && m.index < idx) start = m.index + m[0].length;
    re.lastIndex = Math.max(endSel - 1, 0);
    m = re.exec(norm);
    const end = m ? m.index + m[0].length - 1 : norm.length;
    const sentence = norm.slice(start, end).trim();
    const pStart = Math.max(0, start - 500), pEnd = Math.min(norm.length, end + 500);
    let paragraph = norm.slice(pStart, pEnd);
    if (pStart > 0) paragraph = `…${paragraph.replace(/^\S*\s/, '')}`;
    if (pEnd < norm.length) paragraph = `${paragraph.replace(/\s\S*$/, '')}…`;
    return { sentence, selStart: idx - start, selEnd: endSel - start, paragraph };
  }

  // =============================================================== teclado
  _bindKeyboard() {
    document.addEventListener('keydown', e => {
      if (this.el.hidden) return;
      const tag = e.target.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
      if (document.querySelector('dialog[open]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); this.showSidebar('search'); $('#search-input').focus(); $('#search-input').select(); return; }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); this.historyBack(); return; }
      if (typing) return;
      const v = this.viewer;
      const sel = this.getSelectedText();
      switch (e.key) {
        case 'ArrowRight': case 'PageDown': if (!e.altKey) { e.preventDefault(); v.nextPage(); } break;
        case 'ArrowLeft': case 'PageUp': if (!e.altKey) { e.preventDefault(); v.prevPage(); } break;
        case ' ': if (v.pageMode === 'paged') { e.preventDefault(); e.shiftKey ? v.prevPage() : v.nextPage(); } break;
        case 'Home': if (e.ctrlKey) { e.preventDefault(); this.jumpTo(1); } break;
        case 'End': if (e.ctrlKey) { e.preventDefault(); this.jumpTo(v.numPages); } break;
        case '+': case '=': if (e.ctrlKey || e.metaKey || !sel) { e.preventDefault(); v.zoomStep(1); } break;
        case '-': case '_': if (e.ctrlKey || e.metaKey || !sel) { e.preventDefault(); v.zoomStep(-1); } break;
        case '0': if (e.ctrlKey || e.metaKey) { e.preventDefault(); v.setZoom('auto'); } break;
        case 'Escape':
          if (this.ink.active) this.setInk(false);
          else if (!$('#more-menu').hidden) this.toggleMoreMenu(false);
          else if (!this.panel.el.hidden) this.panel.hide();
          else if (window.getSelection()?.rangeCount) window.getSelection().removeAllRanges();
          this.clearSelectionUi();
          break;
        default: {
          if (e.ctrlKey || e.metaKey || e.altKey) break;
          const k = e.key.toLowerCase();
          if (k === 's') this.toggleSidebar();
          else if (k === 't') { if (sel) this.translateSelection('quick'); else this.panel.toggle(); }
          else if (k === 'c' && sel) this.translateSelection('ai');
          else if (k === 'h' && sel) this.highlightSelection('highlight', this.lastColor);
          else if (k === 'u' && sel) this.highlightSelection('underline', this.lastColor);
          else if (k === 'n') { if (sel) this.selectionAction('note'); else { const n = !settings().night; saveSettings({ night: n }); this.applyNight(n); } }
          else if (k === 'w') $('#btn-tap-mode').click();
          else if (k === 'p') this.setInk(!this.ink.active);
          else if (k === 'b') this.toggleBookmark();
          else if (k === 'f') this.toggleFullscreen();
          else if (k === 'v' && sel) this.selectionAction('vocab');
          else if (/^[1-4]$/.test(k) && sel) this.highlightSelection('highlight', COLORS[parseInt(k, 10) - 1]);
        }
      }
    });
  }
}

const safeName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 80);
const stripMd = (s) => s.replace(/^#{1,6}\s*/gm, '').replace(/\*\*/g, '').replace(/^\s*[-*]\s+/gm, '• ');
