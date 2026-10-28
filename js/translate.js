// Serviços de tradução: Google Tradutor (rápido), dicionário em inglês e tradução contextual com Claude.

import { cacheGet, cacheSet, settings } from './db.js';
import { langName } from './utils.js';

const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/single';
const MAX_CHUNK = 1800;
const FALLBACK_CHUNK = 450;

/**
 * Tradução via Google Tradutor (endpoint público usado pela extensão do Chrome).
 * Retorna { text, src, dict, definitions, examples, alternatives }.
 */
export async function googleTranslate(text, { sl = 'auto', tl = 'pt', signal } = {}) {
  const q = text.trim();
  if (!q) return { text: '', src: sl };
  const key = `g:${sl}:${tl}:${q}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  if (q.length > MAX_CHUNK) {
    const chunks = splitChunks(q, MAX_CHUNK);
    const parts = [];
    let src = sl;
    for (const c of chunks) { const r = await googleTranslate(c, { sl, tl, signal }); parts.push(r.text); src = r.src || src; }
    const out = { text: parts.join(' '), src };
    await cacheSet(key, out);
    return out;
  }

  const short = q.length < 60;
  const params = new URLSearchParams({ client: 'gtx', sl, tl, dj: '1', hl: tl.split('-')[0], q });
  for (const dt of ['t', 'rm', ...(short ? ['bd', 'md', 'ex', 'at'] : [])]) params.append('dt', dt);
  let res;
  try {
    res = await fetch(GOOGLE_URL, { method: 'POST', body: params, signal });
    if (!res.ok) throw new Error(String(res.status));
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    res = await fetch(`${GOOGLE_URL}?${params}`, { signal });
    if (!res.ok) throw new Error(`Google Tradutor indisponível (${res.status})`);
  }
  const data = await res.json();
  const sentences = (data.sentences || []).filter(s => typeof s.trans === 'string');
  const joined = sentences.map(s => s.trans).join('');
  if (!joined.trim()) throw new Error('O Google Tradutor não retornou texto.');
  const out = {
    text: joined,
    src: data.src || sl,
    transliteration: (data.sentences || []).find(s => s.src_translit)?.src_translit || '',
    dict: (data.dict || []).map(d => ({ pos: d.pos, terms: d.terms || [], entries: (d.entry || []).map(e => ({ word: e.word, reverse: e.reverse_translation || [], score: e.score || 0 })) })),
    definitions: (data.definitions || []).map(d => ({ pos: d.pos, entries: (d.entry || []).map(e => ({ gloss: e.gloss, example: e.example })) })),
    examples: (data.examples?.example || []).map(e => e.text),
    alternatives: (data.alternative_translations || []).flatMap(a => (a.alternative || []).map(x => x.word_postproc)).filter(Boolean),
  };
  await cacheSet(key, out);
  return out;
}

/** Tradução de reserva (MyMemory), usada se o Google falhar. */
export async function fallbackTranslate(text, { sl = 'auto', tl = 'pt', signal } = {}) {
  const from = sl === 'auto' ? 'en' : sl.split('-')[0];
  const all = splitChunks(text.trim(), FALLBACK_CHUNK);
  const chunks = all.slice(0, 12);
  const parts = [];
  for (const c of chunks) {
    const res = await fetch(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(c)}&langpair=${from}|${tl.split('-')[0]}`, { signal });
    if (!res.ok) throw new Error('Serviço de tradução indisponível');
    const data = await res.json();
    const t = data?.responseData?.translatedText;
    if (typeof t !== 'string' || !t || data.responseStatus === 403 || /MYMEMORY WARNING|QUERY LENGTH/i.test(t)) throw new Error('Serviço de reserva indisponível no momento');
    parts.push(t);
  }
  const joined = parts.join(' ').trim();
  if (!joined) throw new Error('Tradução vazia');
  return { text: joined, src: from, dict: [], definitions: [], examples: [], alternatives: [], via: 'reserva', truncated: chunks.length < all.length };
}

export async function translate(text, opts = {}) {
  try { return await googleTranslate(text, opts); }
  catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.warn('Google falhou, usando reserva:', err);
    return fallbackTranslate(text, opts);
  }
}

