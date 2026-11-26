// Dropbox: sign-in (OAuth PKCE, no secret) and the three file calls the sync engine needs.
// Adapted from Stanzas. The app has "App folder" access: paths are relative to Apps/WordDrill.

export const DROPBOX_APP_KEY = 'g1pi38dpbaa0pek';   // public by design (PKCE)
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const REDIRECT_URI = location.origin + location.pathname.replace(/(index|add)\.html$/, '');

export class AuthError extends Error {
  constructor() { super('Please connect Dropbox again.'); }
}

function b64url(bytes) {
  let s = ''; bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
// The Dropbox-API-Arg header must be ASCII: escape everything else (Armenian, Cyrillic) as \uXXXX
const hdr = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export function createDropbox(store) {
  async function startLogin(withRedirect) {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    store.set('wd.pkce', { v: verifier, redirect: withRedirect });
    const q = new URLSearchParams({
      client_id: DROPBOX_APP_KEY, response_type: 'code', token_access_type: 'offline',
      code_challenge: b64url(new Uint8Array(digest)), code_challenge_method: 'S256'
    });
    if (withRedirect) q.set('redirect_uri', REDIRECT_URI);
    const url = 'https://www.dropbox.com/oauth2/authorize?' + q;
    if (withRedirect) location.href = url; else window.open(url, '_blank');
  }
  async function exchange(code) {
    const p = store.get('wd.pkce');
    if (!p) throw new Error('Sign-in didn’t finish: start connecting Dropbox again.');
    const body = new URLSearchParams({ code: code.trim(), grant_type: 'authorization_code', code_verifier: p.v, client_id: DROPBOX_APP_KEY });
    if (p.redirect) body.set('redirect_uri', REDIRECT_URI);
    const r = await fetch(TOKEN_URL, { method: 'POST', body });
    if (!r.ok) throw new Error('Dropbox didn’t accept the code. Start connecting again.');
    const j = await r.json();
    store.set('wd.auth', { refresh: j.refresh_token, access: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 });
    store.del('wd.pkce');
  }
  async function token() {
    const a = store.get('wd.auth');
    if (!a) throw new AuthError();
    if (a.access && Date.now() < a.exp) return a.access;
    const r = await fetch(TOKEN_URL, { method: 'POST', body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: a.refresh, client_id: DROPBOX_APP_KEY }) });
    if (r.status === 400 || r.status === 401) { store.del('wd.auth'); throw new AuthError(); }
    if (!r.ok) throw new Error('Dropbox is temporarily unavailable (' + r.status + '). Changes are kept on this device.');
    const j = await r.json();
    a.access = j.access_token; a.exp = Date.now() + (j.expires_in - 60) * 1000;
    store.set('wd.auth', a);
    return a.access;
  }
  async function apiErr(r) {
    if (r.status === 401) return new AuthError();
    let s = '';
    try { s = await r.text(); s = JSON.parse(s).error_summary || s; } catch (e) {}
    const err = new Error('Dropbox: ' + (s || r.status));
    err.status = r.status;
    err.conflict = r.status === 409 && /conflict/.test(s);
    err.notFound = r.status === 409 && /not_found/.test(s);
    return err;
  }
  async function authed(call) {
    let r = await call(await token());
    if (r.status === 401) {
      const a = store.get('wd.auth'); if (a) { a.exp = 0; store.set('wd.auth', a); }
      r = await call(await token());
    }
    // Too many requests (many writes in a row): wait as Dropbox asks (at most 15 s), up to 3 times
    for (let i = 0; r.status === 429 && i < 3; i++) {
      const s = Math.min(15, Math.max(1, parseFloat(r.headers.get('Retry-After')) || 2 ** i));
      await new Promise(res => setTimeout(res, s * 1000));
      r = await call(await token());
    }
    if (!r.ok) throw await apiErr(r);
    return r;
  }
  async function rpc(endpoint, args) {
    const r = await authed(t => fetch('https://api.dropboxapi.com/2/' + endpoint, {
      method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body: JSON.stringify(args) }));
    return r.json();
  }

  const api = {
    // Every file in the app folder: [{ path: 'week/4-thu.md', rev }] (lowercase, no leading slash)
    async list() {
      let res = await rpc('files/list_folder', { path: '', recursive: true });
      let all = res.entries;
      while (res.has_more) { res = await rpc('files/list_folder/continue', { cursor: res.cursor }); all = all.concat(res.entries); }
      return all.filter(x => x['.tag'] === 'file').map(x => ({ path: x.path_lower.replace(/^\//, ''), rev: x.rev }));
    },
    async download(path) {
      let r;
      try {
        r = await authed(t => fetch('https://content.dropboxapi.com/2/files/download', {
          method: 'POST', headers: { Authorization: 'Bearer ' + t, 'Dropbox-API-Arg': hdr({ path: '/' + path }) } }));
      } catch (e) { if (e.notFound) return null; throw e; }
      let meta = {};
      try { meta = JSON.parse(r.headers.get('Dropbox-API-Result')) || {}; } catch (e) {}
      return { text: await r.text(), rev: meta.rev || null };
    },
    async upload(path, text, rev) {
      const arg = { path: '/' + path, mode: rev ? { '.tag': 'update', update: rev } : 'add', autorename: false, mute: true };
      const r = await authed(t => fetch('https://content.dropboxapi.com/2/files/upload', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': hdr(arg) },
        body: new Blob([text]) }));
      const j = await r.json();
      return { rev: j.rev };
    },
    // Deletes the file only if it is still at rev (an emptied queue file); already gone counts as done.
    // Any other 409 (e.g. the rev moved on) is treated as a conflict: the engine re-downloads and replays.
    async remove(path, rev) {
      try { await rpc('files/delete_v2', { path: '/' + path, parent_rev: rev }); }
      catch (e) {
        if (e.notFound) return;
        if (e.status === 409) e.conflict = true;
        throw e;
      }
    }
  };

  return {
    api, startLogin, exchange,
    connected: () => !!store.get('wd.auth'),
    disconnect: () => store.del('wd.auth')
  };
}
