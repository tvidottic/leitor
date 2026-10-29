// Seleção de texto própria do aplicativo: não usa a seleção nativa do navegador, por isso não aparecem
// os menus de copiar/pesquisar do próprio navegador. Toque longo (ou arraste com o mouse) seleciona
// palavras inteiras; alças nas pontas permitem ajustar.

import { el } from './utils.js';

const WORD = /[\p{L}\p{M}\d'’-]/u;
const LONG_PRESS_MS = 420;

export class CustomSelection extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.enabled = false;
    this.range = null;
    this.anchor = null;      // {node, offset} ponto fixo
    this.dragging = null;    // 'new' | 'start' | 'end'
    this.pending = null;
    this.timer = null;
    this.overlay = el('div', { class: 'sel-overlay', hidden: true });
    document.body.append(this.overlay);
    this._bind();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.container.classList.toggle('custom-sel', this.enabled);
    if (!this.enabled) this.clear();
  }

  /** Objeto compatível com window.getSelection() para o restante do app. */
  shim() {
    const r = this.range;
    return {
      rangeCount: r ? 1 : 0,
      isCollapsed: !r || r.collapsed,
      getRangeAt: () => r,
      toString: () => (r ? r.toString() : ''),
      removeAllRanges: () => this.clear(),
      custom: true,
    };
  }

  clear() {
    const had = !!this.range;
    this.range = null; this.anchor = null; this.dragging = null;
    this.overlay.hidden = true; this.overlay.replaceChildren();
    if (had) this.dispatchEvent(new Event('clear'));
  }

  // ------------------------------------------------------------ geometria de texto
  caretAt(x, y) {
    let node, offset;
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (!p) return null; node = p.offsetNode; offset = p.offset; }
    else if (document.caretRangeFromPoint) { const r = document.caretRangeFromPoint(x, y); if (!r) return null; node = r.startContainer; offset = r.startOffset; }
    if (!node) return null;
    if (node.nodeType !== 3) {
      // caiu em um elemento: tenta o span de texto mais próximo do ponto
      const elAt = document.elementFromPoint(x, y);
      const span = elAt?.closest?.('.textLayer span');
      if (!span?.firstChild || span.firstChild.nodeType !== 3) return null;
      node = span.firstChild; offset = Math.min(offset, node.length);
    }
    if (!node.parentElement?.closest('.textLayer')) return null;
    return { node, offset };
  }
  wordBounds(node, offset) {
    const t = node.textContent;
    let s = Math.min(offset, t.length), e = s;
    while (s > 0 && WORD.test(t[s - 1])) s--;
    while (e < t.length && WORD.test(t[e])) e++;
    if (e === s) { // espaço: pega a palavra seguinte, se houver
      while (e < t.length && !WORD.test(t[e])) e++;
      s = e;
      while (e < t.length && WORD.test(t[e])) e++;
    }
    return [s, e];
  }
  isBefore(a, b) {
    if (a.node === b.node) return a.offset <= b.offset;
    return !!(a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
  buildRange(a, b, snap = true) {
    let start = a, end = b;
    if (!this.isBefore(a, b)) { start = b; end = a; }
    const r = document.createRange();
    if (snap) {
      const [s0] = this.wordBounds(start.node, start.offset);
      const [, e1] = this.wordBounds(end.node, end.offset);
      r.setStart(start.node, s0); r.setEnd(end.node, e1);
    } else { r.setStart(start.node, start.offset); r.setEnd(end.node, end.offset); }
    return r;
  }

  /** Seleciona a palavra sob o ponto (usado pelo modo toque). */
  selectWordAt(x, y) {
    const c = this.caretAt(x, y);
    if (!c) return false;
    const [s, e] = this.wordBounds(c.node, c.offset);
    if (e <= s) return false;
    const r = document.createRange(); r.setStart(c.node, s); r.setEnd(c.node, e);
    this.range = r; this.anchor = { node: c.node, offset: s };
    this.draw();
    this.dispatchEvent(new Event('end'));
    return true;
  }

  // ------------------------------------------------------------ desenho
  draw() {
    const r = this.range;
    if (!r || r.collapsed) { this.overlay.hidden = true; this.overlay.replaceChildren(); return; }
    const rects = Array.from(r.getClientRects()).filter(x => x.width > 0 && x.height > 0);
    const frag = document.createDocumentFragment();
    for (const x of rects) frag.append(el('div', { class: 'sel-rect', style: { left: `${x.left}px`, top: `${x.top}px`, width: `${x.width}px`, height: `${x.height}px` } }));
    if (rects.length) {
      const f = rects[0], l = rects[rects.length - 1];
      frag.append(el('div', { class: 'sel-handle start', style: { left: `${f.left}px`, top: `${f.bottom}px` } }));
      frag.append(el('div', { class: 'sel-handle end', style: { left: `${l.right}px`, top: `${l.bottom}px` } }));
    }
    this.overlay.replaceChildren(frag);
    this.overlay.hidden = false;
  }
  endpointRects() {
    if (!this.range) return null;
    const rects = Array.from(this.range.getClientRects()).filter(x => x.width > 0);
    if (!rects.length) return null;
    return { start: rects[0], end: rects[rects.length - 1] };
  }
  nearHandle(x, y) {
    const ep = this.endpointRects();
    if (!ep) return null;
    const d = (px, py) => Math.hypot(x - px, y - py);
    const ds = d(ep.start.left, ep.start.bottom + 10), de = d(ep.end.right, ep.end.bottom + 10);
    const lim = 28;
    if (de <= lim && de <= ds) return 'end';
    if (ds <= lim) return 'start';
    return null;
  }

  // ------------------------------------------------------------ eventos
  _bind() {
    const c = this.container;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onUp(e, true));
    c.addEventListener('touchmove', (e) => { if (this.dragging) e.preventDefault(); }, { passive: false });
    c.addEventListener('contextmenu', (e) => { if (this.enabled && e.target.closest?.('.textLayer')) e.preventDefault(); });
    c.addEventListener('scroll', () => { if (this.range) requestAnimationFrame(() => this.draw()); }, { passive: true });
    window.addEventListener('resize', () => { if (this.range) this.draw(); });
  }

  onDown(e) {
    if (!this.enabled || e.button > 0 || this.container.classList.contains('inking')) return;
    if (e.target.closest?.('.note-pin, .pdf-link')) return;
    const handle = this.range ? this.nearHandle(e.clientX, e.clientY) : null;
    if (handle) {
      this.dragging = handle;
      this.anchor = handle === 'end' ? { node: this.range.startContainer, offset: this.range.startOffset } : { node: this.range.endContainer, offset: this.range.endOffset };
      this.capture(e);
      e.preventDefault();
      this.dispatchEvent(new Event('start'));
      return;
    }
    const inText = !!e.target.closest?.('.textLayer');
    if (this.range && !inText) { this.clear(); return; }
    if (!inText) return;
    const caret = this.caretAt(e.clientX, e.clientY);
    if (this.range) this.clear();
    if (!caret) return;
    this.pending = { x: e.clientX, y: e.clientY, caret, id: e.pointerId, type: e.pointerType };
    clearTimeout(this.timer);
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') {
      this.timer = setTimeout(() => {
        if (!this.pending) return;
        const p = this.pending; this.pending = null;
        try { navigator.vibrate?.(12); } catch { /* ignore */ }
        this.start(p.caret, true);
        this.capture({ pointerId: p.id });
      }, LONG_PRESS_MS);
    }
  }
  onMove(e) {
    if (this.dragging) {
      const caret = this.caretAt(e.clientX, e.clientY);
      if (caret) { this.range = this.buildRange(this.anchor, caret, this.snap); this.draw(); }
      e.preventDefault?.();
      return;
    }
    if (!this.pending) return;
    const dx = e.clientX - this.pending.x, dy = e.clientY - this.pending.y;
    if (Math.hypot(dx, dy) > 8) {
      if (this.pending.type === 'mouse' || this.pending.type === 'pen') { const p = this.pending; this.pending = null; this.start(p.caret, p.type === 'pen'); this.capture(e); }
      else { this.pending = null; clearTimeout(this.timer); } // dedo moveu: é rolagem
    }
  }
  onUp(e, cancel = false) {
    clearTimeout(this.timer);
    this.pending = null;
    if (!this.dragging) return;
    this.dragging = null;
    try { this.container.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (cancel || !this.range || this.range.collapsed) { this.clear(); return; }
    this.draw();
    this.dispatchEvent(new Event('end'));
  }
  start(caret, snap) {
    this.snap = snap;
    this.anchor = caret;
    this.dragging = 'new';
    this.range = snap ? this.buildRange(caret, caret, true) : null;
    this.draw();
    this.dispatchEvent(new Event('start'));
  }
  capture(e) { try { this.container.setPointerCapture(e.pointerId); } catch { /* ignore */ } }
}
