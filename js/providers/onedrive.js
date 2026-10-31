// OneDrive 接続（Microsoft ID プラットフォーム：認可コード＋PKCE ／ Microsoft Graph v1.0）
// gdrive.js と同じ形のオブジェクト。各自が Microsoft Entra で登録した自分のアプリ（クライアントID）で、自分の OneDrive に使う。
// サーバーは使わない（ブラウザだけで動く）。
// 権限は Files.ReadWrite.AppFolder（OneDrive の「アプリ\<アプリの名前>」フォルダの中だけ）と offline_access（ログインの更新）。
//   7.7.4 より前は Files.ReadWrite（OneDrive 全体）。権限が変わった前の版の鍵は使わず、ログインし直してもらう。
//   アプリのフォルダ（approot）は、初めて使うときに OneDrive が自動で作る。名前は Microsoft Entra で登録したアプリの名前。
//   フォルダ選択画面の「一番上」は、OneDrive の一番上ではなく、このアプリのフォルダ。
//
// アプリのフォルダの中のフォルダは、使う人が自分で作り（名前も自由）、それを選ぶ。
//   「ファイル」で最初に開くフォルダ（端末ごと）  … localStorage `novel-editor:onedrive.folder` = { id, name }（未指定は一番上）
//   自動バックアップのフォルダ（端末ごと）        … `novel-editor:onedrive.backupFolder` = { id, name }（選ぶまでは保存しない）
//
// ログイン
//   ページごと Microsoft のログイン画面へ移動し、公開 URL に戻ってくる（?code=…&state=od-…）。
//   戻ってきたら、コードをログインの鍵（約1時間）と更新用の鍵（約24時間）に替える。更新用の鍵がある間は、画面を出さずに鍵を新しくできる。
//   Microsoft Entra のアプリの登録で、公開 URL を「シングルページ アプリケーション（SPA）」のリダイレクト URI に登録する必要がある。
//   Google ドライブ（gdrive.js）は # 以降で結果を受け取るので、こちらは ? 以降（response_mode=query）で受け取り、混ざらないようにする。
import { prefs } from '../db.js';

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'Files.ReadWrite.AppFolder offline_access';
// アプリのフォルダ（一番上）
const APPROOT = '/me/drive/special/approot';
// 自動バックアップのファイル名（プレフィックス＋日時）
const BACKUP_NAME_RE = /(\d{8}T\d{6}Z|\d{8}-\d{6})\.json$/;
// これより大きいファイルは分けて送る（アップロード セッション）。分ける大きさは 320KiB の倍数にする決まり
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
const CHUNK = 320 * 1024 * 10;
const STATE_PREFIX = 'od-';
// ここにクライアントIDを書いておくと、どの端末でも設定画面での入力が不要になる（公開しても問題ない値）
const DEFAULT_CLIENT_ID = '';

function clientId() { return String(prefs.get('onedrive.clientId', '') || DEFAULT_CLIENT_ID).trim(); }
function chosenFolder() { return prefs.get('onedrive.folder', null); }
function chosenBackupFolder() { return prefs.get('onedrive.backupFolder', null); }

// ログインの鍵。全体バックアップ（novel-editor: で始まる設定）には入らない名前にしている
const TOKEN_KEY = 'novel-editor-session:onedrive.token';
const PKCE_KEY = 'novel-editor-session:onedrive.pkce';

let silent = 0;
let beforeRedirect = async () => {};

// 前の版（権限が違う）の鍵が残っていたか。アプリ側で一度だけ、ログインし直しとフォルダの移動を案内する
let scopeChanged = false;
// { access, expiresAt, refresh, clientId, scope }
let token = (() => {
  try {
    const t = JSON.parse(localStorage.getItem(TOKEN_KEY));
    if (!t || t.clientId !== clientId()) return null;
    // 権限（scope）が変わった前の版の鍵は使わない（更新用の鍵も、前の権限のものなので捨てる）
    if (t.scope !== SCOPES) {
      scopeChanged = true;
      localStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return t;
  } catch { return null; }
})();
function setToken(t) {
  token = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* 残せなくても続行 */ }
}
const tokenOk = () => !!token && token.clientId === clientId() && token.scope === SCOPES;
const accessValid = () => tokenOk() && Date.now() < token.expiresAt - 60_000;
const canRefresh = () => tokenOk() && !!token.refresh;

