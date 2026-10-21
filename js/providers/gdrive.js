// Google Drive 接続（Google Identity Services + Drive API v3）
// 権限は drive.file：このアプリで作成したファイルと、Google Picker で選んだフォルダ・ファイルだけを扱う。
// 同じ Google アカウント・同じクライアントID なら、どの端末（OS）で保存したファイルも、ほかの端末から読める。
//
// 手動で保存するフォルダ（端末ごと。localStorage `novel-editor:gdrive.folder` = { id, name }）
//   未指定      … 自動で作る「小説エディター」フォルダ（appProperties で識別）
//   指定あり    … Google Picker で選んだフォルダ、または名前を付けて新しく作ったフォルダ
// 保存先を変えても、すでに保存したファイルは移動しない（次に新しく保存するファイルから新しいフォルダへ）。
//
// 自動バックアップ（同期）のフォルダは、どの端末でも同じ「小説エディター／自動バックアップ」（appProperties で識別）。
//
// ログイン
//   ブラウザ               … ポップアップ。開けなければ、ページごと Google に移動して戻ってくる（リダイレクト）
//   ホーム画面のアプリ（PWA）… 最初からリダイレクト（PWA ではポップアップのログイン結果がアプリに戻らないことがあるため）
//   リダイレクトには、Google Cloud Console の「承認済みのリダイレクト URI」に公開 URL の登録が必要。
import { prefs } from '../db.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_NAME = '小説エディター';
const BACKUP_FOLDER_NAME = '自動バックアップ';
const APP_KEY = 'novelEditor';
// ここにクライアントIDを書いておくと、どの端末でも設定画面での入力が不要になる（公開しても問題ない値）
const DEFAULT_CLIENT_ID = '';

let gisPromise = null;
let pickerPromise = null;
let tokenClient = null;
let defaultFolderId = null;
let backupFolderId = null;
// 自動バックアップの間は、ログイン画面を出さない（iPhone・iPad ではボタンを押したとき以外は出せないため）
let silent = 0;
// リダイレクトでページを離れる前に呼ぶ（書きかけの内容を端末に保存する）
let beforeRedirect = async () => {};

function clientId() { return prefs.get('gdrive.clientId', '') || DEFAULT_CLIENT_ID; }
function apiKey() { return prefs.get('gdrive.apiKey', '') || ''; }
function chosenFolder() { return prefs.get('gdrive.folder', null); }

// ホーム画面に追加したアプリとして開いているか
const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// ログインの鍵（約1時間有効）。アプリを開き直しても有効な間は使えるよう、この端末に残す。
// 全体バックアップ（novel-editor: で始まる設定）には入らない名前にしている。
const TOKEN_KEY = 'novel-editor-session:gdrive.token';
const STATE_KEY = 'novel-editor-session:gdrive.state';
let token = (() => {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    return t && t.clientId === clientId() && Date.now() < t.expiresAt ? t : null;
  } catch { return null; }
})(); // { value, expiresAt, clientId }
function setToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* 残せなくても続行 */ }
}

export class NeedLoginError extends Error {
  constructor() { super('Google ドライブへのログインが必要です'); this.name = 'NeedLoginError'; }
}

// ---------- リダイレクトでのログイン ----------

function redirectUri() { return location.origin + location.pathname; }

async function startRedirectLogin() {
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(STATE_KEY, state); } catch { /* 無視 */ }
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  const params = { client_id: clientId(), redirect_uri: redirectUri(), response_type: 'token', scope: SCOPE, include_granted_scopes: 'true', state };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  await beforeRedirect().catch(() => {});
  location.href = url.toString();
  return new Promise(() => {}); // ページが移動するので戻らない
}

