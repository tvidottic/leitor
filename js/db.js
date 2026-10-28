// Armazenamento local (IndexedDB)

const DB_NAME = 'leitor-db';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('annotations')) {
        const s = db.createObjectStore('annotations', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('vocab')) {
        const s = db.createObjectStore('vocab', { keyPath: 'id' });
        s.createIndex('bookId', 'bookId');
        s.createIndex('word', 'wordKey');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('trcache')) db.createObjectStore('trcache', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function run(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export const db = {
  get: (store, key) => run(store, 'readonly', s => s.get(key)),
  put: (store, value) => run(store, 'readwrite', s => s.put(value)),
  del: (store, key) => run(store, 'readwrite', s => s.delete(key)),
  all: (store) => run(store, 'readonly', s => s.getAll()),
  byIndex: (store, index, value) => run(store, 'readonly', s => s.index(index).getAll(value)),
  clear: (store) => run(store, 'readwrite', s => s.clear()),
  count: (store) => run(store, 'readonly', s => s.count()),
  putMany: (store, values) => run(store, 'readwrite', s => { for (const v of values) s.put(v); }),
  delMany: (store, keys) => run(store, 'readwrite', s => { for (const k of keys) s.delete(k); }),
};

// ---- Configurações ----
export const DEFAULT_SETTINGS = {
  tl: 'pt',            // idioma de destino
  sl: 'auto',          // idioma de origem
  theme: 'system',
  night: false,
  autoPopup: true,     // popup rápido ao selecionar
  tapWord: false,      // toque em palavra traduz
  dict: true,          // dicionário inglês
  apiKey: '',
  model: 'claude-opus-5-5',
  effort: 'low',
  level: 'intermediario',
  sidebarOpen: null,   // null = decide pelo tamanho da tela
};

let settingsCache = null;
export async function loadSettings() {
  if (settingsCache) return settingsCache;
  const rows = await db.all('settings');
  settingsCache = { ...DEFAULT_SETTINGS };
  for (const r of rows) settingsCache[r.key] = r.value;
  return settingsCache;
}
export async function saveSettings(patch) {
  const s = await loadSettings();
  Object.assign(s, patch);
  await db.putMany('settings', Object.entries(patch).map(([key, value]) => ({ key, value })));
  return s;
}
export const settings = () => settingsCache || { ...DEFAULT_SETTINGS };

// ---- Cache de traduções ----
export async function cacheGet(key) {
  try { const r = await db.get('trcache', key); return r ? r.value : undefined; } catch { return undefined; }
}
export async function cacheSet(key, value) {
  try { await db.put('trcache', { key, value, ts: Date.now() }); } catch { /* ignore */ }
}

export async function storageEstimate() {
  try {
    if (navigator.storage?.estimate) { const e = await navigator.storage.estimate(); return e; }
  } catch { /* ignore */ }
  return null;
}
export async function requestPersistence() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch { /* ignore */ }
  return false;
}
