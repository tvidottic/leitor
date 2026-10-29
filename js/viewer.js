// Visualizador de PDF (pdf.js): rolagem contínua virtualizada ou paginada, camada de texto, links,
// rotação, corte de margens, zoom por pinça e conversões entre a tela e o espaço do PDF.

import * as pdfjsLib from './vendor/pdf.min.mjs';
import { el, clamp, debounce, rafThrottle } from './utils.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
export { pdfjsLib };

const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_AUTO_WIDTH = 1200;
const RENDER_CONCURRENCY = 2;
const KEEP_RANGE = 3;
const PAGE_GAP = 14;

export class PdfViewer extends EventTarget {
  constructor(container, viewerEl) {
    super();
    this.container = container;
    this.viewerEl = viewerEl;
    this.pdf = null;
    this.numPages = 0;
    this.pages = [];
    this.tops = [];
    this.scale = 1;
    this.zoomMode = 'auto';
    this.rotation = 0;          // rotação extra (0/90/180/270)
    this.cropMargins = false;   // corta as margens brancas
    this.pageMode = 'scroll';   // 'scroll' | 'paged'
    this.viewLock = true;       // paginado: mantém zoom e enquadramento ao virar a página
    this.spread = 'auto';       // paginado: 'auto' = duas páginas lado a lado quando a tela é larga | 'off'
    this.currentPage = 1;
    this.textCache = new Map();
    this.rendering = 0;
    this.renderQueue = [];
    this.lastWidth = 0;

    this._onScroll = rafThrottle(() => this.update());
    container.addEventListener('scroll', this._onScroll, { passive: true });
    this._ro = new ResizeObserver(debounce(() => this.onResize(), 120));
    this._ro.observe(container);
    this._setupGestures();
  }

  // ------------------------------------------------------------ carregamento
  async load(data, { page = 1, yRatio = 0, zoomMode = 'auto', rotation = 0, cropMargins = false, pageMode = 'scroll' } = {}) {
    await this.closeDocument();
    const task = pdfjsLib.getDocument({ data, isEvalSupported: false, enableXfa: false });
    this.loadingTask = task;
    this.pdf = await task.promise;
    this.numPages = this.pdf.numPages;
    this.rotation = rotation; this.cropMargins = cropMargins; this.pageMode = pageMode;
    this.container.classList.toggle('paged', pageMode === 'paged');
    const first = await this.pdf.getPage(1);
    this.defaultBase0 = first.getViewport({ scale: 1 });

    const frag = document.createDocumentFragment();
    this.pages = [];
    for (let n = 1; n <= this.numPages; n++) {
      const div = el('div', { class: 'page loading', dataset: { page: n }, role: 'region', 'aria-label': `Página ${n}` });
      const annLayer = el('div', { class: 'annotationLayer' });
      const textLayer = el('div', { class: 'textLayer' });
      const linkLayer = el('div', { class: 'linkLayer' });
      const noteLayer = el('div', { class: 'noteLayer' });
      const inkLayer = el('div', { class: 'inkLayer', hidden: true });
      div.append(annLayer, textLayer, linkLayer, noteLayer, inkLayer);
      frag.append(div);
      this.pages.push({ num: n, div, annLayer, textLayerDiv: textLayer, linkLayer, noteLayer, inkLayer, base0: this.defaultBase0, baseKnown: n === 1, cropBox: null, cropKnown: false, rendered: false, rendering: false, canvas: null, renderTask: null, textLayer: null, token: 0 });
    }
    this.viewerEl.replaceChildren(frag);
    this.zoomMode = zoomMode;
    this.currentPage = clamp(Math.round(page) || 1, 1, this.numPages);
    this.computeScale();
    this.layout();
    this.goTo(page, yRatio);
    this.update();
    requestAnimationFrame(() => { if (this.pdf) { this.measure(); this.update(); } });
    this.dispatchEvent(new CustomEvent('loaded', { detail: { numPages: this.numPages } }));
    return this.pdf;
  }

  async closeDocument() {
    for (const p of this.pages) this.cleanupPage(p);
    this.renderQueue = [];
    this.textCache.clear();
    this.viewerEl.replaceChildren();
    this.pages = []; this.tops = [];
    if (this.loadingTask) { try { await this.loadingTask.destroy(); } catch { /* ignore */ } }
    this.loadingTask = null; this.pdf = null; this.numPages = 0;
  }

  destroy() {
    this._ro.disconnect();
    this.container.removeEventListener('scroll', this._onScroll);
    this.closeDocument();
  }

