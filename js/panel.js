// Painel de tradução: tradução rápida, dicionário, frase no contexto e explicação com IA.

import { $, el, icon, escapeHtml, mdToHtml, speak, toast, copyText, isSingleWord, wordCount, langName, LANGS } from './utils.js';
import { settings, saveSettings } from './db.js';
import { translate, englishDictionary, googleTranslateUrl, claudeExplain } from './translate.js';

export class TranslationPanel {
  constructor(reader) {
    this.reader = reader;
    this.el = $('#panel');
    this.body = $('#panel-body');
    this.tlSelect = $('#panel-tl');
    this.current = null;
    this.abort = null;

    for (const [code, name] of LANGS) this.tlSelect.append(el('option', { value: code, text: name }));
    this.tlSelect.value = settings().tl;
    this.tlSelect.addEventListener('change', async () => {
      await saveSettings({ tl: this.tlSelect.value });
      if (this.current) this.show(this.current, { force: true });
    });
    $('#btn-panel-close').addEventListener('click', () => this.hide());
  }

  get isOpen() { return !this.el.hidden; }
  open() { this.el.hidden = false; this.reader.layoutChanged(); }
  hide() { this.el.hidden = true; this.abort?.abort(); this.reader.layoutChanged(); }
  toggle() { this.isOpen ? this.hide() : this.open(); }

