// Anotações: destaques, sublinhados, riscados, notas e traços de caneta.
// Coordenadas em espaço do PDF (pontos, origem no canto inferior esquerdo), compatíveis com o padrão PDF.
//   rects: [[x1,y1,x2,y2], ...]   paths (caneta): [[x,y,x,y,...], ...]

import { db } from './db.js';
import { el, icon, uid, normalizeText } from './utils.js';

export const COLORS = ['yellow', 'green', 'blue', 'pink'];
export const INK_COLORS = ['black', 'red', 'ink-blue', 'ink-green'];
const MARKUP_SUBTYPES = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'underline', Ink: 'ink' };

export class AnnotationManager extends EventTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.bookId = null;
    this.items = [];
    this.dirty = false;
    viewer.addEventListener('pagerendered', (e) => this.renderPage(e.detail.page));
  }

  async load(bookId) {
    this.bookId = bookId;
    this.items = await db.byIndex('annotations', 'bookId', bookId);
    await this.migrate();
    this.sort();
    this.emit();
  }

  /** Converte registros antigos (coordenadas de tela na escala 1) para o espaço do PDF. */
  async migrate() {
    const old = this.items.filter(a => a.v !== 2);
    if (!old.length) return;
    for (const a of old) {
      try {
        const page = await this.viewer.pdf.getPage(a.page);
        const vp = page.getViewport({ scale: 1 });
        a.rects = (a.rects || []).map(r => {
          const [x1, y1] = vp.convertToPdfPoint(r.x, r.y);
          const [x2, y2] = vp.convertToPdfPoint(r.x + r.w, r.y + r.h);
          return norm([x1, y1, x2, y2]);
        });
      } catch { a.rects = []; }
      a.v = 2; a.source = a.source || 'leitor';
    }
    await db.putMany('annotations', old);
  }

  sort() { this.items.sort((a, b) => a.page - b.page || (topOf(b) - topOf(a))); }
  emit(changed = true) {
    if (changed) this.dirty = true;
    this.dispatchEvent(new CustomEvent('change', { detail: { items: this.items } }));
  }

  byPage(page) { return this.items.filter(a => a.page === page); }
  get(id) { return this.items.find(a => a.id === id); }

  // ------------------------------------------------------------ importação de anotações do próprio PDF
  /** Lê destaques/sublinhados/tinta existentes no PDF (feitos em outros aplicativos) e os incorpora. */
  async importFromPdf(onProgress) {
    const pdf = this.viewer.pdf;
    if (!pdf) return 0;
    const knownRefs = new Set(this.items.map(a => a.pdfRef).filter(Boolean));
    const added = [];
    const isDuplicate = (rec) => this.items.some(a => a.page === rec.page && a.type === rec.type && sameGeometry(a, rec));
    for (let n = 1; n <= pdf.numPages; n++) {
      if (this.viewer.pdf !== pdf) return added.length;
      let annots;
      try { annots = await (await pdf.getPage(n)).getAnnotations(); } catch { continue; }
      for (const d of annots) {
        const type = MARKUP_SUBTYPES[d.subtype];
        if (!type) continue;
        if (knownRefs.has(d.id)) continue;
        const rec = {
          id: uid(), v: 2, bookId: this.bookId, page: n, type,
          color: nearestColor(d.color, type === 'ink'),
          rects: [], paths: [], width: d.borderStyle?.width || 2,
          text: '', note: d.contentsObj?.str?.trim() || '',
          author: d.titleObj?.str || '',
          source: 'pdf', pdfRef: d.id, hasAppearance: !!d.hasAppearance,
          createdAt: parsePdfDate(d.creationDate) || Date.now(), updatedAt: parsePdfDate(d.modificationDate) || Date.now(),
        };
        if (type === 'ink') {
          rec.paths = (d.inkLists || []).map(l => Array.from(l));
          if (!rec.paths.length) continue;
        } else {
          const q = d.quadPoints;
          if (q && q.length >= 8) {
            for (let i = 0; i < q.length; i += 8) rec.rects.push(norm([q[i], q[i + 5], q[i + 2], q[i + 1]]));
          } else if (d.rect) rec.rects.push(norm(d.rect));
          if (!rec.rects.length) continue;
        }
        if (isDuplicate(rec)) {
          // já temos este registro (gravado por nós anteriormente): só vincula ao objeto do PDF
          const mine = this.items.find(a => a.page === rec.page && a.type === rec.type && sameGeometry(a, rec));
          mine.pdfRef = d.id; mine.hasAppearance = !!d.hasAppearance; mine.modified = false;
          continue;
        }
        if (type !== 'ink') rec.text = await this.textForRects(n, rec.rects).catch(() => '');
        added.push(rec);
        knownRefs.add(d.id);
      }
      onProgress?.(n, pdf.numPages);
    }
    if (added.length) {
      this.items.push(...added);
      this.sort();
      await db.putMany('annotations', added);
      for (const p of new Set(added.map(a => a.page))) this.renderPage(p);
      this.emit(false);
    }
    return added.length;
  }

  /** Texto aproximado coberto por retângulos (espaço PDF) usando o conteúdo de texto da página. */
  async textForRects(page, rects) {
    const { items } = await this.viewer.getPageText(page);
    const parts = [];
    for (const it of items) {
      if (!('str' in it) || !it.str.trim()) continue;
      const x = it.transform[4], y = it.transform[5], h = it.height || 8, w = it.width || 0;
      const cx = x + w / 2, cy = y + h / 2;
      for (const [x1, y1, x2, y2] of rects) {
        if (cx >= x1 - 1 && cx <= x2 + 1 && cy >= y1 - 1 && cy <= y2 + 1) { parts.push(it.str); break; }
        // item parcialmente coberto: pega a fatia proporcional
        if (cy >= y1 - 1 && cy <= y2 + 1 && x < x2 && x + w > x1 && w > 0) {
          const f0 = Math.max(0, (x1 - x) / w), f1 = Math.min(1, (x2 - x) / w);
          const s = it.str.slice(Math.floor(f0 * it.str.length), Math.ceil(f1 * it.str.length));
          if (s.trim()) parts.push(s);
          break;
        }
      }
    }
    return normalizeText(parts.join(' '));
  }

  // ------------------------------------------------------------ criação a partir da seleção
  /** Converte a seleção atual em [{page, rects(PDF), text}]; pode abranger várias páginas. */
  selectionToPageRects(selection) {
    if (!selection || selection.isCollapsed || !selection.rangeCount) return [];
    const range = selection.getRangeAt(0);
    const pagesInRange = new Map();
    for (const pd of this.viewer.viewerEl.querySelectorAll('.page')) {
      if (!pd.querySelector('.textLayer')?.childElementCount) continue;
      if (!range.intersectsNode(pd)) continue;
      const num = parseInt(pd.dataset.page, 10);
      pagesInRange.set(pd, { num, rect: pd.getBoundingClientRect(), rects: [] });
    }
    if (!pagesInRange.size) return [];
    for (const cr of Array.from(range.getClientRects())) {
      if (cr.width < 1 || cr.height < 1) continue;
      const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
      for (const info of pagesInRange.values()) {
        const r = info.rect;
        if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
          info.rects.push({ x: cr.left - r.left, y: cr.top - r.top, w: cr.width, h: cr.height });
          break;
        }
      }
    }
    const out = [];
    for (const info of pagesInRange.values()) {
      if (!info.rects.length) continue;
      const merged = mergeRects(info.rects);
      const rects = merged.map(r => this.viewer.viewRectToPdf(info.num, r));
      out.push({ page: info.num, rects, text: textForPage(range, info.num) });
    }
    return out;
  }

  async addFromSelection(selection, opts = {}) {
    const parts = this.selectionToPageRects(selection);
    if (!parts.length) return [];
    return this.addFromParts(parts, normalizeText(selection.toString()), opts);
  }

  /** Cria anotações a partir de partes {page, rects, text} calculadas antes (a seleção pode já ter sido limpa). */
  async addFromParts(parts, fullText, { type = 'highlight', color = 'yellow', note = '' } = {}) {
    if (!parts?.length) return [];
    const groupId = parts.length > 1 ? uid() : null;
    const created = parts.map(part => ({
      id: uid(), v: 2, bookId: this.bookId, page: part.page, type, color, rects: part.rects, paths: [],
      text: parts.length === 1 ? fullText : (part.text || fullText), note, groupId, source: 'leitor',
      createdAt: Date.now(), updatedAt: Date.now(),
    }));
    return this.addMany(created);
  }

  async addInk(page, paths, { color = 'black', width = 2 } = {}) {
    const ann = { id: uid(), v: 2, bookId: this.bookId, page, type: 'ink', color, width, paths, rects: [], text: '', note: '', source: 'leitor', createdAt: Date.now(), updatedAt: Date.now() };
    return (await this.addMany([ann]))[0];
  }

  async addMany(list) {
    this.items.push(...list);
    this.sort();
    await db.putMany('annotations', list);
    for (const p of new Set(list.map(a => a.page))) this.renderPage(p);
    this.emit();
    return list;
  }

  async update(id, patch) {
    const ann = this.get(id);
    if (!ann) return;
    Object.assign(ann, patch, { updatedAt: Date.now() });
    if (ann.hasAppearance) this.needsReload = true; // o canvas ainda mostra a aparência antiga
    await db.put('annotations', ann);
    this.renderPage(ann.page);
    this.emit();
    return ann;
  }

  async remove(id) {
    const ann = this.get(id);
    if (!ann) return;
    const ids = ann.groupId ? this.items.filter(a => a.groupId === ann.groupId).map(a => a.id) : [id];
    const pages = new Set(this.items.filter(a => ids.includes(a.id)).map(a => a.page));
    if (this.items.some(a => ids.includes(a.id) && a.hasAppearance)) this.needsReload = true;
    this.items = this.items.filter(a => !ids.includes(a.id));
    await db.delMany('annotations', ids);
    for (const p of pages) this.renderPage(p);
    this.emit();
  }

  /** Marca que o conteúdo do PDF já reflete as anotações atuais (após gravar no arquivo). */
  markSaved() { this.dirty = false; }

  // ------------------------------------------------------------ renderização
  renderPage(page) {
    const p = this.viewer.getPage(page);
    if (!p || (!p.rendered && !p.rendering)) return;
    const anns = this.byPage(page);
    const frag = document.createDocumentFragment();
    const noteFrag = document.createDocumentFragment();
    const svgNS = 'http://www.w3.org/2000/svg';
    let svg = null;
    for (const a of anns) {
      // anotações que o documento carregado já desenha no canvas (aparência própria) não ganham sobreposição
      const drawn = a.hasAppearance && !a.modified;
      if (a.type === 'ink') {
        if (!drawn) {
          if (!svg) { svg = document.createElementNS(svgNS, 'svg'); svg.setAttribute('class', 'ink-svg'); svg.setAttribute('width', p.width); svg.setAttribute('height', p.height); }
          for (const path of a.paths) {
            const pts = [];
            for (let i = 0; i < path.length; i += 2) { const [vx, vy] = this.viewer.pdfPointToView(page, path[i], path[i + 1]); pts.push(`${vx.toFixed(1)},${vy.toFixed(1)}`); }
            const pl = document.createElementNS(svgNS, 'polyline');
            pl.setAttribute('points', pts.join(' '));
            pl.setAttribute('class', `ink ${a.color}`);
            pl.setAttribute('stroke-width', (a.width || 2) * this.viewer.scale);
            pl.dataset.id = a.id;
            svg.append(pl);
          }
        }
        continue;
      }
      for (const r of a.rects) {
        const v = this.viewer.pdfRectToView(page, r);
        if (!drawn) frag.append(el('div', { class: `ann ${a.type} ${a.color}`, dataset: { id: a.id }, style: { left: `${v.x}px`, top: `${v.y}px`, width: `${v.w}px`, height: `${v.h}px` } }));
      }
      if (a.note && a.rects.length) {
        const v = this.viewer.pdfRectToView(page, a.rects[0]);
        noteFrag.append(el('button', { class: 'note-pin', dataset: { id: a.id }, title: a.note, style: { left: `${v.x + v.w}px`, top: `${v.y}px` } }, icon('note')));
      }
    }
    if (svg) frag.append(svg);
    p.annLayer.replaceChildren(frag);
    p.noteLayer.replaceChildren(noteFrag);
  }

  /** Anotação sob um ponto (coordenadas PDF). */
  hitTest(page, x, y) {
    const pad = 2;
    for (const a of this.byPage(page).slice().reverse()) {
      if (a.type === 'ink') {
        for (const path of a.paths) for (let i = 0; i < path.length; i += 2) if (Math.hypot(path[i] - x, path[i + 1] - y) < (a.width || 2) + 4) return a;
        continue;
      }
      for (const [x1, y1, x2, y2] of a.rects) if (x >= x1 - pad && x <= x2 + pad && y >= y1 - pad && y <= y2 + pad) return a;
    }
    return null;
  }

  flash(id) {
    const a = this.get(id);
    if (!a) return;
    const p = this.viewer.getPage(a.page);
    p?.annLayer.querySelectorAll(`.ann[data-id="${id}"], polyline[data-id="${id}"]`).forEach(d => { d.classList.remove('flash'); void d.getBoundingClientRect(); d.classList.add('flash'); });
  }

  toMarkdown(bookTitle) {
    const lines = [`# ${bookTitle}`, '', `_Exportado em ${new Date().toLocaleString()}_`, ''];
    let page = null;
    for (const a of this.items) {
      if (a.type === 'ink' && !a.note) continue;
      if (a.page !== page) { page = a.page; lines.push(`## Página ${page}`, ''); }
      const tag = { underline: 'sublinhado', strikeout: 'riscado', ink: 'caneta' }[a.type] || `destaque ${a.color}`;
      if (a.text) lines.push(`> ${a.text.replace(/\n/g, ' ')}`, `> — _${tag}_`);
      if (a.note) lines.push('', `**Nota:** ${a.note}`);
      lines.push('');
    }
    return lines.join('\n');
  }
}

