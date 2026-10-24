// Google Drive 接続（Google Identity Services + Drive API v3）
// 権限は drive（ログインした人のマイドライブ全体）。このソフトは使う人専用なので、各自が自分のクライアントID で自分のドライブに使う。
// どの方法で置いたファイル・フォルダ（パソコン版 Google ドライブの同期フォルダなど）も見える。
//
// エディターが勝手にフォルダを作ることはない。フォルダは使う人が自分で作り（名前も自由）、それを選ぶ。
//
// 「ファイル」で最初に開くフォルダ（端末ごと。localStorage `novel-editor:gdrive.folder` = { id, name }）
//   未指定 … マイドライブ直下
//
// 自動バックアップ（同期）のフォルダ（端末ごと。`novel-editor:gdrive.backupFolder` = { id, name }）
//   「自動バックアップ」タブで選んだ・作ったフォルダに直接保存する。選ぶまでは保存しない。
//   一覧は、そのフォルダの中の「プレフィックス＋日時.json」すべて（Win_ など、どの端末・どの方法で置いたものも）。
//   端末どうしで同期するときは、すべての端末で同じフォルダを選ぶ。
//
// ログイン
//   ブラウザ               … ポップアップ。開けなければ、ページごと Google に移動して戻ってくる（リダイレクト）
//   ホーム画面のアプリ（PWA）… 最初からリダイレクト（PWA ではポップアップのログイン結果がアプリに戻らないことがあるため）
//   リダイレクトには、Google Cloud Console の「承認済みのリダイレクト URI」に公開 URL の登録が必要。
import { prefs } from '../db.js';

const SCOPE = 'https://www.googleapis.com/auth/drive';
// 自動バックアップのファイル名（プレフィックス＋日時）
const BACKUP_NAME_RE = /\d{8}T\d{6}Z\.json$/;
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const APP_KEY = 'novelEditor';
// ここにクライアントIDを書いておくと、どの端末でも設定画面での入力が不要になる（公開しても問題ない値）
const DEFAULT_CLIENT_ID = '';

let gisPromise = null;
let tokenClient = null;
// 自動バックアップの間は、ログイン画面を出さない（iPhone・iPad ではボタンを押したとき以外は出せないため）
let silent = 0;
// リダイレクトでページを離れる前に呼ぶ（書きかけの内容を端末に保存する）
let beforeRedirect = async () => {};

function clientId() { return prefs.get('gdrive.clientId', '') || DEFAULT_CLIENT_ID; }
function chosenFolder() { return prefs.get('gdrive.folder', null); }
function chosenBackupFolder() { return prefs.get('gdrive.backupFolder', null); }

// ホーム画面に追加したアプリとして開いているか
const isStandalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// ログインの鍵（約1時間有効）。アプリを開き直しても有効な間は使えるよう、この端末に残す。
// 全体バックアップ（novel-editor: で始まる設定）には入らない名前にしている。
const TOKEN_KEY = 'novel-editor-session:gdrive.token';
const STATE_KEY = 'novel-editor-session:gdrive.state';
let token = (() => {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    // 権限（scope）が変わった前の版の鍵は使わない（ログインし直してもらう）
    return t && t.clientId === clientId() && t.scope === SCOPE && Date.now() < t.expiresAt ? t : null;
  } catch { return null; }
})(); // { value, expiresAt, clientId, scope }
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

// Google から戻ってくる先。Google Cloud Console の「承認済みのリダイレクト URI」と1文字も違わない必要がある。
// ホーム画面に追加したときの URL が …/index.html でも …/ でも同じになるよう、最後の index.html は外す
function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/i, ''); }

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
    setToken({ value: p.get('access_token'), expiresAt: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000, clientId: clientId(), scope: SCOPE });
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
      if (window.google.accounts.oauth2.hasGrantedAllScopes && !window.google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
        reject(new Error('Google ドライブを使う許可がありません。もう一度ログインして、ドライブへのアクセスを許可してください'));
        return;
      }
      setToken({ value: resp.access_token, expiresAt: Date.now() + Number(resp.expires_in) * 1000, clientId: clientId(), scope: SCOPE });
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

