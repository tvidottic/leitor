// Provedores de nuvem: Google Drive e Dropbox. Abertura de PDFs direto da nuvem e gravação no mesmo arquivo.
// Cada provedor usa OAuth no navegador com credenciais do próprio usuário (ID do cliente / chave do app),
// sem servidor intermediário.

import { settings } from './db.js';
import { $, el, icon, formatBytes, formatDate, toast } from './utils.js';

class AuthError extends Error { constructor(msg) { super(msg); this.code = 'AUTH'; } }

// ------------------------------------------------------------------------------------------ Google Drive
class GoogleDriveProvider {
  id = 'gdrive'; name = 'Google Drive';
  constructor() { this.token = null; this.exp = 0; this.gisReady = null; }
  configured() { return !!(settings().gClientId || '').trim(); }

  loadGis() {
    if (this.gisReady) return this.gisReady;
    this.gisReady = new Promise((resolve, reject) => {
      if (window.google?.accounts?.oauth2) return resolve();
      const s = el('script', { src: 'https://accounts.google.com/gsi/client', async: true });
      s.onload = () => resolve(); s.onerror = () => reject(new Error('Não foi possível carregar o Google Identity Services.'));
      document.head.append(s);
    });
    return this.gisReady;
  }

  restore() {
    try { const t = JSON.parse(sessionStorage.getItem('leitor.gdrive') || 'null'); if (t && t.exp > Date.now() + 60_000) { this.token = t.token; this.exp = t.exp; } } catch { /* ignore */ }
  }

  /** Obtém um token; `interactive` abre a janela de login/consentimento do Google. */
  async authorize(interactive = true) {
    if (!this.token) this.restore();
    if (this.token && this.exp > Date.now() + 60_000) return this.token;
    if (!this.configured()) throw new Error('Configure o ID do cliente do Google nas configurações.');
    await this.loadGis();
    return new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: settings().gClientId.trim(),
        scope: 'https://www.googleapis.com/auth/drive',
        callback: (resp) => {
          if (resp.error) { reject(new AuthError(resp.error_description || resp.error)); return; }
          this.token = resp.access_token; this.exp = Date.now() + (resp.expires_in || 3600) * 1000;
          try { sessionStorage.setItem('leitor.gdrive', JSON.stringify({ token: this.token, exp: this.exp })); } catch { /* ignore */ }
          resolve(this.token);
        },
        error_callback: (err) => reject(new AuthError(err?.message || 'Login cancelado')),
      });
      client.requestAccessToken({ prompt: interactive ? '' : 'none' });
    });
  }

  async api(path, { method = 'GET', body, headers = {}, raw = false, base = 'https://www.googleapis.com/drive/v3' } = {}) {
    const token = await this.authorize(false).catch(() => null);
    if (!token) throw new AuthError('Entre no Google Drive para continuar.');
    const res = await fetch(`${base}${path}`, { method, body, headers: { Authorization: `Bearer ${token}`, ...headers } });
    if (res.status === 401) { this.token = null; sessionStorage.removeItem('leitor.gdrive'); throw new AuthError('Sessão do Google expirou.'); }
    if (!res.ok) { let m = `${res.status}`; try { m = (await res.json()).error?.message || m; } catch { /* ignore */ } throw new Error(`Google Drive: ${m}`); }
    return raw ? res : res.json();
  }

  async list(query = '') {
    const q = [`mimeType='application/pdf'`, 'trashed=false', query ? `name contains '${query.replace(/'/g, "\\'")}'` : ''].filter(Boolean).join(' and ');
    const data = await this.api(`/files?q=${encodeURIComponent(q)}&orderBy=modifiedTime%20desc&pageSize=60&fields=files(id,name,size,modifiedTime)&includeItemsFromAllDrives=true&supportsAllDrives=true`);
    return (data.files || []).map(f => ({ id: f.id, name: f.name, size: +f.size || 0, modified: Date.parse(f.modifiedTime) }));
  }
  async download(src) {
    const res = await this.api(`/files/${src.fileId}?alt=media&supportsAllDrives=true`, { raw: true });
    return res.blob();
  }
  async upload(src, bytes) {
    await this.api(`/files/${src.fileId}?uploadType=media&supportsAllDrives=true`, { method: 'PATCH', body: bytes, headers: { 'Content-Type': 'application/pdf' }, base: 'https://www.googleapis.com/upload/drive/v3' });
  }
  makeSource(file) { return { type: 'gdrive', fileId: file.id, name: file.name }; }
}

