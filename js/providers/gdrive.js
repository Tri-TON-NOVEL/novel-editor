// Google Drive 接続（Google Identity Services + Drive API v3）
// 権限は drive.file：このアプリで作成したファイルと、Google Picker で選んだフォルダ・ファイルだけを扱う。
//
// 保存先フォルダ（端末ごと。localStorage `novel-editor:gdrive.folder` = { id, name }）
//   未指定      … 自動で作る「小説エディター」フォルダ（appProperties で識別）
//   指定あり    … Google Picker で選んだフォルダ、または名前を付けて新しく作ったフォルダ
// 保存先を変えても、すでに保存したファイルは移動しない（次に新しく保存するファイルから新しいフォルダへ）。
import { prefs } from '../db.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = '小説エディター';
const APP_KEY = 'novelEditor';
// ここにクライアントIDを書いておくと、どの端末でも設定画面での入力が不要になる（公開しても問題ない値）
const DEFAULT_CLIENT_ID = '';

let gisPromise = null;
let pickerPromise = null;
let tokenClient = null;
let token = null; // { value, expiresAt }
let defaultFolderId = null;

function clientId() { return prefs.get('gdrive.clientId', '') || DEFAULT_CLIENT_ID; }
function apiKey() { return prefs.get('gdrive.apiKey', '') || ''; }
function chosenFolder() { return prefs.get('gdrive.folder', null); }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Google の部品（${src}）を読み込めませんでした`));
    document.head.appendChild(s);
  });
}

function loadGis() {
  if (!gisPromise) gisPromise = loadScript('https://accounts.google.com/gsi/client').catch((e) => { gisPromise = null; throw e; });
  return gisPromise;
}

function loadPicker() {
  if (!pickerPromise) {
    pickerPromise = loadScript('https://apis.google.com/js/api.js')
      .then(() => new Promise((resolve) => window.gapi.load('picker', resolve)))
      .catch((e) => { pickerPromise = null; throw e; });
  }
  return pickerPromise;
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
    tokenClient.error_callback = (err) => reject(new Error('Google ログインが中断されました（' + (err.type || 'error') + '）。iPhone・iPad ではポップアップのブロックを確認してください'));
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

const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

async function ensureDefaultFolder() {
  if (defaultFolderId) return defaultFolderId;
  const query = `appProperties has { key='${APP_KEY}' and value='folder' } and trashed=false`;
  const res = await api(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`);
  const found = (await res.json()).files[0];
  if (found) return (defaultFolderId = found.id);
  const created = await api(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: FOLDER_MIME, appProperties: { [APP_KEY]: 'folder' } }),
  });
  return (defaultFolderId = (await created.json()).id);
}

async function saveFolderId() {
  return chosenFolder()?.id || ensureDefaultFolder();
}