class NeedLoginError extends Error {
  constructor() { super('OneDrive へのログインが必要です'); this.name = 'NeedLoginError'; }
}

// ---------- ログイン（認可コード＋PKCE） ----------

// 戻ってくる先。Microsoft Entra の「リダイレクト URI（SPA）」と1文字も違わない必要がある（gdrive.js と同じ決め方）
function redirectUri() { return location.origin + location.pathname.replace(/index\.html$/i, ''); }

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const randomString = (n = 32) => base64url(crypto.getRandomValues(new Uint8Array(n)));

async function startRedirectLogin() {
  if (!clientId()) throw new Error('「設定」→「クラウド」で OneDrive のアプリケーション（クライアント）ID を入れてください');
  const verifier = randomString(48);
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const state = STATE_PREFIX + randomString(16);
  try { localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, clientId: clientId(), redirectUri: redirectUri() })); } catch { /* 無視 */ }
  const url = new URL(`${AUTH}/authorize`);
  const params = {
    client_id: clientId(), response_type: 'code', redirect_uri: redirectUri(), response_mode: 'query',
    scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256',
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  await beforeRedirect().catch(() => {});
  location.href = url.toString();
  return new Promise(() => {}); // ページが移動するので戻らない
}

// トークンの窓口に送る。失敗の内容を分かりやすくする
async function tokenRequest(params) {
  let res;
  try {
    res = await fetch(`${AUTH}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId(), scope: SCOPES, ...params }).toString(),
    });
  } catch {
    throw new Error('OneDrive のログインの確認に失敗しました（ネット接続を確認してください）');
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    const desc = String(j.error_description || j.error || res.status);
    const e = new Error(/AADSTS9002326/.test(desc)
      ? 'OneDrive にログインできません：Microsoft Entra のアプリの「リダイレクト URI」が「Web」になっています。「シングルページ アプリケーション」として登録してください（README の手順）'
      : 'OneDrive のログインに失敗しました（' + desc.split(/\r?\n/)[0] + '）');
    e.oauthError = j.error || '';
    throw e;
  }
  setToken({
    access: j.access_token,
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    refresh: j.refresh_token || token?.refresh || '',
    clientId: clientId(),
    scope: SCOPES,
  });
  return token.access;
}

let refreshing = null;
function refreshAccess() {
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh })
      .catch((e) => {
        // 更新用の鍵が切れた・取り消された：ログインし直してもらう（ネットが切れているだけのときは鍵を残す）
        if (e.oauthError) setToken(null);
        throw e;
      })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// Microsoft から戻ってきたとき（? 以降に code と state）。読み込んだ時点で一度だけ調べ、URL から消す
let redirectResult = null; // { ok: true } / { ok: false, message }
let redirectPromise = null;
(function handleRedirectResult() {
  const q = new URLSearchParams(location.search);
  const state = q.get('state') || '';
  if (!state.startsWith(STATE_PREFIX) || !(q.has('code') || q.has('error'))) return;
  history.replaceState(null, '', location.pathname + location.hash);
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(PKCE_KEY)); localStorage.removeItem(PKCE_KEY); } catch { /* 無視 */ }
  if (!saved || saved.state !== state) {
    redirectResult = { ok: false, message: 'OneDrive へのログインを確認できませんでした。もう一度ログインしてください' };
    return;
  }
  if (q.get('error')) {
    redirectResult = { ok: false, message: `OneDrive にログインできませんでした（${(q.get('error_description') || q.get('error')).split(/\r?\n/)[0]}）` };
    return;
  }
  redirectPromise = tokenRequest({ grant_type: 'authorization_code', code: q.get('code'), redirect_uri: saved.redirectUri, code_verifier: saved.verifier })
    .then(() => { redirectResult = { ok: true }; }, (e) => { redirectResult = { ok: false, message: e.message }; });
})();

// 有効な鍵を返す。更新できなければログイン画面へ移動する（自動バックアップ中は移動しない）
async function getToken() {
  if (accessValid()) return token.access;
  if (canRefresh()) {
    try { return await refreshAccess(); } catch (e) { if (!e.oauthError) throw e; }
  }
  if (silent) throw new NeedLoginError();
  return startRedirectLogin();
}

// ---------- Graph ----------

async function api(path, options = {}, retry = true) {
  const t = await getToken();
  const res = await fetch(path.startsWith('http') ? path : GRAPH + path, {
    ...options, headers: { ...(options.headers || {}), Authorization: 'Bearer ' + t },
  });
  if (res.status === 401 && retry) {
    if (token) setToken({ ...token, expiresAt: 0 }); // 鍵を更新してもう一度
    return api(path, options, false);
  }
  if (!res.ok) {
    let msg = res.status + ' ' + res.statusText;
    let code = '';
    try { const j = await res.json(); msg = j.error?.message || msg; code = j.error?.code || ''; } catch { /* 本文なし */ }
    const e = new Error('OneDrive エラー: ' + msg);
    e.status = res.status;
    e.code = code;
    throw e;
  }
  return res;
}

const enc = (name) => encodeURIComponent(name);
// 置き場所の指定：フォルダの中の名前で（parentId がなければ一番上＝アプリのフォルダ）／ファイルの ID で
const byPath = (parentId, name) => (parentId ? `/me/drive/items/${enc(parentId)}:/${enc(name)}:` : `${APPROOT}:/${enc(name)}:`);
const byId = (id) => `/me/drive/items/${enc(id)}`;
const childrenOf = (parentId) => (parentId ? `/me/drive/items/${enc(parentId)}/children` : `${APPROOT}/children`);

// アプリのフォルダの ID（フォルダの並びを、どこまでさかのぼるかに使う）。初めて呼んだときに OneDrive がフォルダを作る
let appRootPromise = null;
function appRootId() {
  if (!appRootPromise) {
    appRootPromise = api(`${APPROOT}?$select=id`).then((r) => r.json()).then((j) => j.id)
      .catch((e) => { appRootPromise = null; throw e; });
  }
  return appRootPromise;
}
// アプリのフォルダの外（前の版で選んだフォルダなど）は、この権限では見えない（403）。見つからないのと同じに扱う
const outsideAppFolder = (e) => e?.status === 403 || e?.status === 404;
const SELECT = '$select=id,name,folder,file,parentReference,lastModifiedDateTime,deleted';

// フォルダの中身すべて（ページをまたいで）
async function children(parentId) {
  const out = [];
  let url = `${childrenOf(parentId)}?${SELECT}&$top=200`;
  while (url) {
    const j = await (await api(url)).json();
    out.push(...(j.value || []));
    url = j['@odata.nextLink'] || '';
  }
  return out;
}

const toFolder = (it) => ({ id: it.id, name: it.name, parents: it.parentReference?.id ? [it.parentReference.id] : [] });

async function getItem(path) {
  try {
    return await (await api(path)).json();
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// 中身を読む（ダウンロード用の URL から。なければ /content から）。bytes：文字にせず ArrayBuffer で返す（TXT・ZIP の取り込み）
async function download(id, { bytes = false } = {}) {
  const it = await (await api(byId(id))).json();
  const url = it['@microsoft.graph.downloadUrl'];
  let res;
  if (url) {
    res = await fetch(url);
    if (!res.ok) throw new Error('OneDrive エラー: ファイルを読めませんでした（' + res.status + '）');
  } else {
    res = await api(`${byId(id)}/content`);
  }
  return bytes ? res.arrayBuffer() : res.text();
}

// 書き込む。target は byPath() か byId()。conflict：'replace'（上書き）／'fail'（同じ名前があればエラー）
async function upload(target, text, mime = 'application/json', conflict = 'replace') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  if (blob.size <= SIMPLE_UPLOAD_MAX) {
    const res = await api(`${target}/content?@microsoft.graph.conflictBehavior=${conflict}`, {
      method: 'PUT', headers: { 'Content-Type': `${mime};charset=utf-8` }, body: blob,
    });
    return res.json();
  }
  // 大きいファイル：アップロード セッションで分けて送る（送り先の URL には鍵を付けない決まり）
  const session = await (await api(`${target}/createUploadSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': conflict } }),
  })).json();
  let last = null;
  for (let start = 0; start < blob.size; start += CHUNK) {
    const end = Math.min(start + CHUNK, blob.size);
    const res = await fetch(session.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Range': `bytes ${start}-${end - 1}/${blob.size}` },
      body: blob.slice(start, end),
    });
    if (!res.ok) {
      fetch(session.uploadUrl, { method: 'DELETE' }).catch(() => {});
      throw new Error('OneDrive エラー: 大きいファイルの書き込みに失敗しました（' + res.status + '）');
    }
    last = res;
  }
  return last.json();
}