// ------------------------------------------------------------ utilitários
const norm = ([x1, y1, x2, y2]) => [r2(Math.min(x1, x2)), r2(Math.min(y1, y2)), r2(Math.max(x1, x2)), r2(Math.max(y1, y2))];
const r2 = n => Math.round(n * 100) / 100;
const topOf = (a) => a.type === 'ink' ? (a.paths[0]?.[1] ?? 0) : (a.rects[0]?.[3] ?? 0);

function sameGeometry(a, b, tol = 1) {
  if (a.type === 'ink') {
    if (a.paths.length !== b.paths.length) return false;
    return a.paths.every((p, i) => p.length === b.paths[i].length && Math.abs(p[0] - b.paths[i][0]) < tol && Math.abs(p[1] - b.paths[i][1]) < tol && Math.abs(p[p.length - 1] - b.paths[i][p.length - 1]) < tol);
  }
  if (a.rects.length !== b.rects.length) return false;
  const sa = a.rects.slice().sort((r, s) => s[3] - r[3] || r[0] - s[0]);
  const sb = b.rects.slice().sort((r, s) => s[3] - r[3] || r[0] - s[0]);
  return sa.every((r, i) => r.every((v, j) => Math.abs(v - sb[i][j]) < tol));
}

function parsePdfDate(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  return new Date(+m[1], (+m[2] || 1) - 1, +m[3] || 1, +m[4] || 0, +m[5] || 0, +m[6] || 0).getTime();
}