function multipart(metadata, text) {
  const boundary = 'novel-editor-' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${text}\r\n` +
    `--${boundary}--`;
  return { body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } };
}

async function patchFile(fileId, text, name, workId) {
  const { body, headers } = multipart({ name, appProperties: { [APP_KEY]: 'work', ...(workId ? { workId } : {}) } }, text);
  const res = await api(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id`, { method: 'PATCH', headers, body });
  return (await res.json()).id;
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
    {
      key: 'gdrive.apiKey',
      label: 'Google API キー（任意・フォルダを選ぶときに使用）',
      placeholder: 'AIza…',
      hint: '「フォルダを選ぶ（Google Picker）」を使う場合だけ必要です。なくても「新しいフォルダを作って使う」は使えます。',
    },
  ],

  preload() { if (clientId()) loadGis().catch(() => {}); },

  async signIn() { await getToken(); },

  signOut() {
    if (token && window.google) window.google.accounts.oauth2.revoke(token.value, () => {});
    token = null;
    defaultFolderId = null;
  },

  // ---------- 保存先フォルダ ----------

  // 戻り値: { id, name, isDefault }
  folderInfo() {
    const f = chosenFolder();
    return f ? { ...f, isDefault: false } : { id: defaultFolderId || '', name: `${FOLDER_NAME}（自動で作るフォルダ）`, isDefault: true };
  },

  canPickFolder() { return !!apiKey(); },

  // Google Picker でフォルダを選ぶ（drive.file でも、選んだフォルダには保存できる）
  async pickFolder() {
    if (!apiKey()) throw new Error('フォルダを選ぶには、設定に Google API キーを入れてください');
    const t = await getToken();
    await loadPicker();
    const { google } = window;
    return new Promise((resolve) => {
      const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes(FOLDER_MIME);
      const appId = (clientId().match(/^(\d+)-/) || [])[1];
      const builder = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(t)
        .setDeveloperKey(apiKey())
        .setTitle('保存先のフォルダを選ぶ')
        .setCallback((data) => {
          if (data.action === google.picker.Action.PICKED) {
            const doc = data.docs[0];
            const folder = { id: doc.id, name: doc.name };
            prefs.set('gdrive.folder', folder);
            resolve(folder);
          } else if (data.action === google.picker.Action.CANCEL) {
            resolve(null);
          }
        });
      if (appId) builder.setAppId(appId);
      builder.build().setVisible(true);
    });
  },

  // 名前を付けて新しいフォルダを作り、保存先にする
  async createFolder(name) {
    const res = await api(`${API}/files?fields=id,name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties: { [APP_KEY]: 'folder-chosen' } }),
    });
    const f = await res.json();
    const folder = { id: f.id, name: f.name };
    prefs.set('gdrive.folder', folder);
    return folder;
  },

  resetFolder() { prefs.set('gdrive.folder', null); },

  // ---------- ファイル ----------

  // 戻り値: [{ id, name, modifiedTime }]（保存先がどのフォルダでも、このアプリで保存した作品を一覧にする）
  async list() {
    const query = `appProperties has { key='${APP_KEY}' and value='work' } and trashed=false`;
    const res = await api(`${API}/files?q=${encodeURIComponent(query)}&orderBy=modifiedTime desc&pageSize=200&fields=files(id,name,modifiedTime)`);
    return (await res.json()).files;
  },

  async load(fileId) {
    const res = await api(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
    return res.text();
  },

  /**
   * fileId があれば上書き、なければ保存先フォルダに新しく作る。戻り値: fileId
   * 新しく作るとき、同じフォルダに同じ名前のファイルがあれば：
   *   同じ作品（workId が一致）→ そのファイルを上書き（重複を作らない）
   *   別の作品               → 上書きせず、名前の後ろに「 (2)」などを付けて別のファイルにする
   * 更新は Drive の1回の要求で中身を差し替えるので、通信に失敗しても元のファイルは残る。
   */
  async save(text, name, fileId = null, { workId = '' } = {}) {
    if (fileId) {
      try {
        return await patchFile(fileId, text, name, workId);
      } catch (e) {
        // ゴミ箱で削除された等で見つからない場合は新しく作り直す
        if (!/not found|404/i.test(e.message)) throw e;
      }
    }
    const parent = await saveFolderId();
    const base = name.replace(/\.json$/i, '');
    let finalName = name;
    for (let n = 2; n < 100; n++) {
      const query = `name = ${q(finalName)} and ${q(parent)} in parents and trashed=false`;
      const res = await api(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id,appProperties)&pageSize=10`);
      const same = (await res.json()).files;
      if (!same.length) break;
      const mine = workId && same.find((f) => f.appProperties?.workId === workId);
      if (mine) return patchFile(mine.id, text, finalName, workId);
      finalName = `${base} (${n}).json`;
    }
    const meta = { name: finalName, mimeType: 'application/json', parents: [parent], appProperties: { [APP_KEY]: 'work', ...(workId ? { workId } : {}) } };
    const { body, headers } = multipart(meta, text);
    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers, body });
    return (await res.json()).id;
  },
};