/** Dicionário de inglês (Free Dictionary API). Retorna null se não houver verbete. */
export async function englishDictionary(word, { signal } = {}) {
  const w = word.trim().toLowerCase().replace(/[^a-z'-]/g, '');
  if (!w) return null;
  const key = `d:en:${w}`;
  const cached = await cacheGet(key);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(w)}`, { signal });
    if (!res.ok) { await cacheSet(key, null); return null; }
    const data = await res.json();
    const e = Array.isArray(data) ? data[0] : null;
    if (!e) { await cacheSet(key, null); return null; }
    const out = {
      word: e.word,
      phonetic: e.phonetic || e.phonetics?.find(p => p.text)?.text || '',
      audio: e.phonetics?.find(p => p.audio)?.audio || '',
      meanings: (e.meanings || []).slice(0, 4).map(m => ({
        pos: m.partOfSpeech,
        defs: (m.definitions || []).slice(0, 3).map(d => ({ def: d.definition, ex: d.example || '' })),
        synonyms: (m.synonyms || []).slice(0, 6),
      })),
    };
    await cacheSet(key, out);
    return out;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return null;
  }
}

export function googleTranslateUrl(text, { sl = 'auto', tl = 'pt' } = {}) {
  return `https://translate.google.com/?sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&text=${encodeURIComponent(text)}&op=translate`;
}

function splitChunks(text, max) {
  const out = [];
  let cur = '';
  const pieces = [];
  for (const s of text.split(/(?<=[.!?…])\s+/)) {
    if (s.length <= max) { pieces.push(s); continue; }
    for (let i = 0; i < s.length; i += max) pieces.push(s.slice(i, i + max)); // frase enorme sem pontuação
  }
  for (const s of pieces) {
    if ((cur + ' ' + s).length > max && cur) { out.push(cur); cur = s; }
    else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

// ------------------------------------------------------------------------------------------------
// Tradução contextual com Claude (API da Anthropic, chamada diretamente do navegador).
// ------------------------------------------------------------------------------------------------

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-5']);

function systemPrompt({ tl, level }) {
  const target = langName(tl);
  const levelHint = {
    iniciante: 'O leitor é iniciante: use linguagem simples, explique também vocabulário básico e estruturas gramaticais relevantes.',
    intermediario: 'O leitor é intermediário: foque em expressões idiomáticas, nuances, registro e armadilhas comuns.',
    avancado: 'O leitor é avançado: seja conciso, destaque apenas sutilezas, conotações, referências e escolhas estilísticas.',
  }[level] || '';
  return `Você é um tradutor literário experiente e professor de idiomas. Um leitor não nativo está estudando um texto e selecionou um trecho. Sua tarefa é ajudá-lo a compreender exatamente o sentido pretendido, considerando o contexto, a cultura e as referências do texto original.

Responda SEMPRE em ${target}, em Markdown enxuto, usando esta estrutura (omita seções irrelevantes):

### Tradução
Tradução fiel e natural do trecho selecionado em ${target}, preservando tom, registro e intenção. Se o trecho for uma única palavra ou expressão curta, dê o sentido exato neste contexto e, entre parênteses, outros sentidos comuns.

### No contexto
Uma ou duas frases sobre o que o autor quer dizer ali, levando em conta o parágrafo ao redor (ironia, humor, referência, ambiguidade, tempo narrativo).

### Notas
Lista curta (apenas o que for relevante): expressões idiomáticas e gírias; referências culturais, históricas ou literárias; jogos de palavras; falsos cognatos; pontos gramaticais ou vocabulário que mereçam atenção; alternativas de tradução e por que a sua é melhor.

${levelHint}
Não repita o trecho original inteiro. Não invente contexto que não esteja no texto. Seja direto e útil.`;
}

/**
 * Explica/traduz um trecho com contexto, em streaming. Chama onChunk(textoAcumulado) a cada pedaço.
 * Retorna o texto final. Lança erro com mensagem amigável em caso de falha.
 */
export async function claudeExplain({ text, context, page, bookTitle, sl, tl, signal, onChunk }) {
  const s = settings();
  const apiKey = (s.apiKey || '').trim();
  if (!apiKey) throw new Error('NO_KEY');
  const model = s.model || 'claude-opus-5-5';
  const effort = s.effort || 'low';

  const srcName = sl && sl !== 'auto' ? langName(sl) : 'idioma original (detecte)';
  const user = [
    bookTitle ? `Obra: ${bookTitle}${page ? ` (página ${page})` : ''}` : '',
    `Idioma do texto: ${srcName}. Traduzir para: ${langName(tl)}.`,
    '',
    context && context !== text ? `<contexto>\n${context}\n</contexto>` : '',
    '',
    `<trecho_selecionado>\n${text}\n</trecho_selecionado>`,
  ].filter(Boolean).join('\n');

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const body = {
    model,
    max_tokens: 2048,
    stream: true,
    system: systemPrompt({ tl, level: s.level }),
    messages: [{ role: 'user', content: user }],
    output_config: { effort },
  };
  if (FALLBACK_MODELS.has(model)) {
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
    body.fallbacks = 'default';
  }

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new Error('Não foi possível conectar à API da Anthropic. Verifique sua conexão.');
  }
  if (!res.ok) {
    let msg = `Erro ${res.status}`;
    try { const j = await res.json(); msg = j?.error?.message || msg; } catch { /* ignore */ }
    if (res.status === 401) msg = 'Chave da API inválida. Verifique nas configurações.';
    if (res.status === 429) msg = 'Limite de uso da API atingido. Tente novamente em instantes.';
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', acc = '', stopReason = null, stopDetails = null;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop();
    for (const evt of events) {
      const dataLine = evt.split('\n').find(l => l.startsWith('data:'));
      if (!dataLine) continue;
      let json;
      try { json = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') {
        acc += json.delta.text;
        onChunk?.(acc);
      } else if (json.type === 'message_delta') {
        stopReason = json.delta?.stop_reason || stopReason;
        stopDetails = json.delta?.stop_details || stopDetails;
      } else if (json.type === 'error') {
        throw new Error(json.error?.message || 'Erro na API');
      }
    }
  }
  if (stopReason === 'refusal') {
    throw new Error(`O modelo não pôde responder a este trecho${stopDetails?.explanation ? `: ${stopDetails.explanation}` : '.'}`);
  }
  if (!acc.trim()) throw new Error('A API não retornou texto.');
  return acc;
}
