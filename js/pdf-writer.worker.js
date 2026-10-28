// Worker: grava destaques, sublinhados, riscados e traços de caneta dentro do PDF (anotações padrão PDF),
// com aparência (/AP) própria para que qualquer leitor (Acrobat, Chrome, Preview, Edge...) as exiba.

import { PDFDocument, PDFName, PDFArray, PDFDict, PDFString, PDFHexString, PDFRef } from './vendor/pdf-lib.esm.min.js';

const MARKUP = new Set(['/Highlight', '/Underline', '/StrikeOut', '/Squiggly', '/Ink']);

const COLORS = {
  yellow: [1, 0.878, 0.4], green: [0.608, 0.89, 0.541], blue: [0.62, 0.773, 1], pink: [1, 0.651, 0.788],
  black: [0.1, 0.1, 0.1], red: [0.85, 0.2, 0.2], 'ink-blue': [0.15, 0.35, 0.9], 'ink-green': [0.1, 0.6, 0.3],
};
const UNDERLINE_COLORS = { yellow: [0.83, 0.66, 0], green: [0.23, 0.62, 0.17], blue: [0.17, 0.42, 0.84], pink: [0.84, 0.27, 0.5] };

function rgb(a) { return a.map(n => Math.round(n * 1000) / 1000); }
function num(n) { return Math.round(n * 100) / 100; }

self.onmessage = async (e) => {
  const { id, bytes, annotations, author } = e.data;
  try {
    const out = await writeAnnotations(bytes, annotations, author || 'Leitor');
    self.postMessage({ id, ok: true, bytes: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
};

async function writeAnnotations(bytes, annotations, author) {
  const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  if (pdfDoc.isEncrypted) throw new Error('PDF protegido por senha: as anotações ficam salvas apenas no aplicativo.');
  const ctx = pdfDoc.context;
  const pages = pdfDoc.getPages();
  const byPage = new Map();
  for (const a of annotations) {
    if (!byPage.has(a.page)) byPage.set(a.page, []);
    byPage.get(a.page).push(a);
  }

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const list = byPage.get(i + 1) || [];
    const existing = page.node.Annots();
    const kept = [];
    const removedRefs = new Set();
    if (existing) {
      // 1ª passagem: remove anotações de marcação (serão regravadas a partir da lista atual)
      for (const el of existing.asArray()) {
        const dict = ctx.lookup(el);
        if (!(dict instanceof PDFDict)) { kept.push(el); continue; }
        const sub = dict.get(PDFName.of('Subtype'));
        const subName = sub ? sub.toString() : '';
        if (MARKUP.has(subName)) { if (el instanceof PDFRef) removedRefs.add(el.toString()); continue; }
        kept.push(el);
      }
      // 2ª passagem: remove popups órfãos
      const kept2 = [];
      for (const el of kept) {
        const dict = ctx.lookup(el);
        if (dict instanceof PDFDict && dict.get(PDFName.of('Subtype'))?.toString() === '/Popup') {
          const parent = dict.get(PDFName.of('Parent'));
          if (parent instanceof PDFRef && removedRefs.has(parent.toString())) continue;
        }
        kept2.push(el);
      }
      kept.length = 0; kept.push(...kept2);
    }
    if (!list.length && !existing) continue;
    const annots = ctx.obj(kept);
    for (const a of list) {
      const ref = buildAnnotation(pdfDoc, page, a, author);
      if (ref) annots.push(ref);
    }
    page.node.set(PDFName.of('Annots'), annots);
  }
  return await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

function buildAnnotation(pdfDoc, page, a, author) {
  const ctx = pdfDoc.context;
  const now = new Date();
  const base = {
    Type: 'Annot',
    P: page.ref,
    F: 4,
    NM: PDFString.of(`leitor-${a.id}`),
    T: PDFHexString.fromText(a.author || author),
    M: PDFString.fromDate(a.updatedAt ? new Date(a.updatedAt) : now),
    CreationDate: PDFString.fromDate(a.createdAt ? new Date(a.createdAt) : now),
    CA: 1,
  };
  if (a.note) base.Contents = PDFHexString.fromText(a.note);

  if (a.type === 'ink') return buildInk(pdfDoc, a, base);
  if (!a.rects?.length) return null;

  const rects = a.rects.map(r => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]);
  const bbox = [Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])), Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3]))].map(num);
  const quads = [];
  for (const [x1, y1, x2, y2] of rects) quads.push(x1, y2, x2, y2, x1, y1, x2, y1); // sup-esq, sup-dir, inf-esq, inf-dir
  const subtype = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut' }[a.type] || 'Highlight';
  const color = subtype === 'Highlight' ? (COLORS[a.color] || COLORS.yellow) : (UNDERLINE_COLORS[a.color] || UNDERLINE_COLORS.blue);

  // aparência
  const ops = [];
  if (subtype === 'Highlight') {
    ops.push('/GS gs', `${rgb(color).join(' ')} rg`);
    for (const [x1, y1, x2, y2] of rects) ops.push(`${num(x1)} ${num(y1)} ${num(x2 - x1)} ${num(y2 - y1)} re f`);
  } else {
    ops.push('/GS gs', `${rgb(color).join(' ')} RG`, '1.2 w');
    for (const [x1, y1, x2, y2] of rects) {
      const y = subtype === 'Underline' ? y1 + 1.2 : (y1 + y2) / 2;
      ops.push(`${num(x1)} ${num(y)} m ${num(x2)} ${num(y)} l S`);
    }
  }
  const apRef = makeAppearance(pdfDoc, ops.join('\n'), bbox, subtype === 'Highlight' ? 'Multiply' : 'Normal');
  const dict = ctx.obj({
    ...base,
    Subtype: subtype,
    Subj: subtype,
    Rect: bbox,
    QuadPoints: quads.map(num),
    C: rgb(color),
    AP: { N: apRef },
  });
  return ctx.register(dict);
}

function buildInk(pdfDoc, a, base) {
  const ctx = pdfDoc.context;
  const paths = (a.paths || []).filter(p => p.length >= 2);
  if (!paths.length) return null;
  const width = a.width || 2;
  const color = COLORS[a.color] || COLORS.black;
  const xs = [], ys = [];
  for (const p of paths) for (let i = 0; i < p.length; i += 2) { xs.push(p[i]); ys.push(p[i + 1]); }
  const pad = width;
  const bbox = [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad].map(num);
  const ops = ['/GS gs', `${rgb(color).join(' ')} RG`, `${num(width)} w 1 J 1 j`];
  for (const p of paths) {
    ops.push(`${num(p[0])} ${num(p[1])} m`);
    if (p.length === 2) ops.push(`${num(p[0])} ${num(p[1])} l`);
    for (let i = 2; i < p.length; i += 2) ops.push(`${num(p[i])} ${num(p[i + 1])} l`);
    ops.push('S');
  }
  const apRef = makeAppearance(pdfDoc, ops.join('\n'), bbox, 'Normal');
  const dict = ctx.obj({
    ...base,
    Subtype: 'Ink',
    Subj: 'Ink',
    Rect: bbox,
    InkList: paths.map(p => p.map(num)),
    C: rgb(color),
    BS: { W: num(width), S: 'S' },
    AP: { N: apRef },
  });
  return ctx.register(dict);
}

function makeAppearance(pdfDoc, content, bbox, blend) {
  const ctx = pdfDoc.context;
  const gs = ctx.obj({ Type: 'ExtGState', BM: blend, CA: 1, ca: 1 });
  const stream = ctx.stream(content, {
    Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: bbox,
    Resources: { ExtGState: { GS: gs } },
  });
  return ctx.register(stream);
}
