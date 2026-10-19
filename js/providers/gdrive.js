// Google Drive 接続（Google Identity Services + Drive API v3）
// 権限は drive.file：このアプリで作成・選択したファイルだけを扱う。
import { prefs } from '../db.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_NAME = '小説エディター';
const APP_KEY = 'novelEditor';
// ここにクライアントIDを書いておくと、どの端末でも設定画面での入力が不要になる（公開しても問題ない値）
const DEFAULT_CLIENT_ID = '';

let gisPromise = null;
let tokenClient = null;
let token = null; // { value, expiresAt }
let folderId = null;

function clientId() { return prefs.get('gdrive.clientId', '') || DEFAULT_CLIENT_ID; }

function loadGis() {
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = resolve;
      s.onerror = () => { gisPromise = null; reject(new Error('Google のログイン部品を読み込めませんでした')); };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

async function getToken({ interactive = true } = {}) {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  if (!interactive) return null;
  if (!clientId()) throw new Error('設定で Google の クライアントID を入力してください');
  await loadGis();
  if (!tokenClient || tokenClient._id !== clientId()) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({ client_id: clientId(), scope: SCOPE, callback: () => {} });
    tokenClient._id = clientId();
  }
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error('Google ログインに失敗しました: ' + resp.error)); return; }
      token = { value: resp.access_token, expiresAt: Date.now() + Number(resp.expires_in) * 1000 };
      resolve(token.value);
    };
    tokenClient.error_callback = (err) => reject(new Error('Google ログインが中断されました（' + (err.type || 'error') + '）'));
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function api(url, options = {}, retry = true) {
  const t = await getToken();
  const res = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + t } });
  if (res.status === 401 && retry) {
    token = null;
    return api(url, options, false);
  }
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    try { msg = (await res.json()).error.message || msg; } catch { /* 本文なし */ }
    throw new Error('Google Drive エラー: ' + msg);
  }
  return res;
}

async function ensureFolder() {
  if (folderId) return folderId;
  const query = `appProperties has { key='${APP_KEY}' and value='folder' } and trashed=false`;
  const res = await api(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`);
  const found = (await res.json()).files[0];
  if (found) return (folderId = found.id);
  const created = await api(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder', appProperties: { [APP_KEY]: 'folder' } }),
  });
  return (folderId = (await created.json()).id);
}

function multipart(metadata, text) {
  const boundary = 'novel-editor-' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n` +
    `--${boundary}--`;
  return { body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } };
}

export const gdrive = {
  id: 'gdrive',
  label: 'Google ドライブ',

  isConfigured() { return !!clientId(); },
  isSignedIn() { return !!token && Date.now() < token.expiresAt; },

  // 設定画面に出す項目
  settings: [
    {
      key: 'gdrive.clientId',
      label: 'Google OAuth クライアントID',
      placeholder: 'xxxxxxxx.apps.googleusercontent.com',
      hint: 'Google Cloud Console で作成した「ウェブ アプリケーション」のクライアントID。手順は README を参照。',
    },
  ],

  preload() { if (clientId()) loadGis().catch(() => {}); },

  async signIn() { await getToken(); },

  signOut() {
    if (token && window.google) window.google.accounts.oauth2.revoke(token.value, () => {});
    token = null;
    folderId = null;
  },

  // 戻り値: [{ id, name, modifiedTime }]
  async list() {
    const query = `appProperties has { key='${APP_KEY}' and value='work' } and trashed=false`;
    const res = await api(`${API}/files?q=${encodeURIComponent(query)}&orderBy=modifiedTime desc&pageSize=200&fields=files(id,name,modifiedTime)`);
    return (await res.json()).files;
  },

  async load(fileId) {
    const res = await api(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
    return res.text();
  },

  // fileId があれば上書き、なければ新規作成。戻り値: fileId
  async save(text, name, fileId = null) {
    if (fileId) {
      const { body, headers } = multipart({ name }, text);
      try {
        const res = await api(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id`, { method: 'PATCH', headers, body });
        return (await res.json()).id;
      } catch (e) {
        // ゴミ箱で削除された等で見つからない場合は新規作成し直す
        if (!/not found|404/i.test(e.message)) throw e;
      }
    }
    const parent = await ensureFolder();
    const { body, headers } = multipart({ name, mimeType: 'application/json', parents: [parent], appProperties: { [APP_KEY]: 'work' } }, text);
    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers, body });
    return (await res.json()).id;
  },
};