  // ------------------------------------------------------------ geometria
  /** Viewport base (escala 1) da página com a rotação atual. */
  baseOf(p) {
    return this.rotation ? p.base0.clone({ rotation: (p.base0.rotation + this.rotation) % 360 }) : p.base0;
  }
  /** Dimensões de exibição (em px CSS) da página na escala atual, considerando corte de margens. */
  dimsOf(p, scale = this.scale) {
    const vp = this.baseOf(p).clone({ scale });
    let cx = 0, cy = 0, cw = vp.width, ch = vp.height;
    const cb = this.cropMargins ? (p.cropBox || this.defaultCropFor(p)) : null;
    if (cb) {
      const [x1, y1, x2, y2] = vp.convertToViewportRectangle(cb);
      cx = Math.min(x1, x2); cy = Math.min(y1, y2); cw = Math.abs(x2 - x1); ch = Math.abs(y2 - y1);
    }
    return { vp, cx, cy, cw, ch };
  }
  defaultCropFor(p) {
    const ref = this.pages.find(q => q.cropKnown && q.cropBox);
    if (!ref) return null;
    // aplica as mesmas proporções de corte da página de referência
    const rb = ref.base0, pb = p.base0;
    const [x1, y1, x2, y2] = ref.cropBox;
    const sx = pb.width / rb.width, sy = pb.height / rb.height;
    return [x1 * sx, y1 * sy, x2 * sx, y2 * sy];
  }