  /**
   * Mostra a tradução de um trecho.
   * @param {{text:string, page:number, mode?:'quick'|'ai'}} req
   */
  async show(req, { force = false } = {}) {
    if (!req?.text?.trim()) return;
    const s = settings();
    this.tlSelect.value = s.tl;
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;
    const same = !force && this.current && this.current.text === req.text && this.current.page === req.page;
    this.current = { ...req };
    this.open();

    const text = req.text.trim();
    const single = isSingleWord(text);
    const tl = s.tl, sl = s.sl;

    // estrutura
    const origBlock = el('div', { class: 'tr-block' },
      el('div', { class: 'tr-label' }, 'Original ', el('span', { class: 'lang-badge', id: 'tr-src-badge', text: sl === 'auto' ? '…' : sl }),
        el('button', { class: 'btn ghost', title: 'Ouvir', onclick: () => speak(text, this.current.src || (sl !== 'auto' ? sl : 'en')) }, icon('speaker'))),
      el('div', { class: 'tr-orig', text: text }),
    );
    const mainBlock = el('div', { class: 'tr-block' },
      el('div', { class: 'tr-label' }, `Tradução (${langName(tl)})`,
        el('button', { class: 'btn ghost', title: 'Copiar tradução', onclick: () => { if (this.current?.translation) { copyText(this.current.translation); toast('Tradução copiada.'); } } }, icon('copy'))),
      el('div', { class: 'tr-main', id: 'tr-main' }, el('span', { class: 'spinner inline-spinner' })),
    );
    const dictBlock = el('div', { class: 'tr-block', id: 'tr-dict', hidden: true });
    const ctxBlock = el('div', { class: 'tr-block', id: 'tr-ctx' });
    const aiBlock = el('div', { class: 'tr-block', id: 'tr-ai' });
    const wikiBlock = el('div', { class: 'tr-block', id: 'tr-wiki', hidden: true });
    const actions = el('div', { class: 'tr-actions' },
      req.parts?.length ? el('button', { class: 'btn', title: 'Destacar este trecho na página', onclick: async (e) => { const btn = e.currentTarget; const cur = this.current; const created = await this.reader.ann.addFromParts(cur.parts, cur.text, { type: 'highlight', color: this.reader.lastColor }); if (created[0]) { cur.annId = created[0].id; cur.parts = null; btn.remove(); toast('Trecho destacado.'); } } }, icon('highlight'), 'Destacar') : null,
      el('button', { class: 'btn', onclick: () => this.reader.saveSelectionToVocab(this.current) }, icon('star'), single || wordCount(text) <= 4 ? 'Salvar no vocabulário' : 'Salvar expressão'),
      wordCount(text) <= 6 ? el('button', { class: 'btn', title: 'Consultar na Wikipédia (nomes, lugares, conceitos)', onclick: () => this.runWiki(wikiBlock, text, ctrl.signal) }, icon('wiki'), 'Wikipédia') : null,
      el('a', { class: 'btn', href: googleTranslateUrl(text, { sl, tl }), target: '_blank', rel: 'noopener', title: 'Abrir no Google Tradutor' }, icon('external'), 'Google Tradutor'),
    );
    this.body.replaceChildren(origBlock, mainBlock, dictBlock, ctxBlock, aiBlock, wikiBlock, actions);
    this.body.scrollTop = 0;

    // botões de contexto e IA
    const ctxBtn = el('button', { class: 'btn', onclick: () => this.runSentenceContext(ctxBlock, ctrl.signal) }, icon('text'), 'Traduzir a frase inteira');
    ctxBlock.append(el('div', { class: 'tr-label' }, 'Contexto'), el('div', { class: 'tr-actions' }, ctxBtn));
    const aiBtn = el('button', { class: 'btn primary', onclick: () => this.runAi(aiBlock, ctrl.signal) }, icon('sparkle'), 'Explicar no contexto (IA)');
    aiBlock.append(el('div', { class: 'tr-label' }, 'Tradução contextual'), el('div', { class: 'tr-actions' }, aiBtn),
      el('p', { class: 'muted', style: { margin: 0, fontSize: '12.5px' } }, 'Tradução fiel ao contexto, com explicação de expressões idiomáticas, referências culturais e nuances.'));

    // tradução rápida
    try {
      const r = await translate(text, { sl, tl, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      this.current.translation = r.text;
      this.current.src = r.src;
      $('#tr-src-badge', origBlock).textContent = r.src || sl;
      const main = $('#tr-main', mainBlock);
      main.replaceChildren(document.createTextNode(r.text || ''));
      if (r.via === 'reserva') main.append(el('div', { class: 'muted', style: { fontSize: '12px', fontFamily: 'var(--font)' }, text: r.truncated ? 'Tradução parcial pelo serviço de reserva (Google indisponível). Abra no Google Tradutor para o texto completo.' : 'Traduzido pelo serviço de reserva (Google indisponível).' }));
      if (r.transliteration) main.append(el('div', { class: 'muted', style: { fontSize: '13px', fontFamily: 'var(--font)' }, text: r.transliteration }));
      this.renderDict(dictBlock, r, text, ctrl.signal);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      $('#tr-main', mainBlock).replaceChildren(el('span', { class: 'err', style: { color: 'var(--danger)' }, text: `Não foi possível traduzir: ${err.message}` }));
    }

    if (req.mode === 'ai' && !same) this.runAi(aiBlock, ctrl.signal);
  }

  async renderDict(block, r, text, signal) {
    const s = settings();
    const parts = [];
    if (r.dict?.length) {
      for (const d of r.dict) {
        parts.push(el('div', { class: 'dict-pos', text: d.pos }));
        parts.push(el('div', { class: 'dict-terms', text: d.terms.slice(0, 8).join(', ') }));
      }
    } else if (r.alternatives?.length) {
      parts.push(el('div', { class: 'dict-pos', text: 'alternativas' }), el('div', { class: 'dict-terms', text: r.alternatives.slice(0, 6).join(' · ') }));
    }
    if (r.definitions?.length) {
      for (const d of r.definitions.slice(0, 3)) {
        parts.push(el('div', { class: 'dict-pos', text: `${d.pos} — definições` }));
        parts.push(el('ul', { class: 'dict-def' }, d.entries.slice(0, 3).map(e => el('li', {}, e.gloss, e.example ? el('span', { class: 'ex', text: `“${e.example}”` }) : null))));
      }
    }
    if (parts.length) { block.hidden = false; block.replaceChildren(el('div', { class: 'tr-label' }, 'Dicionário'), ...parts); }

    if (s.dict && isSingleWord(text) && (r.src === 'en' || s.sl === 'en')) {
      const d = await englishDictionary(text, { signal }).catch(() => null);
      if (signal.aborted || !d) return;
      const head = el('div', { class: 'dict-phon' },
        el('strong', { text: d.word }),
        d.phonetic ? el('span', { text: d.phonetic }) : null,
        d.audio ? el('button', { class: 'btn ghost small', title: 'Pronúncia', onclick: () => new Audio(d.audio).play().catch(() => speak(d.word, 'en')) }, icon('speaker')) : null,
      );
      const meanings = d.meanings.map(m => el('div', {},
        el('div', { class: 'dict-pos', text: m.pos }),
        el('ul', { class: 'dict-def' }, m.defs.map(x => el('li', {}, x.def, x.ex ? el('span', { class: 'ex', text: `“${x.ex}”` }) : null))),
        m.synonyms.length ? el('div', { class: 'muted', style: { fontSize: '13px' }, text: `Sinônimos: ${m.synonyms.join(', ')}` }) : null,
      ));
      block.hidden = false;
      block.append(el('div', { class: 'tr-label', style: { marginTop: '8px' } }, 'Dicionário de inglês'), head, ...meanings);
    }
  }

  async runSentenceContext(block, signal) {
    const cur = this.current;
    if (!cur) return;
    const s = settings();
    const body = el('div', { class: 'tr-ctx' }, el('span', { class: 'spinner inline-spinner' }));
    block.replaceChildren(el('div', { class: 'tr-label' }, 'Frase no contexto'), body);
    try {
      const ctx = await this.reader.getSentenceContext(cur.page, cur.text);
      if (!ctx) { body.textContent = 'Não foi possível localizar a frase completa nesta página.'; return; }
      const r = await translate(ctx.sentence, { sl: s.sl, tl: s.tl, signal });
      if (signal.aborted) return;
      const origHtml = `${escapeHtml(ctx.sentence.slice(0, ctx.selStart))}<b>${escapeHtml(ctx.sentence.slice(ctx.selStart, ctx.selEnd))}</b>${escapeHtml(ctx.sentence.slice(ctx.selEnd))}`;
      let transHtml = escapeHtml(r.text);
      if (cur.translation && cur.translation.length > 1) {
        const re = new RegExp(cur.translation.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        transHtml = transHtml.replace(re, m => `<b>${m}</b>`);
      }
      body.replaceChildren(
        el('div', { class: 'tr-orig', html: origHtml }),
        el('div', { class: 'tr-ctx', style: { marginTop: '6px' }, html: transHtml }),
      );
    } catch (err) {
      if (err?.name === 'AbortError') return;
      body.textContent = `Falha: ${err.message}`;
    }
  }

  async runAi(block, signal) {
    const cur = this.current;
    if (!cur) return;
    const s = settings();
    if (!s.apiKey) {
      block.replaceChildren(
        el('div', { class: 'tr-label' }, 'Tradução contextual'),
        el('div', { class: 'ai-box' },
          el('p', {}, 'Para a tradução contextual com explicações, configure uma chave da API da Anthropic (Claude) nas configurações. Sem a chave, você ainda pode usar “Traduzir a frase inteira”, que mostra o trecho dentro da frase completa.'),
          el('div', { class: 'tr-actions' },
            el('button', { class: 'btn primary', onclick: () => this.reader.app.openSettings() }, icon('settings'), 'Configurar chave'),
            el('button', { class: 'btn', onclick: () => this.runSentenceContext($('#tr-ctx', this.body), signal) }, icon('text'), 'Traduzir a frase inteira'),
          ),
        ),
      );
      return;
    }
    const box = el('div', { class: 'ai-box streaming' }, el('span', { class: 'muted', text: 'Analisando o trecho no contexto…' }));
    const cancel = el('button', { class: 'btn ghost small', onclick: () => this.abort?.abort() }, icon('close'), 'Cancelar');
    block.replaceChildren(el('div', { class: 'tr-label' }, `Tradução contextual · ${modelLabel(s.model)}`, cancel), box);
    try {
      const ctx = await this.reader.getSentenceContext(cur.page, cur.text).catch(() => null);
      const context = ctx?.paragraph || ctx?.sentence || '';
      const book = this.reader.book;
      const text = await claudeExplain({
        text: cur.text, context, page: cur.page, bookTitle: book?.title, sl: cur.src || s.sl, tl: s.tl, signal,
        onChunk: (acc) => { box.innerHTML = mdToHtml(acc); },
      });
      box.innerHTML = mdToHtml(text);
      box.classList.remove('streaming');
      cancel.remove();
      this.current.ai = text;
      block.append(el('div', { class: 'tr-actions' },
        el('button', { class: 'btn small', onclick: () => { copyText(text); toast('Explicação copiada.'); } }, icon('copy'), 'Copiar'),
        el('button', { class: 'btn small', onclick: () => this.reader.saveAiAsNote(cur, text) }, icon('note'), 'Salvar como anotação'),
      ));
    } catch (err) {
      box.classList.remove('streaming');
      cancel.remove();
      if (err?.name === 'AbortError') { box.replaceChildren(el('span', { class: 'muted', text: 'Cancelado.' })); return; }
      if (err.message === 'NO_KEY') { this.runAi(block, signal); return; }
      box.replaceChildren(el('span', { class: 'err', text: err.message }));
    }
  }
}

TranslationPanel.prototype.runWiki = async function (block, term, signal) {
  const s = settings();
  const langs = [...new Set([this.current?.src && this.current.src !== 'auto' ? this.current.src : null, s.sl !== 'auto' ? s.sl : null, 'en', s.tl.split('-')[0]].filter(Boolean))];
  block.hidden = false;
  block.replaceChildren(el('div', { class: 'tr-label' }, 'Wikipédia'), el('div', { class: 'wiki-box' }, el('span', { class: 'spinner inline-spinner' })));
  const box = block.lastChild;
  for (const lang of langs) {
    try {
      const res = await fetch(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.trim().replace(/\s+/g, '_'))}?redirect=true`, { signal, headers: { accept: 'application/json' } });
      if (!res.ok) continue;
      const d = await res.json();
      if (!d.extract || d.type === 'disambiguation' && !d.extract) continue;
      box.replaceChildren(
        d.thumbnail?.source ? el('img', { src: d.thumbnail.source, alt: '' }) : null,
        el('strong', { text: d.title }), d.description ? el('span', { class: 'muted', text: ` — ${d.description}` }) : null,
        el('p', { style: { margin: '6px 0' }, text: d.extract }),
        el('a', { href: d.content_urls?.desktop?.page || '#', target: '_blank', rel: 'noopener' }, `Ler mais (${lang}) ↗`),
      );
      return;
    } catch (err) { if (err?.name === 'AbortError') return; }
  }
  box.replaceChildren(el('span', { class: 'muted', text: 'Nenhum verbete encontrado na Wikipédia.' }));
};

function modelLabel(m) {
  return { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5' }[m] || m;
}
