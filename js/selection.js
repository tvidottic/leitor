// Seleção de texto própria do aplicativo: não usa a seleção nativa do navegador, por isso não aparecem
// os menus de copiar/pesquisar do próprio navegador. Toque longo (ou arraste com o mouse/caneta) seleciona
// palavras inteiras; alças nas pontas permitem ajustar.
//
// No toque e na caneta o gesto é acompanhado pelos eventos de toque (touchstart/touchmove/touchend), e não
// pelos eventos de ponteiro: o Chrome para Android cancela os eventos de ponteiro (pointercancel) ao
// reconhecer o toque longo ou ao começar a rolar, o que interrompia a seleção em tablets. Os eventos de
// toque continuam chegando e, com preventDefault em touchmove, a página não rola enquanto se seleciona.

import { el } from './utils.js';

const WORD = /[\p{L}\p{M}\d'’-]/u;
const LONG_PRESS_MS = 420;
const MOVE_SLOP = 8;

export class CustomSelection extends EventTarget {
  constructor(container) {
    super();
    this.container = container;
    this.enabled = false;
    this.range = null;
    this.anchor = null;      // {node, offset} ponto fixo
    this.snap = true;
    // gesto em andamento: { via: 'pointer'|'touch', kind: 'mouse'|'pen'|'touch', id, x, y, caret, phase: 'pending'|'drag', timer }
    this.gesture = null;
    this.lastPointer = null; // último pointerdown (para saber se um touchstart veio de uma caneta)
    this.overlay = el('div', { class: 'sel-overlay', hidden: true });
    document.body.append(this.overlay);
    this._bind();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.container.classList.toggle('custom-sel', this.enabled);
    if (!this.enabled) this.clear();
  }

  get dragging() { return this.gesture?.phase === 'drag'; }

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
    this.range = null; this.anchor = null;
    this.endGesture();
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
    c.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    c.addEventListener('pointermove', (e) => this.onPointerMove(e));
    c.addEventListener('pointerup', (e) => this.onPointerUp(e));
    c.addEventListener('pointercancel', (e) => this.onPointerUp(e, true));
    c.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    c.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    c.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    c.addEventListener('touchcancel', (e) => this.onTouchEnd(e, true), { passive: false });
    // sem menu de contexto do navegador sobre o texto nem durante um gesto de seleção (no Android, o menu
    // do toque longo cancelaria o gesto)
    c.addEventListener('contextmenu', (e) => { if (this.enabled && (this.gesture || this.range || e.target.closest?.('.textLayer'))) e.preventDefault(); });
    c.addEventListener('scroll', () => { if (this.range) requestAnimationFrame(() => this.draw()); }, { passive: true });
    window.addEventListener('resize', () => { if (this.range) this.draw(); });
  }

  canStart(target) {
    return this.enabled && !this.container.classList.contains('inking') && !target.closest?.('.note-pin, .pdf-link');
  }

  /** Começo comum de um gesto em (x, y). Devolve true se o gesto foi assumido. */
  beginAt(x, y, target, kind, via, id) {
    const handle = this.range ? this.nearHandle(x, y) : null;
    if (handle) {
      this.anchor = handle === 'end' ? { node: this.range.startContainer, offset: this.range.startOffset } : { node: this.range.endContainer, offset: this.range.endOffset };
      this.gesture = { via, kind, id, x, y, caret: null, phase: 'drag', handle };
      this.dispatchEvent(new Event('start'));
      return true;
    }
    const inText = !!target.closest?.('.textLayer');
    if (this.range && !inText) { this.clear(); return false; }
    if (!inText) return false;
    const caret = this.caretAt(x, y);
    if (this.range) this.clear();
    if (!caret) return false;
    this.gesture = { via, kind, id, x, y, caret, phase: 'pending', timer: null };
    if (kind === 'touch') {
      this.gesture.timer = setTimeout(() => {
        const g = this.gesture;
        if (!g || g.phase !== 'pending') return;
        try { navigator.vibrate?.(12); } catch { /* ignore */ }
        this.start(g.caret, true);
      }, LONG_PRESS_MS);
    }
    return true;
  }
  moveTo(x, y) {
    const g = this.gesture;
    if (!g) return;
    if (g.phase === 'drag') {
      const caret = this.caretAt(x, y);
      if (caret) { this.range = this.buildRange(this.anchor, caret, this.snap); this.draw(); }
      return;
    }
    if (Math.hypot(x - g.x, y - g.y) > MOVE_SLOP) {
      if (g.kind === 'touch') { this.endGesture(); return; } // dedo moveu antes do toque longo: é rolagem
      this.start(g.caret, g.kind === 'pen');                  // mouse/caneta: arrastar seleciona de imediato
    }
  }
  finish(cancel = false) {
    const g = this.gesture;
    if (!g) return;
    const wasDrag = g.phase === 'drag';
    this.endGesture();
    if (!wasDrag) return;
    if (cancel || !this.range || this.range.collapsed) { this.clear(); return; }
    this.draw();
    this.dispatchEvent(new Event('end'));
  }
  endGesture() {
    const g = this.gesture;
    if (!g) return;
    clearTimeout(g.timer);
    if (g.via === 'pointer') { try { this.container.releasePointerCapture(g.id); } catch { /* ignore */ } }
    this.gesture = null;
  }
  start(caret, snap) {
    const g = this.gesture;
    this.snap = snap;
    this.anchor = caret;
    if (g) g.phase = 'drag';
    this.range = snap ? this.buildRange(caret, caret, true) : null;
    this.draw();
    this.dispatchEvent(new Event('start'));
  }

  // ---- mouse e caneta (eventos de ponteiro)
  onPointerDown(e) {
    this.lastPointer = { type: e.pointerType, t: performance.now() };
    if (e.pointerType === 'touch') return;                      // o toque é tratado pelos eventos de toque
    if (!this.canStart(e.target) || e.button > 0 || this.gesture) return;
    const kind = e.pointerType === 'pen' ? 'pen' : 'mouse';
    if (this.beginAt(e.clientX, e.clientY, e.target, kind, 'pointer', e.pointerId)) {
      if (this.gesture.phase === 'drag') { e.preventDefault(); this.capture(e.pointerId); }
    }
  }
  onPointerMove(e) {
    const g = this.gesture;
    if (!g || g.via !== 'pointer' || e.pointerId !== g.id) return;
    const wasPending = g.phase === 'pending';
    this.moveTo(e.clientX, e.clientY);
    if (this.gesture?.phase === 'drag') { e.preventDefault(); if (wasPending) this.capture(e.pointerId); }
  }
  onPointerUp(e, cancel = false) {
    const g = this.gesture;
    if (!g || g.via !== 'pointer' || e.pointerId !== g.id) return;
    this.finish(cancel);
  }
  capture(id) { try { this.container.setPointerCapture(id); } catch { /* ignore */ } }

  // ---- dedo e caneta em telas de toque (eventos de toque)
  onTouchStart(e) {
    if (e.touches.length !== 1) { if (this.gesture?.via === 'touch') this.finish(this.gesture.phase !== 'drag'); return; }
    const t = e.touches[0];
    // uma caneta gera pointerdown (pen) e logo depois touchstart: o gesto já começado passa a ser seguido pelo toque
    const g = this.gesture;
    if (g && g.via === 'pointer' && g.kind === 'pen') {
      try { this.container.releasePointerCapture(g.id); } catch { /* ignore */ }
      g.via = 'touch'; g.id = t.identifier;
      if (g.phase === 'drag') e.preventDefault();
      return;
    }
    if (g || !this.canStart(e.target)) return;
    const pen = this.lastPointer && this.lastPointer.type === 'pen' && performance.now() - this.lastPointer.t < 300;
    if (this.beginAt(t.clientX, t.clientY, e.target, pen ? 'pen' : 'touch', 'touch', t.identifier)) {
      if (this.gesture.phase === 'drag') e.preventDefault();     // alça: não rola
    }
  }
  touchOf(e) {
    const g = this.gesture;
    if (!g || g.via !== 'touch') return null;
    return Array.from(e.changedTouches).find(t => t.identifier === g.id) || null;
  }
  onTouchMove(e) {
    const t = this.touchOf(e);
    if (!t) return;
    this.moveTo(t.clientX, t.clientY);
    if (this.gesture?.phase === 'drag') e.preventDefault();     // selecionando: a página não rola
  }
  onTouchEnd(e, cancel = false) {
    const t = this.touchOf(e);
    if (!t) return;
    const wasDrag = this.gesture.phase === 'drag';
    this.finish(cancel);
    if (wasDrag) e.preventDefault();                             // sem clique sintético após selecionar
  }
}
