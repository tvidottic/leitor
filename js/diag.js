// Modo de diagnóstico (abra o app com ?diag): mostra, na tela, o ambiente e os eventos de toque/ponteiro
// recebidos pelo visualizador, além de erros. Serve para investigar problemas em aparelhos específicos.

import { el, copyText, toast } from './utils.js';

export function startDiag(reader) {
  const pre = el('pre', { class: 'diag-log' });
  const box = el('div', { class: 'diag' },
    el('div', { class: 'diag-bar' },
      el('strong', { text: 'Diagnóstico' }),
      el('button', { class: 'btn small ghost', text: 'Copiar', onclick: () => { copyText(pre.textContent); toast('Diagnóstico copiado.'); } }),
      el('button', { class: 'btn small ghost', text: 'Limpar', onclick: () => { lines.length = 0; render(); } }),
      el('button', { class: 'btn small ghost', text: 'Fechar', onclick: () => box.remove() })),
    pre);
  document.body.append(box);

  const lines = [];
  const t0 = performance.now();
  const render = () => { pre.textContent = lines.join('\n'); pre.scrollTop = 1e9; };
  const log = (s) => { lines.push(`${((performance.now() - t0) / 1000).toFixed(1)} ${s}`); if (lines.length > 80) lines.shift(); render(); };
  const mq = (q) => (matchMedia(q).matches ? 'sim' : 'não');
  const desc = (t) => { if (!t || !t.tagName) return '?'; const cls = String(t.className || '').split(' ').filter(Boolean).slice(0, 2).join('.'); return `${t.tagName.toLowerCase()}${cls ? '.' + cls : ''}`; };

  log(`UA: ${navigator.userAgent}`);
  log(`tela ${window.innerWidth}×${window.innerHeight} dpr ${devicePixelRatio} escala ${window.visualViewport?.scale ?? '?'}`);
  log(`pointer coarse: ${mq('(pointer: coarse)')} | any coarse: ${mq('(any-pointer: coarse)')} | hover: ${mq('(hover: hover)')} | toques: ${navigator.maxTouchPoints}`);
  log(`caretPositionFromPoint: ${!!document.caretPositionFromPoint} | caretRangeFromPoint: ${!!document.caretRangeFromPoint} | PointerEvent: ${!!window.PointerEvent} | TouchEvent: ${'ontouchstart' in window}`);
  log(`seleção própria: ${reader.customSel.enabled ? 'ativa' : 'inativa'} | modo: ${reader.viewer.pageMode} | zoom ${reader.viewer.zoomMode} | caneta vista: ${reader.ink.penSeen}`);

  window.addEventListener('error', (e) => log(`ERRO ${e.message} @${(e.filename || '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => log(`ERRO (promise) ${e.reason?.message || e.reason}`));

  const c = reader.container;
  let moves = 0;
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) {
    c.addEventListener(type, (e) => { log(`${type} ${e.pointerType} btn${e.button} ${Math.round(e.clientX)},${Math.round(e.clientY)} → ${desc(e.target)}${moves ? ` (${moves} moves)` : ''}`); moves = 0; }, true);
  }
  c.addEventListener('pointermove', (e) => { if (e.buttons) moves++; }, true);
  for (const type of ['touchstart', 'touchend', 'touchcancel']) {
    c.addEventListener(type, (e) => log(`${type} toques=${e.touches.length} → ${desc(e.target)}${e.defaultPrevented ? ' (prevenido)' : ''}`), true);
  }
  c.addEventListener('contextmenu', (e) => log(`contextmenu → ${desc(e.target)}`), true);
  c.addEventListener('click', (e) => log(`click → ${desc(e.target)}`), true);
  reader.customSel.addEventListener('start', () => log('seleção: início'));
  reader.customSel.addEventListener('end', () => log(`seleção: fim "${reader.customSel.shim().toString().slice(0, 30)}"`));
  reader.customSel.addEventListener('clear', () => log('seleção: limpa'));
  reader.ink.addEventListener('penseen', () => log('caneta detectada'));
  reader.ann.addEventListener('change', () => log(`anotações: ${reader.ann.items.length}`));
  reader.sync.addEventListener('status', (e) => log(`gravação: ${e.detail.status} ${e.detail.message || ''}`));
  document.addEventListener('selectionchange', () => { const s = window.getSelection(); if (s && !s.isCollapsed) log(`seleção NATIVA: "${s.toString().slice(0, 30)}"`); });
}