// ------------------------------------------------------------------------------------------ Dropbox
class DropboxProvider {
  id = 'dropbox'; name = 'Dropbox';
  configured() { return !!(settings().dbxAppKey || '').trim(); }
  get auth() { try { return JSON.parse(localStorage.getItem('leitor.dbx') || 'null'); } catch { return null; } }
  set auth(v) { if (v) localStorage.setItem('leitor.dbx', JSON.stringify(v)); else localStorage.removeItem('leitor.dbx'); }
  get redirectUri() { return location.origin + location.pathname; }

  /** Inicia o login (PKCE). A página é redirecionada ao Dropbox e volta com ?code=. */
  async authorize(interactive = true) {
    const a = this.auth;
    if (a?.access_token && a.exp > Date.now() + 60_000) return a.access_token;
    if (a?.refresh_token) { try { return await this.refresh(); } catch { /* cai no login */ } }
    if (!interactive) throw new AuthError('Entre no Dropbox para continuar.');
    if (!this.configured()) throw new Error('Configure a chave do app do Dropbox nas configurações.');
    const verifier = randomString(64);
    const challenge = await sha256b64url(verifier);
    sessionStorage.setItem('leitor.dbx.verifier', verifier);
    sessionStorage.setItem('leitor.dbx.return', JSON.stringify({ book: window.leitor?.reader?.book?.id || null }));
    const url = `https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(settings().dbxAppKey.trim())}&response_type=code&code_challenge=${challenge}&code_challenge_method=S256&token_access_type=offline&redirect_uri=${encodeURIComponent(this.redirectUri)}`;
    location.assign(url);
    return new Promise(() => {}); // a página será recarregada
  }

  /** Chamado na inicialização: troca o ?code= por tokens. Retorna true se houve login. */
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return false;
    const verifier = sessionStorage.getItem('leitor.dbx.verifier');
    history.replaceState(null, '', location.pathname);
    if (!verifier) return false;
    const body = new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: verifier, client_id: settings().dbxAppKey.trim(), redirect_uri: this.redirectUri });
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body });
    if (!res.ok) { toast('Falha ao entrar no Dropbox.'); return false; }
    const t = await res.json();
    this.auth = { access_token: t.access_token, refresh_token: t.refresh_token, exp: Date.now() + (t.expires_in || 14400) * 1000 };
    sessionStorage.removeItem('leitor.dbx.verifier');
    toast('Conectado ao Dropbox.');
    return true;
  }

  async refresh() {
    const a = this.auth;
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: a.refresh_token, client_id: settings().dbxAppKey.trim() });
    const res = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body });
    if (!res.ok) { this.auth = null; throw new AuthError('Sessão do Dropbox expirou.'); }
    const t = await res.json();
    this.auth = { ...a, access_token: t.access_token, exp: Date.now() + (t.expires_in || 14400) * 1000 };
    return t.access_token;
  }

  async api(url, { arg, body, contentType = 'application/json' } = {}) {
    const token = await this.authorize(false);
    const headers = { Authorization: `Bearer ${token}` };
    let payload = body;
    if (arg && body === undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(arg); }
    else if (arg) { headers['Dropbox-API-Arg'] = JSON.stringify(arg); headers['Content-Type'] = contentType; }
    const res = await fetch(url, { method: 'POST', headers, body: payload });
    if (res.status === 401) { this.auth = { ...this.auth, access_token: null, exp: 0 }; throw new AuthError('Sessão do Dropbox expirou.'); }
    if (!res.ok) { const t = await res.text(); throw new Error(`Dropbox: ${t.slice(0, 200)}`); }
    return res;
  }

  async list(query = '') {
    const res = await this.api('https://api.dropboxapi.com/2/files/search_v2', { arg: { query: query || 'pdf', options: { file_extensions: ['pdf'], max_results: 60, file_status: 'active' } } });
    const data = await res.json();
    return (data.matches || []).map(m => m.metadata?.metadata).filter(f => f && f['.tag'] === 'file')
      .map(f => ({ id: f.path_lower, name: f.name, size: f.size || 0, modified: Date.parse(f.server_modified), path: f.path_display }));
  }
  async download(src) {
    const res = await this.api('https://content.dropboxapi.com/2/files/download', { arg: { path: src.path }, body: null, contentType: 'text/plain' });
    return res.blob();
  }
  async upload(src, bytes) {
    await this.api('https://content.dropboxapi.com/2/files/upload', { arg: { path: src.path, mode: 'overwrite', autorename: false, mute: true }, body: bytes, contentType: 'application/octet-stream' });
  }
  makeSource(file) { return { type: 'dropbox', path: file.path || file.id, name: file.name }; }
}