  /** Retângulo de tela (relativo ao div da página) -> [x1,y1,x2,y2] em espaço PDF. */
  viewRectToPdf(num, r) {
    const p = this.pages[num - 1];
    const { vp, cx, cy } = p.geo || this.dimsOf(p);
    const [x1, y1] = vp.convertToPdfPoint(r.x + cx, r.y + cy);
    const [x2, y2] = vp.convertToPdfPoint(r.x + r.w + cx, r.y + r.h + cy);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)].map(n => Math.round(n * 100) / 100);
  }
  pdfRectToView(num, rect) {
    const p = this.pages[num - 1];
    const { vp, cx, cy } = p.geo || this.dimsOf(p);
    const [x1, y1, x2, y2] = vp.convertToViewportRectangle(rect);
    return { x: Math.min(x1, x2) - cx, y: Math.min(y1, y2) - cy, w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
  }
  pdfPointToView(num, x, y) {
    const p = this.pages[num - 1];
    const { vp, cx, cy } = p.geo || this.dimsOf(p);
    const [vx, vy] = vp.convertToViewportPoint(x, y);
    return [vx - cx, vy - cy];
  }
  clientToPdf(num, clientX, clientY) {
    const p = this.pages[num - 1];
    const r = p.div.getBoundingClientRect();
    const { vp, cx, cy } = p.geo || this.dimsOf(p);
    const [x, y] = vp.convertToPdfPoint(clientX - r.left + cx, clientY - r.top + cy);
    return { x, y };
  }
  pageAtClient(clientX, clientY) {
    const node = document.elementFromPoint(clientX, clientY);
    const div = node?.closest?.('.page');
    return div ? parseInt(div.dataset.page, 10) : null;
  }

  // ------------------------------------------------------------ layout / zoom
  computeScale() {
    const gutter = this.container.offsetWidth - this.container.clientWidth > 0 ? 0 : 18;
    const cw = this.container.clientWidth - 28 - gutter;
    const ch = this.container.clientHeight - 2 * PAGE_GAP;
    if (!this.pages.length) return;
    const d = this.pageMode === 'paged' ? this.visibleDims() : this.dimsOf(this.pages[0], 1);
    if (this.zoomMode === 'auto') this.scale = Math.min(cw, this.pageMode === 'paged' ? Infinity : MAX_AUTO_WIDTH) / d.cw;
    else if (this.zoomMode === 'page-fit') this.scale = Math.min(cw / d.cw, ch / d.ch);
    else this.scale = parseFloat(this.zoomMode) || 1;
    this.scale = clamp(this.scale, 0.2, 6);
    this.lastWidth = this.container.clientWidth;
  }

  /** Páginas duplas ativas? (modo paginado, tela larga em paisagem) */
  spreadActive() {
    const c = this.container;
    return this.pageMode === 'paged' && this.spread !== 'off' && this.numPages > 1 && c.clientWidth > c.clientHeight && c.clientWidth >= 860;
  }
  /** Índices das páginas exibidas no modo paginado (1 ou 2), normalizando a página atual para a esquerda da dupla. */
  visibleIndices() {
    if (this.pageMode !== 'paged') return [this.currentPage - 1];
    if (!this.spreadActive()) return [this.currentPage - 1];
    const left = this.currentPage % 2 ? this.currentPage : this.currentPage - 1;
    const idx = [left - 1, left].filter(i => i >= 0 && i < this.numPages);
    return idx;
  }
  /** Dimensões (escala 1) do conjunto visível: largura somada + espaço, altura máxima. */
  visibleDims() {
    const idx = this.visibleIndices();
    let cw = 0, ch = 0;
    for (const i of idx) { const d = this.dimsOf(this.pages[i], 1); cw += d.cw; ch = Math.max(ch, d.ch); }
    return { cw: cw + (idx.length > 1 ? 10 : 0), ch };
  }
  applyCurrentClasses() {
    const idx = this.visibleIndices();
    const left = idx[0];
    this.currentPage = left + 1;
    for (const p of this.pages) {
      const i = p.num - 1;
      const on = idx.includes(i);
      p.div.classList.toggle('current', on);
      p.div.classList.toggle('spread-left', on && idx.length > 1 && i === idx[0]);
      p.div.classList.toggle('spread-right', on && idx.length > 1 && i === idx[1]);
    }
  }

  layout() {
    for (const p of this.pages) this.sizePage(p);
    if (this.pageMode === 'paged') {
      this.applyCurrentClasses();
      this.viewerEl.style.minWidth = `${this.container.clientWidth}px`;
      this.viewerEl.style.minHeight = `${this.container.clientHeight}px`;
    } else {
      for (const p of this.pages) p.div.classList.remove('current');
      this.viewerEl.style.minWidth = ''; this.viewerEl.style.minHeight = '';
    }
    this.measure();
  }
  /** Escala que ajusta a página atual inteira à tela. */
  fitScale() {
    if (!this.pages.length) return 1;
    const d = this.pageMode === 'paged' ? this.visibleDims() : this.dimsOf(this.pages[0], 1);
    const gutter = this.container.offsetWidth - this.container.clientWidth > 0 ? 0 : 18;
    return Math.min((this.container.clientWidth - 28 - gutter) / d.cw, (this.container.clientHeight - 2 * PAGE_GAP) / d.ch);
  }
  sizePage(p) {
    const g = this.dimsOf(p);
    p.geo = g;
    p.width = Math.round(g.cw); p.height = Math.round(g.ch);
    p.div.style.width = `${p.width}px`;
    p.div.style.height = `${p.height}px`;
    p.div.style.setProperty('--scale-factor', this.scale);
    p.textLayerDiv.style.left = `${-g.cx}px`;
    p.textLayerDiv.style.top = `${-g.cy}px`;
  }
  measure() { this.tops = this.pages.map(p => p.div.offsetTop); }

  getPosition() {
    if (this.pageMode === 'paged') {
      const p = this.pages[this.currentPage - 1];
      return { page: this.currentPage, yRatio: p ? clamp((this.container.scrollTop - this.tops[this.currentPage - 1]) / p.height, 0, 1) : 0 };
    }
    const i = this.pageIndexAt(this.container.scrollTop);
    const p = this.pages[i];
    if (!p) return { page: 1, yRatio: 0 };
    return { page: p.num, yRatio: clamp((this.container.scrollTop - this.tops[i]) / p.height, 0, 1) };
  }
  pageIndexAt(y) {
    if (this.pageMode === 'paged') return this.currentPage - 1;
    const tops = this.tops;
    let lo = 0, hi = tops.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tops[mid] - 7 <= y) lo = mid; else hi = mid - 1; }
    return lo;
  }

  setZoom(mode, anchor) {
    const pos = anchor || this.anchorAt(this.container.clientWidth / 2, this.container.clientHeight / 2);
    this.zoomMode = mode;
    this.computeScale();
    this.applyLayout(pos);
  }
  zoomTo(newScale, clientX, clientY) {
    const rect = this.container.getBoundingClientRect();
    const pos = this.anchorAt(clientX - rect.left, clientY - rect.top);
    this.zoomMode = String(clamp(newScale, 0.2, 6));
    this.computeScale();
    this.applyLayout(pos);
  }
  zoomStep(dir) {
    const steps = [0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
    const cur = this.scale;
    let next = dir > 0 ? steps.find(s => s > cur + 0.01) : [...steps].reverse().find(s => s < cur - 0.01);
    if (next == null) next = clamp(cur * (dir > 0 ? 1.2 : 1 / 1.2), 0.2, 6);
    this.setZoom(String(next));
  }
  setRotation(deg) {
    const pos = this.getPosition();
    this.rotation = ((deg % 360) + 360) % 360;
    this.computeScale();
    this.applyLayout(null);
    this.goTo(pos.page, pos.yRatio);
  }
  async setCropMargins(on) {
    const pos = this.getPosition();
    this.cropMargins = !!on;
    if (on) await this.ensureCrop(this.pages[pos.page - 1]);
    this.computeScale();
    this.applyLayout(null);
    this.goTo(pos.page, pos.yRatio);
  }
  setPageMode(mode) {
    const pos = this.getPosition();
    this.pageMode = mode;
    this.currentPage = pos.page;
    this.container.classList.toggle('paged', mode === 'paged');
    if (mode === 'paged') this.zoomMode = 'page-fit';
    else if (this.zoomMode === 'page-fit') this.zoomMode = 'auto';
    this.computeScale();
    this.applyLayout(null);
    this.goTo(pos.page, mode === 'paged' ? 0 : pos.yRatio);
    this.dispatchEvent(new CustomEvent('pagechange', { detail: { page: this.currentPage, numPages: this.numPages } }));
  }

  anchorAt(cx, cy) {
    const sx = this.container.scrollLeft + cx, sy = this.container.scrollTop + cy;
    const i = this.pageIndexAt(sy);
    const p = this.pages[i];
    if (!p) return null;
    return { index: i, xRatio: (sx - p.div.offsetLeft) / p.width, yRatio: (sy - this.tops[i]) / p.height, cx, cy };
  }
  applyLayout(pos) {
    for (const p of this.pages) this.cleanupPage(p);
    this.renderQueue = [];
    this.layout();
    if (pos) {
      const p = this.pages[pos.index];
      this.container.scrollTop = this.tops[pos.index] + pos.yRatio * p.height - pos.cy;
      this.container.scrollLeft = p.div.offsetLeft + pos.xRatio * p.width - pos.cx;
    }
    this.dispatchEvent(new CustomEvent('scalechange', { detail: { scale: this.scale, zoomMode: this.zoomMode } }));
    this.update();
  }
  onResize() {
    if (!this.pdf) return;
    const fit = this.zoomMode === 'auto' || this.zoomMode === 'page-fit';
    if (fit && (this.container.clientWidth !== this.lastWidth || this.zoomMode === 'page-fit')) {
      const pos = this.getPosition();
      this.computeScale();
      for (const p of this.pages) this.cleanupPage(p);
      this.layout();
      this.goTo(pos.page, pos.yRatio);
      this.dispatchEvent(new CustomEvent('scalechange', { detail: { scale: this.scale, zoomMode: this.zoomMode } }));
    } else this.measure();
    this.update();
  }

  // ------------------------------------------------------------ navegação
  goTo(page, yRatio = 0) {
    page = clamp(Math.round(page) || 1, 1, this.numPages);
    const i = page - 1;
    if (!this.pages[i]) return;
    if (this.pageMode === 'paged') {
      const before = this.currentPage;
      this.currentPage = page;
      this.applyCurrentClasses();
      page = this.currentPage;
      const changed = page !== before;
      if (changed) {
        if (this.zoomMode === 'page-fit' || this.zoomMode === 'auto') { this.computeScale(); for (const p of this.pages) this.sizePage(p); }
        this.measure();
      }
      const li = page - 1;
      this.container.scrollTop = this.tops[li] + yRatio * this.pages[li].height;
      if (changed) this.dispatchEvent(new CustomEvent('pagechange', { detail: { page, numPages: this.numPages } }));
      this.update();
      return;
    }
    const gap = yRatio ? 0 : 6;
    this.container.scrollTop = this.tops[i] + yRatio * this.pages[i].height - gap;
    this.update();
  }
  nextPage() { this.turnPage(1); }
  prevPage() { this.turnPage(-1); }
  /** Vira a página; no modo paginado com trava, mantém zoom e enquadramento. */
  turnPage(delta) {
    if (this.spreadActive()) delta *= 2;
    const target = clamp(this.currentPage + delta, 1, this.numPages);
    if (target === this.currentPage) return;
    if (target < 1 || target > this.numPages) return;
    if (this.pageMode !== 'paged') { this.goTo(target); return; }
    const c = this.container;
    const keep = this.viewLock ? { left: c.scrollLeft, yRatio: clamp((c.scrollTop - this.tops[this.currentPage - 1]) / (this.pages[this.currentPage - 1].height || 1), 0, 1) } : null;
    this.goTo(target, keep ? keep.yRatio : 0);
    if (keep) c.scrollLeft = keep.left;
  }

  // ------------------------------------------------------------ virtualização
  update() {
    if (!this.pdf || !this.pages.length) return;
    if (this.pageMode === 'paged') {
      const vis = this.visibleIndices();
      const ci = vis[0], last = vis[vis.length - 1];
      const wanted = [...vis, last + 1, ci - 1, last + 2, ci - 2].filter((i, k, arr) => i >= 0 && i < this.pages.length && arr.indexOf(i) === k);
      this.renderQueue = wanted.map(i => this.pages[i]).filter(p => !p.rendered && !p.rendering);
      this.pump();
      for (let i = 0; i < this.pages.length; i++) if (i < ci - 3 || i > last + 3) { const p = this.pages[i]; if (p.rendered || p.rendering) this.cleanupPage(p); }
      this.dispatchEvent(new CustomEvent('scroll', { detail: { first: this.currentPage, last: this.currentPage } }));
      return;
    }
    const top = this.container.scrollTop, bottom = top + this.container.clientHeight;
    const first = this.pageIndexAt(top);
    let last = first;
    while (last + 1 < this.pages.length && this.tops[last + 1] < bottom) last++;
    const cur = this.pageIndexAt(top + this.container.clientHeight * 0.33) + 1;
    if (cur !== this.currentPage) {
      this.currentPage = cur;
      this.dispatchEvent(new CustomEvent('pagechange', { detail: { page: cur, numPages: this.numPages } }));
    }
    const lo = Math.max(0, first - 1), hi = Math.min(this.pages.length - 1, last + 1);
    const center = (first + last) / 2;
    const wanted = [];
    for (let i = lo; i <= hi; i++) wanted.push(i);
    wanted.sort((a, b) => Math.abs(a - center) - Math.abs(b - center));
    this.renderQueue = wanted.map(i => this.pages[i]).filter(p => !p.rendered && !p.rendering);
    this.pump();
    for (let i = 0; i < this.pages.length; i++) {
      if (i < first - KEEP_RANGE || i > last + KEEP_RANGE) { const p = this.pages[i]; if (p.rendered || p.rendering) this.cleanupPage(p); }
    }
    this.dispatchEvent(new CustomEvent('scroll', { detail: { first: first + 1, last: last + 1 } }));
  }
  pump() {
    while (this.rendering < RENDER_CONCURRENCY && this.renderQueue.length) {
      const p = this.renderQueue.shift();
      if (p.rendered || p.rendering) continue;
      this.renderPage(p);
    }
  }

  async renderPage(p) {
    p.rendering = true; this.rendering++;
    const token = (p.token = (p.token || 0) + 1);
    const scaleAtStart = this.scale, rotAtStart = this.rotation, cropAtStart = this.cropMargins;
    const alive = () => p.token === token && p.rendering && this.scale === scaleAtStart && this.rotation === rotAtStart && this.cropMargins === cropAtStart;
    try {
      const page = await this.pdf.getPage(p.num);
      if (!alive()) return;
      let relayout = false;
      if (!p.baseKnown) {
        const b = page.getViewport({ scale: 1 });
        if (Math.abs(b.width - p.base0.width) > 0.5 || Math.abs(b.height - p.base0.height) > 0.5) relayout = true;
        p.base0 = b; p.baseKnown = true;
      }
      if (this.cropMargins && !p.cropKnown) { await this.ensureCrop(p, page); if (!alive()) return; relayout = true; }
      if (relayout) this.resizePageKeepingScroll(p);

      const { vp, cx, cy, cw, ch } = p.geo;
      const renderVp = vp.clone({ offsetX: -cx, offsetY: -cy });
      const dpr = window.devicePixelRatio || 1;
      let os = Math.min(dpr, 3);
      if (cw * ch * os * os > MAX_CANVAS_PIXELS) os = Math.sqrt(MAX_CANVAS_PIXELS / (cw * ch));
      const canvas = el('canvas');
      canvas.width = Math.floor(cw * os); canvas.height = Math.floor(ch * os);
      canvas.style.width = `${p.width}px`; canvas.style.height = `${p.height}px`;
      const ctx = canvas.getContext('2d', { alpha: false });
      const renderTask = page.render({ canvasContext: ctx, viewport: renderVp, transform: os !== 1 ? [os, 0, 0, os, 0, 0] : undefined });
      p.renderTask = renderTask;
      const textPromise = page.getTextContent();
      const annotPromise = page.getAnnotations().catch(() => []);
      await renderTask.promise;
      if (!alive()) return;
      p.canvas = canvas;
      p.div.prepend(canvas);
      p.div.classList.remove('loading');

      const textContent = await textPromise;
      if (!alive()) return;
      this.cacheText(p.num, textContent, p.base0);
      p.textLayerDiv.replaceChildren();
      const tl = new pdfjsLib.TextLayer({ textContentSource: textContent, container: p.textLayerDiv, viewport: vp });
      p.textLayer = tl;
      await tl.render();
      if (!alive()) return;
      p.textLayerDiv.append(el('div', { class: 'endOfContent' }));
      this.renderLinks(p, await annotPromise);
      if (!alive()) return;
      p.rendered = true;
      this.dispatchEvent(new CustomEvent('pagerendered', { detail: { page: p.num, div: p.div, scale: this.scale } }));
    } catch (err) {
      if (err?.name !== 'RenderingCancelledException') console.warn('Falha ao renderizar página', p.num, err);
    } finally {
      if (p.token === token && p.rendering) { p.rendering = false; this.rendering--; }
      this.pump();
    }
  }

  resizePageKeepingScroll(p) {
    const before = this.container.scrollTop;
    const wasAbove = this.tops[p.num - 1] < before;
    const oldH = p.height;
    this.sizePage(p);
    this.measure();
    if (wasAbove) this.container.scrollTop = before + (p.height - oldH);
  }

  renderLinks(p, annots) {
    p.linkLayer.replaceChildren();
    for (const a of annots) {
      if (a.subtype !== 'Link' || !a.rect || (!a.dest && !a.url && !a.action)) continue;
      const v = this.pdfRectToView(p.num, a.rect);
      const link = el('a', { class: 'pdf-link', href: a.url || '#', title: a.url || '', style: { left: `${v.x}px`, top: `${v.y}px`, width: `${v.w}px`, height: `${v.h}px` } });
      link.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        this.dispatchEvent(new CustomEvent('linkclick', { detail: { dest: a.dest, url: a.url, action: a.action } }));
      });
      p.linkLayer.append(link);
    }
  }

  cleanupPage(p) {
    p.token = (p.token || 0) + 1;
    if (p.rendering) { p.rendering = false; this.rendering = Math.max(0, this.rendering - 1); }
    try { p.renderTask?.cancel(); } catch { /* ignore */ }
    try { p.textLayer?.cancel(); } catch { /* ignore */ }
    p.renderTask = null; p.textLayer = null;
    if (p.canvas) { p.canvas.width = 0; p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
    p.textLayerDiv.replaceChildren();
    p.annLayer.replaceChildren();
    p.noteLayer.replaceChildren();
    p.linkLayer.replaceChildren();
    p.rendered = false;
    p.div.classList.add('loading');
  }

  getPage(num) { return this.pages[num - 1]; }

  // ------------------------------------------------------------ corte de margens (detecção por pixels)
  async ensureCrop(p, page) {
    if (p.cropKnown) return p.cropBox;
    page = page || await this.pdf.getPage(p.num);
    try {
      const base = page.getViewport({ scale: 1 });
      const s = 140 / base.width;
      const vp = page.getViewport({ scale: s });
      const c = el('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      const rows = new Uint16Array(height), cols = new Uint16Array(width);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] + data[i + 1] + data[i + 2] < 690) { rows[y]++; cols[x]++; }
      }
      const findStart = (arr) => { for (let i = 0; i < arr.length; i++) if (arr[i] >= 2) return i; return -1; };
      const findEnd = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] >= 2) return i; return -1; };
      const x1 = findStart(cols), x2 = findEnd(cols), y1 = findStart(rows), y2 = findEnd(rows);
      if (x1 < 0 || (x2 - x1) < width * 0.25 || (y2 - y1) < height * 0.25) { p.cropBox = null; }
      else {
        const padX = width * 0.02, padY = height * 0.015;
        const [ax, ay] = vp.convertToPdfPoint(Math.max(0, x1 - padX), Math.max(0, y1 - padY));
        const [bx, by] = vp.convertToPdfPoint(Math.min(width, x2 + 1 + padX), Math.min(height, y2 + 1 + padY));
        p.cropBox = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
      }
    } catch { p.cropBox = null; }
    p.cropKnown = true;
    return p.cropBox;
  }

  // ------------------------------------------------------------ texto
  cacheText(num, textContent, base) {
    if (this.textCache.has(num)) return this.textCache.get(num);
    let text = '';
    const ranges = [];
    for (const item of textContent.items) {
      if (!('str' in item)) continue;
      const start = text.length;
      text += item.str;
      ranges.push({ start, end: text.length, item });
      if (item.hasEOL) text += '\n';
    }
    const entry = { text, ranges, base, items: textContent.items };
    this.textCache.set(num, entry);
    return entry;
  }
  async getPageText(num) {
    if (this.textCache.has(num)) return this.textCache.get(num);
    const page = await this.pdf.getPage(num);
    const tc = await page.getTextContent();
    return this.cacheText(num, tc, page.getViewport({ scale: 1 }));
  }

  async getParagraphs(num) {
    const { items } = await this.getPageText(num);
    const lines = [];
    for (const it of items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const y = it.transform[5], x = it.transform[4], h = it.height || Math.hypot(it.transform[1], it.transform[3]) || 10;
      let line = lines.find(l => Math.abs(l.y - y) < Math.max(2, h * 0.4));
      if (!line) { line = { y, x, h, parts: [] }; lines.push(line); }
      line.parts.push({ x, str: it.str });
      line.x = Math.min(line.x, x); line.h = Math.max(line.h, h);
    }
    lines.sort((a, b) => b.y - a.y);
    for (const l of lines) { l.parts.sort((a, b) => a.x - b.x); l.text = l.parts.map(p => p.str).join(' ').replace(/\s+/g, ' ').trim(); }
    const paras = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i], prev = lines[i - 1];
      let newPara = !cur;
      if (prev) {
        const gap = prev.y - l.y;
        if (gap > prev.h * 1.7) newPara = true;
        if (/[.!?…]["”’)]?$/.test(prev.text) && l.x > cur.x + l.h * 0.8) newPara = true;
        if (prev.text.length < 45 && /^[A-ZÀ-Ú0-9]/.test(l.text) && /[.!?:]$/.test(prev.text)) newPara = true;
      }
      if (newPara) { cur = { x: l.x, lines: [l.text] }; paras.push(cur); }
      else cur.lines.push(l.text);
    }
    return paras.map(p => p.lines.join('\n').replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2').replace(/\n/g, ' ')).filter(t => t.length > 1);
  }

  async search(query, onProgress, signal) {
    const q = query.trim();
    if (!q) return [];
    const words = q.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(words.join('[\\s\\u00ad-]*'), 'giu');
    const results = [];
    for (let n = 1; n <= this.numPages; n++) {
      if (signal?.aborted) break;
      const { text } = await this.getPageText(n);
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) && results.length < 500) {
        const s = Math.max(0, m.index - 40), e = Math.min(text.length, m.index + m[0].length + 40);
        results.push({ page: n, start: m.index, end: m.index + m[0].length, before: text.slice(s, m.index).replace(/\s+/g, ' '), match: m[0].replace(/\s+/g, ' '), after: text.slice(m.index + m[0].length, e).replace(/\s+/g, ' ') });
        if (!m[0].length) re.lastIndex++;
      }
      onProgress?.(n, this.numPages, results.length);
    }
    return results;
  }

  /** Retângulos em espaço PDF para um trecho [start,end) do texto da página. */
  rectsForTextRange(num, start, end) {
    const entry = this.textCache.get(num);
    if (!entry) return [];
    const rects = [];
    for (const r of entry.ranges) {
      if (r.end <= start || r.start >= end) continue;
      const it = r.item;
      const len = Math.max(1, r.end - r.start);
      const f0 = clamp((start - r.start) / len, 0, 1), f1 = clamp((end - r.start) / len, 0, 1);
      const x = it.transform[4], y = it.transform[5];
      const h = it.height || Math.hypot(it.transform[1], it.transform[3]);
      rects.push([x + it.width * f0, y - h * 0.2, x + it.width * f1, y + h]);
    }
    return rects;
  }
  flashRange(num, start, end) {
    const p = this.pages[num - 1];
    if (!p) return;
    const draw = () => {
      for (const r of this.rectsForTextRange(num, start, end)) {
        const v = this.pdfRectToView(num, r);
        const d = el('div', { class: 'search-hit', style: { left: `${v.x}px`, top: `${v.y}px`, width: `${v.w}px`, height: `${v.h}px` } });
        p.annLayer.append(d);
        setTimeout(() => d.remove(), 2600);
      }
    };
    if (p.rendered) draw();
    else { const once = (ev) => { if (ev.detail.page === num) { this.removeEventListener('pagerendered', once); draw(); } }; this.addEventListener('pagerendered', once); }
  }
  /** Fração vertical (0..1) de um retângulo PDF dentro da página, para rolar até ele. */
  yRatioOf(num, rect, marginPx = 80) {
    const p = this.pages[num - 1];
    if (!p || !rect) return 0;
    const v = this.pdfRectToView(num, rect);
    return clamp((v.y - marginPx) / p.height, 0, 1);
  }

  // ------------------------------------------------------------ sumário / destinos / miniaturas
  async getOutline() { try { return (await this.pdf.getOutline()) || []; } catch { return []; } }
  async resolveDest(dest) {
    try {
      let d = dest;
      if (typeof d === 'string') d = await this.pdf.getDestination(d);
      if (!Array.isArray(d) || !d[0]) return null;
      const ref = d[0];
      const idx = typeof ref === 'object' ? await this.pdf.getPageIndex(ref) : ref;
      let yRatio = 0;
      if (d[1]?.name === 'XYZ' && typeof d[3] === 'number') {
        const p = this.pages[idx];
        if (p) { const v = this.pdfRectToView(idx + 1, [0, d[3], 1, d[3]]); yRatio = clamp(v.y / p.height, 0, 1); }
      }
      return { page: idx + 1, yRatio };
    } catch { return null; }
  }
  async renderThumbnail(num, canvas, width = 120) {
    const page = await this.pdf.getPage(num);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (width / base.width) * 2 });
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d', { alpha: false }), viewport: vp }).promise;
    return base.width / base.height;
  }

  // ------------------------------------------------------------ gestos
  _setupGestures() {
    const c = this.container;
    // deslizar para virar a página (modo paginado) e duplo toque para ampliar
    let swipe = null, lastTap = 0, lastTapX = 0, lastTapY = 0;
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || this.inkActive) { swipe = null; return; }
      const t = e.touches[0];
      swipe = { x: t.clientX, y: t.clientY, t: Date.now(), left: c.scrollLeft };
    }, { passive: true });
    c.addEventListener('touchend', (e) => {
      if (!swipe || e.touches.length) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - swipe.x, dy = t.clientY - swipe.y, dt = Date.now() - swipe.t;
      const s = swipe; swipe = null;
      if (this.pageMode === 'paged' && dt < 1200 && Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * 0.6 && !(this.selectionText ? this.selectionText() : window.getSelection()?.toString())) {
        const atRight = c.scrollLeft + c.clientWidth >= c.scrollWidth - 2, atLeft = c.scrollLeft <= 2;
        const moved = Math.abs(c.scrollLeft - s.left) > 4;
        if (dx < 0 && atRight && !moved) { this.nextPage(); return; }
        if (dx > 0 && atLeft && !moved) { this.prevPage(); return; }
      }
      if (dt < 300 && Math.abs(dx) < 12 && Math.abs(dy) < 12) {
        const now = Date.now();
        if (now - lastTap < 320 && Math.abs(t.clientX - lastTapX) < 30 && Math.abs(t.clientY - lastTapY) < 30) {
          lastTap = 0;
          if (this.pdf && !(this.selectionText ? this.selectionText() : window.getSelection()?.toString())) {
            const fit = this.pageMode === 'paged' ? this.fitScale() : null;
            if (fit && this.scale > fit * 1.08) this.setZoom('page-fit');
            else if (!fit && this.zoomMode !== 'auto') this.setZoom('auto');
            else this.zoomTo(this.scale * 2.2, t.clientX, t.clientY);
          }
          return;
        }
        lastTap = now; lastTapX = t.clientX; lastTapY = t.clientY;
      }
    }, { passive: true });
    c.addEventListener('wheel', (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (!this.pdf) return;
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      this._wheelScale = (this._wheelScale || this.scale) * factor;
      clearTimeout(this._wheelTimer);
      this._wheelTimer = setTimeout(() => { this.zoomTo(this._wheelScale, e.clientX, e.clientY); this._wheelScale = null; }, 60);
    }, { passive: false });

    let pinch = null;
    c.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2 && !this.inkActive) {
        const [a, b] = e.touches;
        pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale0: this.scale, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, ratio: 1 };
        const r = c.getBoundingClientRect();
        this.viewerEl.style.transformOrigin = `${pinch.cx - r.left + c.scrollLeft}px ${pinch.cy - r.top + c.scrollTop}px`;
      }
    }, { passive: true });
    c.addEventListener('touchmove', (e) => {
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const [a, b] = e.touches;
      pinch.ratio = clamp(Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.d0, 0.3, 4);
      this.viewerEl.style.transform = `scale(${pinch.ratio})`;
    }, { passive: false });
    const endPinch = () => {
      if (!pinch) return;
      const { ratio, scale0, cx, cy } = pinch;
      pinch = null;
      this.viewerEl.style.transform = ''; this.viewerEl.style.transformOrigin = '';
      if (Math.abs(ratio - 1) > 0.03) this.zoomTo(scale0 * ratio, cx, cy);
    };
    c.addEventListener('touchend', endPinch);
    c.addEventListener('touchcancel', endPinch);
  }
}