// 選んだフォルダが使えるか（消されていない・アプリのフォルダの中にある）
async function folderUsable(id) {
  try {
    const it = await getItem(`${byId(id)}?$select=id,folder,deleted`);
    return !!it && !!it.folder && !it.deleted;
  } catch (e) {
    if (outsideAppFolder(e)) return false;
    throw e;
  }
}

// 自動バックアップのフォルダ（選んだフォルダそのもの）。選んでいない・使えないときはエラー（勝手に別の場所へは保存しない）
async function backupFolderId() {
  const chosen = chosenBackupFolder();
  if (!chosen?.id) throw new Error('自動バックアップのフォルダが決まっていません。「設定」→「自動バックアップ」でフォルダを選んでください');
  if (!(await folderUsable(chosen.id))) {
    throw new Error(`自動バックアップのフォルダ「${chosen.name}」が使えません。消したか、OneDrive の「アプリ」の中のあや綴りのフォルダの外にあります（7.7.4 からは、そのフォルダの中しか使えません）。フォルダをその中へ移すか、「設定」→「自動バックアップ」でフォルダを選び直してください`);
  }
  return chosen.id;
}

// 同じ作品のファイルか（中身の workId で確かめる）
async function sameWork(item, workId) {
  if (!workId || !item?.file) return false;
  try {
    const text = await download(item.id);
    return new RegExp(`"workId"\\s*:\\s*"${workId.replace(/[^\w-]/g, '')}"`).test(text);
  } catch { return false; }
}