// 選んだフォルダが使えるか（ゴミ箱に入っていない・消されていない）
async function folderUsable(id) {
  try {
    const f = await (await api(`${API}/files/${encodeURIComponent(id)}?fields=id,trashed,mimeType`)).json();
    return f.mimeType === FOLDER_MIME && !f.trashed;
  } catch (e) {
    if (/not found|404/i.test(e.message)) return false;
    throw e;
  }
}

// 自動バックアップのフォルダ（選んだフォルダそのもの）。選んでいない・使えないときはエラー（勝手に別の場所へは保存しない）
async function backupFolderId() {
  const chosen = chosenBackupFolder();
  if (!chosen?.id) throw new Error('自動バックアップのフォルダが決まっていません。「設定」→「自動バックアップ」でフォルダを選んでください');
  if (!(await folderUsable(chosen.id))) {
    throw new Error(`自動バックアップのフォルダ「${chosen.name}」が見つかりません（ゴミ箱に入れた・消した）。「設定」→「自動バックアップ」でフォルダを選び直してください`);
  }
  return chosen.id;
}

// 条件に合うファイルを全部（ページをまたいで）
async function listAll(query, fields = 'id,name') {
  const out = [];
  let pageToken = '';
  do {
    const res = await api(`${API}/files?q=${encodeURIComponent(query)}&pageSize=1000&fields=nextPageToken,files(${fields})${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}`);
    const j = await res.json();
    out.push(...j.files);
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return out;
}

// 「ファイル」で保存する先（フォルダの指定がないとき）：選んだフォルダ、なければマイドライブ直下
function saveFolderId() {
  return chosenFolder()?.id || 'root';
}

// mime：中身の種類（TUZURI のファイルは application/json、テキストは text/plain）
function multipart(metadata, text, mime = 'application/json') {
  const boundary = 'novel-editor-' + Math.random().toString(36).slice(2);
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: ${mime}; charset=UTF-8\r\n\r\n${text}\r\n` +
    `--${boundary}--`;
  return { body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } };
}

async function patchFile(fileId, text, name, workId, mime) {
  const { body, headers } = multipart({ name, appProperties: { [APP_KEY]: 'work', ...(workId ? { workId } : {}) } }, text, mime);
  const res = await api(`${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=multipart&fields=id`, { method: 'PATCH', headers, body });
  return (await res.json()).id;
}

export const gdrive = {
  id: 'gdrive',
  label: 'Google ドライブ',
  // エディター内のフォルダ選択画面の表示
  rootName: 'マイドライブ',
  browseHint: 'マイドライブのフォルダが出ます（共有されたフォルダは出ません）。',

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
      hint: 'Google Cloud Console で作成した「ウェブ アプリケーション」のクライアントID。「承認済みの JavaScript 生成元」と「承認済みのリダイレクト URI」に公開 URL を登録し、スコープに …/auth/drive を追加してください（手順は README）。',
    },
  ],

  preload() { if (clientId() && !isStandalone) loadGis().catch(() => {}); },

  async signIn() { await getToken(); },

  signOut() {
    if (token && window.google?.accounts) window.google.accounts.oauth2.revoke(token.value, () => {});
    setToken(null);
  },

  // ---------- 「ファイル」で最初に開くフォルダ ----------

  // 戻り値: { id, name, isDefault }
  folderInfo() {
    const f = chosenFolder();
    return f ? { ...f, isDefault: false } : { id: '', name: 'マイドライブ（直下）', isDefault: true };
  },

  resetFolder() { prefs.set('gdrive.folder', null); },

  // ---------- エディター内のフォルダ選択画面用 ----------

  // マイドライブのフォルダすべて（自分のもの）。戻り値: [{ id, name, parents }]
  async folders() {
    return listAll(`mimeType='${FOLDER_MIME}' and trashed=false and 'me' in owners`, 'id,name,parents');
  },

  // フォルダの中のファイル（フォルダは除く。新しい順）。戻り値: [{ id, name, modifiedTime }]
  async filesIn(folderId) {
    const query = `${q(folderId)} in parents and mimeType!='${FOLDER_MIME}' and trashed=false`;
    const res = await api(`${API}/files?q=${encodeURIComponent(query)}&orderBy=modifiedTime desc&pageSize=500&fields=files(id,name,modifiedTime)`);
    return (await res.json()).files;
  },

  // フォルダを作る（parentId がなければマイドライブの直下）。保存先の設定は変えない。戻り値: { id, name, parents, existed }
  // 同じ場所に同じ名前のフォルダが既にあれば、作らずにそれを返す（existed: true）。同じ名前のフォルダが並ばないように
  async makeFolder(name, parentId = null) {
    const parent = parentId || 'root';
    const query = `name = ${q(name)} and mimeType='${FOLDER_MIME}' and ${q(parent)} in parents and trashed=false`;
    const found = (await (await api(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,parents)&pageSize=1`)).json()).files[0];
    if (found) return { ...found, existed: true };
    const res = await api(`${API}/files?fields=id,name,parents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId || 'root'], appProperties: { [APP_KEY]: 'folder-chosen' } }),
    });
    return res.json();
  },

  // 保存先フォルダ（「クラウド」タブ）を決める
  setFolder(folder) { prefs.set('gdrive.folder', folder ? { id: folder.id, name: folder.name } : null); },

  // 自動バックアップのフォルダ（「自動バックアップ」タブで選ぶ）。戻り値: { id, name }／null（まだ選んでいない）
  backupFolderInfo() { return chosenBackupFolder(); },
  setBackupFolder(folder) { prefs.set('gdrive.backupFolder', folder ? { id: folder.id, name: folder.name } : null); },

  // フォルダ選択画面で最初に開くフォルダ（「ファイル」の保存先。なければ一番上）
  async defaultFolderId() { return chosenFolder()?.id || null; },

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
  async save(text, name, fileId = null, { workId = '', mime = 'application/json', folderId = null } = {}) {
    if (fileId) {
      try {
        return await patchFile(fileId, text, name, workId, mime);
      } catch (e) {
        // ゴミ箱で削除された等で見つからない場合は新しく作り直す
        if (!/not found|404/i.test(e.message)) throw e;
      }
    }
    // folderId：エディター内のフォルダ選択画面で選んだフォルダ（なければ保存先フォルダ）
    const parent = folderId || saveFolderId();
    const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0];
    const base = ext ? name.slice(0, -ext.length) : name;
    let finalName = name;
    for (let n = 2; n < 100; n++) {
      const query = `name = ${q(finalName)} and ${q(parent)} in parents and trashed=false`;
      const res = await api(`${API}/files?q=${encodeURIComponent(query)}&fields=files(id,appProperties)&pageSize=10`);
      const same = (await res.json()).files;
      if (!same.length) break;
      const mine = workId && same.find((f) => f.appProperties?.workId === workId);
      if (mine) return patchFile(mine.id, text, finalName, workId, mime);
      finalName = `${base} (${n})${ext}`;
    }
    const meta = { name: finalName, mimeType: mime, parents: [parent], appProperties: { [APP_KEY]: 'work', ...(workId ? { workId } : {}) } };
    const { body, headers } = multipart(meta, text, mime);
    const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers, body });
    return (await res.json()).id;
  },

  // ---------- 自動バックアップ（同期）用 ----------
  backups: {
    // 選んであるか（選ぶまでは自動バックアップしない）
    get hasFolder() { return !!chosenBackupFolder()?.id; },
    // 保存するフォルダの表示名
    get folderName() { return chosenBackupFolder()?.name || ''; },
    // 戻り値: [{ id, name }]（全端末のもの）：選んだフォルダの中の「プレフィックス＋日時.json」すべて
    async list() {
      const id = await backupFolderId();
      return (await listAll(`${q(id)} in parents and mimeType!='${FOLDER_MIME}' and trashed=false`))
        .filter((f) => BACKUP_NAME_RE.test(f.name))
        .map((f) => ({ id: f.id, name: f.name }));
    },
    async read(id) {
      const res = await api(`${API}/files/${encodeURIComponent(id)}?alt=media`);
      return res.text();
    },
    async write(name, text) {
      // 保存の前に、選んだフォルダが使えるか確かめる（使えなければエラー。勝手に別の場所へは保存しない）
      const folder = await backupFolderId();
      const meta = { name, mimeType: 'application/json', parents: [folder], appProperties: { [APP_KEY]: 'autobackup' } };
      const { body, headers } = multipart(meta, text);
      const res = await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers, body });
      return (await res.json()).id;
    },
    async remove(id) {
      await api(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
    },
  },
};