function nearestColor(c, ink) {
  if (!c || c.length < 3) return ink ? 'black' : 'yellow';
  const [r, g, b] = [c[0] / 255, c[1] / 255, c[2] / 255];
  const palette = ink
    ? { black: [0.1, 0.1, 0.1], red: [0.85, 0.2, 0.2], 'ink-blue': [0.15, 0.35, 0.9], 'ink-green': [0.1, 0.6, 0.3] }
    : { yellow: [1, 0.88, 0.4], green: [0.6, 0.89, 0.54], blue: [0.62, 0.77, 1], pink: [1, 0.65, 0.79] };
  let best = null, bd = Infinity;
  for (const [name, [pr, pg, pb]] of Object.entries(palette)) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < bd) { bd = d; best = name; }
  }
  return best;
}

/** Funde retângulos (coordenadas de tela) sobrepostos na mesma linha. */
export function mergeRects(rects) {
  const sorted = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.y - r.y) < Math.max(last.h, r.h) * 0.5 && r.x <= last.x + last.w + 3) {
      const x1 = Math.min(last.x, r.x), x2 = Math.max(last.x + last.w, r.x + r.w);
      const y1 = Math.min(last.y, r.y), y2 = Math.max(last.y + last.h, r.y + r.h);
      last.x = x1; last.w = x2 - x1; last.y = y1; last.h = y2 - y1;
    } else out.push({ ...r });
  }
  return out.filter((r, i) => !out.some((o, j) => j !== i && o.x <= r.x + 1 && o.y <= r.y + 1 && o.x + o.w >= r.x + r.w - 1 && o.y + o.h >= r.y + r.h - 1 && (o.w * o.h > r.w * r.h)));
}

function textForPage(range, num) {
  try {
    const pd = [...document.querySelectorAll('.page')].find(d => parseInt(d.dataset.page, 10) === num);
    const tl = pd?.querySelector('.textLayer');
    if (!tl) return '';
    const r = range.cloneRange();
    if (!tl.contains(r.startContainer)) r.setStart(tl, 0);
    if (!tl.contains(r.endContainer)) r.setEnd(tl, tl.childNodes.length);
    return normalizeText(r.toString());
  } catch { return ''; }
}
