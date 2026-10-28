// Vocabulário pessoal: palavras e expressões salvas durante a leitura.

import { db } from './db.js';
import { uid } from './utils.js';

const wordKey = (word, tl) => `${word.trim().toLowerCase()}|${tl}`;

export async function saveVocab({ bookId, bookTitle, word, translation, context, sl, tl, page }) {
  const key = wordKey(word, tl);
  const existing = (await db.byIndex('vocab', 'word', key))[0];
  if (existing) {
    Object.assign(existing, { translation: translation || existing.translation, context: context || existing.context, page, bookId, bookTitle, updatedAt: Date.now() });
    await db.put('vocab', existing);
    return { item: existing, created: false };
  }
  const item = { id: uid(), wordKey: key, bookId, bookTitle, word: word.trim(), translation, context, sl, tl, page, createdAt: Date.now(), reviews: 0 };
  await db.put('vocab', item);
  return { item, created: true };
}

export async function listVocab(bookId) {
  const items = bookId ? await db.byIndex('vocab', 'bookId', bookId) : await db.all('vocab');
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export const removeVocab = (id) => db.del('vocab', id);
export const updateVocab = (item) => db.put('vocab', item);

/** CSV compatível com Anki (separador ponto e vírgula): palavra; tradução; contexto; livro; página */
export function vocabToCsv(items) {
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
  const rows = [['palavra', 'traducao', 'contexto', 'livro', 'pagina'].join(';')];
  for (const it of items) rows.push([it.word, it.translation, it.context, it.bookTitle, it.page].map(esc).join(';'));
  return '﻿' + rows.join('\r\n');
}