const PROVIDERS = { gdrive: new GoogleDriveProvider(), dropbox: new DropboxProvider() };
export const getProvider = (id) => PROVIDERS[id] || null;
export const allProviders = () => Object.values(PROVIDERS);
export const PROVIDER_ICON = { gdrive: 'cloud', dropbox: 'cloud', fsa: 'file' };

/** Diálogo de escolha de arquivo na nuvem. Resolve com {provider, file} ou null. */
export function pickCloudFile(providerId) {
  const provider = getProvider(providerId);
  const dlg = $('#cloud-dialog');
  const title = $('#cloud-title'), list = $('#cloud-list'), input = $('#cloud-search'), status = $('#cloud-status');
  title.textContent = provider.name;
  list.replaceChildren(); status.textContent = ''; input.value = '';
  let chosen = null;
  const render = (files) => {
    if (!files.length) { list.replaceChildren(el('p', { class: 'muted pad', text: 'Nenhum PDF encontrado.' })); return; }
    list.replaceChildren(...files.map(f => el('button', { type: 'button', class: 'list-item cloud-file', onclick: () => { chosen = f; dlg.close('ok'); } },
      icon('book'),
      el('div', { class: 'cf-info' }, el('div', { class: 'li-text', text: f.name }), el('div', { class: 'li-head', text: `${f.size ? formatBytes(f.size) + ' · ' : ''}${f.modified ? formatDate(f.modified) : ''}${f.path ? ' · ' + f.path : ''}` })),
    )));
  };
  const load = async (q) => {
    status.textContent = 'Carregando…';
    try {
      const files = await provider.list(q);
      status.textContent = `${files.length} arquivo(s)`;
      render(files);
    } catch (err) {
      if (err.code === 'AUTH') {
        status.textContent = '';
        list.replaceChildren(el('div', { class: 'pad' }, el('p', { class: 'muted', text: `Entre no ${provider.name} para ver seus arquivos.` }),
          el('button', { type: 'button', class: 'btn primary', onclick: async () => { try { await provider.authorize(true); load(input.value.trim()); } catch (e) { toast(e.message); } } }, icon('cloud'), `Entrar no ${provider.name}`)));
      } else { status.textContent = err.message; }
    }
  };
  let t;
  input.oninput = () => { clearTimeout(t); t = setTimeout(() => load(input.value.trim()), 400); };
  $('#cloud-form').onsubmit = (e) => { e.preventDefault(); load(input.value.trim()); };
  return new Promise(resolve => {
    const onClose = () => { dlg.removeEventListener('close', onClose); resolve(chosen ? { provider, file: chosen } : null); };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    if (!provider.configured()) {
      list.replaceChildren(el('div', { class: 'pad' },
        el('p', { class: 'muted' }, `Para usar o ${provider.name} é preciso informar ${provider.id === 'gdrive' ? 'o ID do cliente OAuth do Google' : 'a chave do app do Dropbox'} nas configurações. O passo a passo está no README.`),
        el('button', { type: 'button', class: 'btn primary', onclick: () => { dlg.close(); window.leitor.openSettings(); } }, icon('settings'), 'Abrir configurações')));
      return;
    }
    load('');
  });
}

export async function handleOAuthRedirect() {
  try { return await PROVIDERS.dropbox.handleRedirect(); } catch { return false; }
}

// ------------------------------------------------------------------------------------------ utilitários
function randomString(n) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const arr = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(arr, b => chars[b % chars.length]).join('');
}
async function sha256b64url(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return btoa(String.fromCharCode(...new Uint8Array(h))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