// Google から戻ってきたとき（URL の # 以降にログインの結果が付いている）。読み込んだ時点で一度だけ調べる
let redirectResult = null; // { ok: true } / { ok: false, message }
(function handleRedirectResult() {
  if (!/(^|[#&])(access_token|error)=/.test(location.hash)) return;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', location.pathname + location.search);
  let expected = null;
  try { expected = localStorage.getItem(STATE_KEY); localStorage.removeItem(STATE_KEY); } catch { /* 無視 */ }
  if (!expected || p.get('state') !== expected) {
    redirectResult = { ok: false, message: 'Google ドライブへのログインを確認できませんでした。もう一度ログインしてください' };
  } else if (p.get('error')) {
    redirectResult = { ok: false, message: `Google ドライブにログインできませんでした（${p.get('error')}）` };
  } else if (!(p.get('scope') || '').split(' ').includes(SCOPE)) {
    redirectResult = { ok: false, message: 'Google ドライブを使う許可がありません。もう一度ログインして、ドライブへのアクセスを許可してください' };
  } else {
    setToken({ value: p.get('access_token'), expiresAt: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000, clientId: clientId() });
    redirectResult = { ok: true };
  }
})();

// ---------- 部品の読み込み ----------

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(`Google の部品（${src}）を読み込めませんでした（ネット接続を確認してください）`)); };
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

// 有効な鍵を返す。なければログイン画面を出すので、ボタンを押した直後に呼ぶ
async function getToken() {
  if (token && Date.now() < token.expiresAt - 60_000) return token.value;
  if (silent) throw new NeedLoginError();
  if (!clientId()) throw new Error('設定で Google の クライアントID を入力してください');
  if (isStandalone) return startRedirectLogin();
  await loadGis();
  if (!tokenClient || tokenClient._id !== clientId()) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({ client_id: clientId(), scope: SCOPE, callback: () => {} });
    tokenClient._id = clientId();
  }
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) { reject(new Error('Google ログインに失敗しました: ' + resp.error)); return; }
      setToken({ value: resp.access_token, expiresAt: Date.now() + Number(resp.expires_in) * 1000, clientId: clientId() });
      resolve(token.value);
    };
    tokenClient.error_callback = (err) => {
      // ポップアップが開けなかったら、ページごと移動してログインする
      if (err?.type === 'popup_failed_to_open') { startRedirectLogin(); return; }
      reject(new Error(err?.type === 'popup_closed' ? 'ログイン画面が閉じられました' : 'Google ログインが中断されました（' + (err?.type || 'error') + '）'));
    };
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function api(url, options = {}, retry = true) {
  const t = await getToken();
  const res = await fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + t } });
  if (res.status === 401 && retry) {
    setToken(null);
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

async function findOrCreateFolder(marker, name, parent = null) {
  const query = `appProperties has { key='${APP_KEY}' and value='${marker}' } and trashed=false`;
  const res = await api(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`);
  const found = (await res.json()).files[0];
  if (found) return found.id;
  const created = await api(`${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties: { [APP_KEY]: marker }, ...(parent ? { parents: [parent] } : {}) }),
  });
  return (await created.json()).id;
}

async function ensureDefaultFolder() {
  if (!defaultFolderId) defaultFolderId = await findOrCreateFolder('folder', FOLDER_NAME);
  return defaultFolderId;
}

async function ensureBackupFolder() {
  if (!backupFolderId) backupFolderId = await findOrCreateFolder('backup-folder', BACKUP_FOLDER_NAME, await ensureDefaultFolder());
  return backupFolderId;
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
  // 画面を出さずに使える状態か（ログインの残り時間が1分以上）
  canSaveSilently() { return !!token && Date.now() < token.expiresAt - 60_000; },
  // リダイレクトのログインから戻ってきたときの結果（一度だけ返す）
  takeRedirectResult() { const r = redirectResult; redirectResult = null; return r; },
  set onBeforeRedirect(fn) { beforeRedirect = fn; },
  // ログイン画面を出さずに実行する（ログインが必要なら NeedLoginError）
  async silently(fn) {
    silent++;
    try { return await fn(); } finally { silent--; }
  },

  // 設定画面に出す項目
  settings: [
    {
      key: 'gdrive.clientId',
      label: 'Google OAuth クライアントID',
      placeholder: 'xxxxxxxx.apps.googleusercontent.com',
      hint: 'Google Cloud Console で作成した「ウェブ アプリケーション」のクライアントID。「承認済みの JavaScript 生成元」と「承認済みのリダイレクト URI」に公開 URL を登録してください（手順は README）。',
    },
    {
      key: 'gdrive.apiKey',
      label: 'Google API キー（任意・フォルダを選ぶときに使用）',
      placeholder: 'AIza…',
      hint: '「フォルダを選ぶ（Google Picker）」を使う場合だけ必要です。なくても「新しいフォルダを作って使う」は使えます。',
    },
  ],

  preload() { if (clientId() && !isStandalone) loadGis().catch(() => {}); },

  async signIn() { await getToken(); },

  signOut() {
    if (token && window.google?.accounts) window.google.accounts.oauth2.revoke(token.value, () => {});
    setToken(null);
    defaultFolderId = null;
    backupFolderId = null;
  },

  // ---------- 手動で保存するフォルダ ----------

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

  // ---------- 手動で保存したファイル ----------

  // 戻り値: [{ id, name, modifiedTime }]（保存先がどのフォルダでも、このアプリで手動保存したファイルを一覧にする）
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

  // ---------- 自動バックアップ（同期）用 ----------
  backups: {
    folderName: `${FOLDER_NAME}／${BACKUP_FOLDER_NAME}`,
    // 戻り値: [{ id, name }]（全端末のもの）
    async list() {
      const query = `appProperties has { key='${APP_KEY}' and value='autobackup' } and trashed=false`;
      const files = [];
      let pageToken = '';
      do {
        const res = await api(`${API}/files?q=${encodeURIComponent(query)}&pageSize=1000&fields=nextPageToken,files(id,name)${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
        const j = await res.json();
        files.push(...j.files);
        pageToken = j.nextPageToken || '';
      } while (pageToken);
      return files;
    },
    async read(id) {
      const res = await api(`${API}/files/${encodeURIComponent(id)}?alt=media`);
      return res.text();
    },
    async write(name, text) {
      const meta = { name, mimeType: 'application/json', parents: [await ensureBackupFolder()], appProperties: { [APP_KEY]: 'autobackup' } };
      const { body, headers } = multipart(meta, text);
      const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers, body });
      return (await res.json()).id;
    },
    async remove(id) {
      await api(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    },
  },
};