export const onedrive = {
  id: 'onedrive',
  label: 'OneDrive',
  rootName: 'アプリのフォルダ',
  browseHint: 'OneDrive の「アプリ」の中にある、あや綴り用のフォルダの中だけが出ます（それより外のフォルダは、この権限では見えません）。パソコンの OneDrive では「アプリ」（Apps）の中にあります。',
  // 前の版の権限の鍵が残っていた（ログインし直しが必要）
  get scopeChanged() { return scopeChanged; },

  isConfigured() { return !!clientId(); },
  isSignedIn() { return accessValid() || canRefresh(); },
  // 画面を出さずに使える状態か（鍵が有効、または更新用の鍵がある）
  canSaveSilently() { return accessValid() || canRefresh(); },
  // 戻ってきたときのコードを鍵に替え終わるのを待つ（起動時に一度）
  ready() { return redirectPromise || Promise.resolve(); },
  takeRedirectResult() { const r = redirectResult; redirectResult = null; return r; },
  set onBeforeRedirect(fn) { beforeRedirect = fn; },
  async silently(fn) {
    silent++;
    try { return await fn(); } finally { silent--; }
  },

  settings: [
    {
      key: 'onedrive.clientId',
      label: 'OneDrive（Microsoft）アプリケーション（クライアント）ID',
      placeholder: '00000000-0000-0000-0000-000000000000',
      hint: 'Microsoft Entra 管理センターの「アプリの登録」で作ったアプリの ID。リダイレクト URI に公開 URL を「シングルページ アプリケーション」として登録し、API のアクセス許可に Microsoft Graph の Files.ReadWrite.AppFolder と offline_access を追加してください（手順は README）。',
    },
  ],

  preload() {},

  async signIn() { await getToken(); },

  signOut() { setToken(null); },

  // ---------- 「ファイル」で最初に開くフォルダ ----------
  folderInfo() {
    const f = chosenFolder();
    return f ? { ...f, isDefault: false } : { id: '', name: 'アプリのフォルダ（一番上）', isDefault: true };
  },
  resetFolder() { prefs.set('onedrive.folder', null); },
  setFolder(folder) { prefs.set('onedrive.folder', folder ? { id: folder.id, name: folder.name } : null); },
  async defaultFolderId() { return chosenFolder()?.id || null; },

  // ---------- エディター内のフォルダ選択画面用（フォルダは開くたびに読む） ----------

  // フォルダの中のフォルダ（parentId がなければ一番上）。戻り値: [{ id, name, parents }]
  async childFolders(parentId = null) {
    return (await children(parentId)).filter((it) => it.folder && !it.deleted).map(toFolder);
  },

  // 一番上（アプリのフォルダ）からそのフォルダまでの並び（一番上は含まない）。
  // 見つからない・アプリのフォルダの外（前の版で選んだフォルダなど）なら null
  async folderPath(id) {
    const rootId = await appRootId();
    if (id === rootId) return [];
    const path = [];
    let cur = id;
    for (let i = 0; cur && i < 30; i++) {
      let it;
      try {
        it = await getItem(`${byId(cur)}?$select=id,name,folder,parentReference,root,deleted`);
      } catch (e) {
        if (outsideAppFolder(e)) return null;
        throw e;
      }
      // OneDrive の一番上まで来た＝アプリのフォルダの外
      if (!it || it.deleted || it.root || !it.folder) return null;
      path.unshift(toFolder(it));
      // 親がアプリのフォルダなら終わり
      if (it.parentReference?.id === rootId) return path;
      if (!it.parentReference?.id) return null;
      cur = it.parentReference.id;
    }
    return null;
  },

  // フォルダの中のファイル（フォルダは除く。新しい順）。戻り値: [{ id, name, modifiedTime }]
  async filesIn(folderId) {
    return (await children(folderId)).filter((it) => it.file && !it.deleted)
      .map((it) => ({ id: it.id, name: it.name, modifiedTime: it.lastModifiedDateTime }))
      .sort((a, b) => String(b.modifiedTime).localeCompare(String(a.modifiedTime)));
  },

  // フォルダを作る（parentId がなければ一番上）。同じ場所に同じ名前のフォルダがあれば、作らずにそれを返す（existed: true）
  async makeFolder(name, parentId = null) {
    // 一番上は、アプリのフォルダの ID で指定する（special/approot のままではフォルダを作れないことがある）
    parentId = parentId || await appRootId();
    const existing = await getItem(`${byPath(parentId, name).replace(/:$/, '')}?$select=id,name,folder,parentReference`);
    if (existing?.folder) return { ...toFolder(existing), existed: true };
    if (existing) throw new Error(`同じ場所に「${name}」という名前のファイルがあるので、フォルダを作れません`);
    const res = await api(`${childrenOf(parentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
    });
    return toFolder(await res.json());
  },

  // 自動バックアップのフォルダ（「自動バックアップ」タブで選ぶ）
  backupFolderInfo() { return chosenBackupFolder(); },
  setBackupFolder(folder) { prefs.set('onedrive.backupFolder', folder ? { id: folder.id, name: folder.name } : null); },

  // ---------- 手動で保存したファイル ----------

  // 戻り値: [{ id, name, modifiedTime }]（「ファイル」の保存先フォルダの .json）
  async list() {
    return (await this.filesIn(chosenFolder()?.id || null)).filter((f) => /\.json$/i.test(f.name));
  },

  async load(fileId) { return download(fileId); },
  async loadBytes(fileId) { return download(fileId, { bytes: true }); },

  /**
   * fileId があれば上書き、なければ保存先フォルダに新しく作る。戻り値: { id, name }（name は実際に保存した名前）
   * 新しく作るとき、同じフォルダに同じ名前のファイルがあれば：
   *   同じ作品（中身の workId が一致）→ そのファイルを上書き
   *   別の作品                        → 上書きせず、名前の後ろに「 (2)」などを付けて別のファイルにする
   */
  async save(text, name, fileId = null, { workId = '', mime = 'application/json', folderId = null } = {}) {
    const done = (it) => ({ id: it.id, name: it.name });
    if (fileId) {
      try {
        return done(await upload(byId(fileId), text, mime, 'replace'));
      } catch (e) {
        if (e.status !== 404) throw e; // 消されていたら新しく作る
      }
    }
    const parent = folderId || chosenFolder()?.id || await appRootId();
    const ext = (name.match(/\.[a-z0-9]+$/i) || [''])[0];
    const base = ext ? name.slice(0, -ext.length) : name;
    let finalName = name;
    for (let n = 2; n < 100; n++) {
      const same = await getItem(`${byPath(parent, finalName).replace(/:$/, '')}?$select=id,name,file,folder`);
      if (!same) break;
      if (await sameWork(same, workId)) return done(await upload(byId(same.id), text, mime, 'replace'));
      finalName = `${base} (${n})${ext}`;
    }
    return done(await upload(byPath(parent, finalName), text, mime, 'fail'));
  },

  // ---------- 自動バックアップ（同期）用 ----------
  backups: {
    get hasFolder() { return !!chosenBackupFolder()?.id; },
    get folderName() { return chosenBackupFolder()?.name || ''; },
    // 戻り値: [{ id, name }]（全端末のもの）：選んだフォルダの中の「プレフィックス＋日時.json」すべて
    async list() {
      const id = await backupFolderId();
      return (await children(id)).filter((it) => it.file && !it.deleted && BACKUP_NAME_RE.test(it.name))
        .map((it) => ({ id: it.id, name: it.name }));
    },
    async read(id) { return download(id); },
    async write(name, text) {
      // 保存の前に、選んだフォルダが使えるか確かめる（使えなければエラー。勝手に別の場所へは保存しない）
      const folder = await backupFolderId();
      return (await upload(byPath(folder, name), text, 'application/json', 'replace')).id;
    },
    // 「バックアップファイルの管理」用：フォルダの中の .json すべて（名前の形を問わない）
    async listAny() {
      const id = await backupFolderId();
      return (await children(id)).filter((it) => it.file && !it.deleted && /\.json$/i.test(it.name))
        .map((it) => ({ id: it.id, name: it.name, modifiedTime: it.lastModifiedDateTime }));
    },
    // 自動整理（残す件数を超えた分）：ごみ箱へ
    async remove(id) {
      await api(byId(id), { method: 'DELETE' });
    },
    // 「バックアップファイルの管理」の削除：ごみ箱にも残さず消す。
    // 個人用 OneDrive など、完全削除が使えないときはごみ箱へ移す。戻り値：'deleted'／'recycled'
    async removeForever(id) {
      try {
        await api(`${byId(id)}/permanentDelete`, { method: 'POST' });
        return 'deleted';
      } catch (e) {
        if (![400, 403, 404, 405, 501].includes(e.status)) throw e;
      }
      await api(byId(id), { method: 'DELETE' });
      return 'recycled';
    },
  },
};
