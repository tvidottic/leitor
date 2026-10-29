// Ferramenta de caneta: desenho à mão livre sobre a página, gravado como anotação /Ink no PDF.
//
// A camada de tinta tem touch-action: none, então o navegador nunca rola nem cancela o traço
// (no Chrome para Android, qualquer rolagem iniciada pelo navegador dispara pointercancel). No modo
// "só caneta", o dedo rola a página por conta própria (com inércia) e só a caneta desenha.

import { el } from './utils.js';
import { INK_COLORS } from './annotations.js';

const SVG = 'http://www.w3.org/2000/svg';
export const INK_WIDTHS = { fina: 1.5, media: 3, grossa: 6 };

export class InkTool extends EventTarget {
  constructor(viewer, ann) {
    super();
    this.viewer = viewer;
    this.ann = ann;
    this.active = false;
    this.color = INK_COLORS[0];
    this.width = 'media';
    this.eraser = false;
    this.penOnlyMode = 'auto';   // 'auto' (só caneta quando uma caneta foi detectada) | 'on' | 'off'
    this.penSeen = false;
    this.stroke = null;
    this.pan = null;
    this.panRaf = 0;
    viewer.addEventListener('pagerendered', (e) => { if (this.active) this.attach(this.viewer.getPage(e.detail.page)); });
    viewer.container.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'pen' && !this.penSeen) { this.penSeen = true; this.applyTouchAction(); this.dispatchEvent?.(new Event('penseen')); }
    }, true);
    // no Android, o toque longo abriria o menu de contexto e cancelaria o traço
    viewer.container.addEventListener('contextmenu', (e) => { if (this.active) e.preventDefault(); });
  }

  get penOnly() { return this.penOnlyMode === 'on' || (this.penOnlyMode === 'auto' && this.penSeen); }
  set penOnly(v) { this.penOnlyMode = v ? 'on' : 'off'; this.applyTouchAction(); }
  applyTouchAction() { this.viewer.container.classList.toggle('pen-only', this.penOnly); }

  setActive(on) {
    this.active = !!on;
    this.viewer.inkActive = this.active;
    this.viewer.container.classList.toggle('inking', this.active);
    this.stroke = null; this.pan = null; cancelAnimationFrame(this.panRaf);
    for (const p of this.viewer.pages) {
      if (this.active && (p.rendered || p.rendering)) this.attach(p);
      else { p.inkLayer.hidden = true; p.inkLayer.replaceChildren(); }
    }
  }

  attach(p) {
    if (!p) return;
    p.inkLayer.hidden = false;
    if (p.inkLayer.dataset.bound) return;
    p.inkLayer.dataset.bound = '1';
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'ink-live');
    p.inkLayer.append(svg);
    p.inkLayer.addEventListener('pointerdown', (e) => this.onDown(e, p, svg));
    p.inkLayer.addEventListener('pointermove', (e) => this.onMove(e, p));
    p.inkLayer.addEventListener('pointerup', (e) => this.onUp(e, p));
    p.inkLayer.addEventListener('pointercancel', (e) => this.onUp(e, p, true));
    // os eventos de toque não têm função aqui: evitam apenas seleção, menus e cliques sintéticos
    const stop = (e) => { if (e.cancelable) e.preventDefault(); };
    p.inkLayer.addEventListener('touchstart', stop, { passive: false });
    p.inkLayer.addEventListener('touchmove', stop, { passive: false });
    p.inkLayer.addEventListener('touchend', stop, { passive: false });
  }

  onDown(e, p, svg) {
    if (!this.active || e.button > 0) return;
    e.preventDefault();
    if (this.penOnly && e.pointerType === 'touch') { this.startPan(e, p); return; }
    if (this.stroke) return;
    if (this.eraser) { this.eraseAt(e, p); return; }
    try { p.inkLayer.setPointerCapture(e.pointerId); } catch { /* alguns navegadores/eventos sintéticos */ }
    const r = p.div.getBoundingClientRect();
    const pl = document.createElementNS(SVG, 'polyline');
    pl.setAttribute('class', `ink ${this.color}`);
    pl.setAttribute('stroke-width', INK_WIDTHS[this.width] * this.viewer.scale);
    svg.append(pl);
    this.stroke = { pointerId: e.pointerId, pts: [[e.clientX - r.left, e.clientY - r.top]], pl, rect: r, page: p.num };
    this.updatePolyline();
  }
  onMove(e, p) {
    if (this.pan && e.pointerId === this.pan.id) { this.movePan(e); return; }
    if (!this.stroke || e.pointerId !== this.stroke.pointerId) {
      if (this.eraser && this.active && e.buttons && e.pointerType !== 'touch') this.eraseAt(e, p);
      else if (this.eraser && this.active && e.buttons && !this.penOnly) this.eraseAt(e, p);
      return;
    }
    e.preventDefault();
    const r = this.stroke.rect;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const pt = [ev.clientX - r.left, ev.clientY - r.top];
      const last = this.stroke.pts[this.stroke.pts.length - 1];
      if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= 1.2) this.stroke.pts.push(pt);
    }
    this.updatePolyline();
  }
  updatePolyline() {
    this.stroke.pl.setAttribute('points', this.stroke.pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
  }
  async onUp(e, p, cancel = false) {
    if (this.pan && e.pointerId === this.pan.id) { this.endPan(p); return; }
    const s = this.stroke;
    if (!s || e.pointerId !== s.pointerId) return;
    this.stroke = null;
    try { p.inkLayer.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    s.pl.remove();
    if (cancel) return;
    const pts = s.pts.length === 1 ? [s.pts[0], [s.pts[0][0] + 0.5, s.pts[0][1]]] : simplify(s.pts, 0.8);
    const r = s.rect;
    const path = [];
    for (const [x, y] of pts) { const { x: px, y: py } = this.viewer.clientToPdf(s.page, x + r.left, y + r.top); path.push(round(px), round(py)); }
    await this.ann.addInk(s.page, [path], { color: this.color, width: INK_WIDTHS[this.width] });
  }
  eraseAt(e, p) {
    const { x, y } = this.viewer.clientToPdf(p.num, e.clientX, e.clientY);
    const hit = this.ann.byPage(p.num).find(a => a.type === 'ink' && a.paths.some(path => { for (let i = 0; i < path.length; i += 2) if (Math.hypot(path[i] - x, path[i + 1] - y) < (a.width || 2) + 6 / this.viewer.scale) return true; return false; }));
    if (hit) this.ann.remove(hit.id);
  }

  // ---- rolagem com o dedo no modo "só caneta"
  startPan(e, p) {
    cancelAnimationFrame(this.panRaf);
    this.pan = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), vx: 0, vy: 0 };
    try { p.inkLayer.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  }
  movePan(e) {
    const c = this.viewer.container, pan = this.pan;
    const now = performance.now(), dt = Math.max(1, now - pan.t);
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    c.scrollLeft -= dx; c.scrollTop -= dy;
    pan.vx = 0.7 * pan.vx + 0.3 * (dx / dt); pan.vy = 0.7 * pan.vy + 0.3 * (dy / dt);
    pan.x = e.clientX; pan.y = e.clientY; pan.t = now;
  }
  endPan(p) {
    const c = this.viewer.container, pan = this.pan;
    this.pan = null;
    try { p.inkLayer.releasePointerCapture(pan.id); } catch { /* ignore */ }
    if (performance.now() - pan.t > 80) return;
    let vx = pan.vx, vy = pan.vy, last = performance.now();
    const step = (now) => {
      const dt = now - last; last = now;
      c.scrollLeft -= vx * dt; c.scrollTop -= vy * dt;
      vx *= Math.pow(0.95, dt / 16); vy *= Math.pow(0.95, dt / 16);
      if (Math.hypot(vx, vy) > 0.02) this.panRaf = requestAnimationFrame(step);
    };
    this.panRaf = requestAnimationFrame(step);
  }
}

const round = n => Math.round(n * 100) / 100;

/** Simplificação de Ramer–Douglas–Peucker. */
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const dmax = { d: 0, i: 0 };
  const [a, b] = [pts[0], pts[pts.length - 1]];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], a, b);
    if (d > dmax.d) { dmax.d = d; dmax.i = i; }
  }
  if (dmax.d > eps) {
    const left = simplify(pts.slice(0, dmax.i + 1), eps), right = simplify(pts.slice(dmax.i), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}
function perpDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (!len2) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
