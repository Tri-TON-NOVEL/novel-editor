// 自動バックアップ（同期）
// 役割は2つ。
//   1. いざというときに戻すためのバックアップ（全作品・ひな型・設定を1ファイルに）
//   2. 複数の端末（Windows・Mac・iPhone・iPad・Android）のあいだの、楽観的な同期
//
// 保存先（端末ごとに選ぶ）
//   'folder' … 普通のフォルダ（PC の Chrome・Edge、Android の Chrome。ネットワークドライブ、OneDrive・iCloud Drive などの同期フォルダも可）
//   'cloud'  … クラウド（API）。「設定」→「クラウド」で選んだ Google ドライブか OneDrive の、自分で選んだフォルダ。iPhone・iPad はこちらだけ
//              （以前の版の 'gdrive' は 'cloud' として読む）
//
// ファイル名：プレフィックス + 日時（世界時）  例：iPad_20261022T001500Z.json
//   名前の日時でどれが新しいかを決める（同期ソフトがファイルの更新日時を変えても困らないように）。
//
// 端末に残す記録（設定 sync.*。全体バックアップには入らない）
//   sync.last  … 最後に同期した（自分で保存した、または読み込んだ）バックアップ { name, at }
//   sync.dirty … 最後のバックアップのあとに書き換えたか
//   sync.mine  … この端末が保存したファイル名（新しい順）。残す件数を超えたら、この中の古いものだけ消す
//   sync.seen / sync.seenAt … 確認済みの最新バックアップ（過去版を意図して選んだ後、既存の新しい版を再通知しない）
//
// 起動したとき：保存先でいちばん新しいバックアップを、sync.last とくらべる（findNewer）。
//   同じ → 何もしない。他の端末のほうが新しい → 読み込むかを聞く（画面はアプリ側）。
//   読み込むときは作品ごとにまとめる（loadAndMerge）。両方で書き換えた作品だけ、どちらを使うか聞く。
// 起動時の確認が済むまでは保存しない（先に保存すると、他の端末の新しいバックアップが隠れてしまうため）。
import { meta, prefs } from './db.js';
import { makeArchive, openArchive } from './archive.js';
import { parseBackupHead } from './backup.js';

export const DEFAULT_INTERVAL_MIN = 10;
export const DEFAULT_KEEP = 200;
const CHECK_MS = 30_000;       // 保存が必要かを確かめる間隔
const LEAVE_MIN_MS = 30_000;   // 画面を離れるときの保存の最短間隔（タブを切り替えるたびに増えないように）
const IDLE_SAVE_MS = 5 * 60_000; // 入力がこれだけ止まったら、自動バックアップする（書き終えた区切りで保存）
const IDLE_MS = 20_000;        // 書き続けているときの保存（保存間隔ごと）は、入力がこれだけ止まってから
const IDLE_MAX_MS = 30 * 60_000; // 打ち続けていても、保存間隔からこれ以上は待たない
const DIR_KEY = 'autoBackupDir';
// 前の名前（…20261030T073000Z.json。世界時）と、今の名前（…_20261030-073000.ayabackup。端末の時刻）の両方を読む。
// 0.50 までの .json（…_20261030-073000.json）も、一覧に出して読めるようにする
const NAME_RE = /^(.*?)(\d{8}T\d{6}Z|\d{8}-\d{6})\.(?:ayabackup|json)$/;

export const folderSupported = 'showDirectoryPicker' in window;

// ---------- 設定 ----------

export function defaultPrefix() {
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return 'iPhone_';
  if (/iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'iPad_';
  if (/Android/.test(ua)) return 'android_';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac_';
  if (/Windows/.test(ua)) return 'Win_';
  return 'PC_';
}
// ファイル名に使えない文字は _ にする
export function cleanPrefix(s) { return String(s ?? '').replace(/[\\/:*?"<>|\s]/g, '_').slice(0, 40); }
export function prefix() { return cleanPrefix(prefs.get('sync.prefix', '') || defaultPrefix()); }
export function mode() {
  const m = prefs.get('sync.mode', 'off');
  return m === 'gdrive' ? 'cloud' : m; // 以前の版の「Google ドライブ」方式
}
export function intervalMin() { return Math.max(1, Number(prefs.get('autoBackupInterval', DEFAULT_INTERVAL_MIN)) || DEFAULT_INTERVAL_MIN); }
export function keepCount() { return Math.max(1, Number(prefs.get('autoBackupKeep', DEFAULT_KEEP)) || DEFAULT_KEEP); }
export function lastBackup() { return prefs.get('sync.last', null); }
export function folderName() { return mode() === 'cloud' ? drive?.backups.folderName || '' : dir?.name || ''; }
// クラウド方式で使うサービス（Google ドライブ／OneDrive）
export function cloud() { return drive; }

export function deviceId() {
  let id = prefs.get('sync.deviceId', '');
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); prefs.set('sync.deviceId', id); }
  return id;
}

// ---------- 状態 ----------
// state: 'off' | 'on' | 'need-folder'（保存先のフォルダをまだ選んでいない） | 'need-permission'（フォルダの許可切れ）
//        | 'need-login'（クラウドのログイン切れ） | 'unsupported'
let state = 'off';
let lastError = '';
let dir = null;
let drive = null;
let dirty = !!prefs.get('sync.dirty', false);
let checked = false;   // 起動時の確認が済んだか
let lastRun = 0;
let lastEdit = 0;      // 最後に書き換えた時刻
let dirtySince = 0;    // 保存していない変更が始まった時刻（前回から残っている変更は 0：すぐ保存してよい）
let running = false;
let autoBuilder = null;
let listener = () => {};
let newerHandler = () => {};

function setState(s) { state = s; listener(); }
export function onChange(fn) { listener = fn; }
// 保存しようとしたら、他の端末のほうが新しかったとき
export function onNewer(fn) { newerHandler = fn; }
export function getState() { return state; }
export function getError() { return lastError; }
export function isChecked() { return checked; }
export function isDirty() { return dirty; }
export function isRunning() { return running; }

export async function init({ provider, makeAutoBackup = null }) {
  drive = provider || null;
  autoBuilder = makeAutoBackup;
  setInterval(tick, CHECK_MS);
  await refresh();
}

// 設定や許可の状態から、今の状態を決め直す
export async function refresh() {
  const m = mode();
  lastError = '';
  if (m === 'folder') {
    if (!folderSupported) { setState('unsupported'); return; }
    dir = dir || await meta.get(DIR_KEY).catch(() => null);
    if (!dir) { setState('need-folder'); return; }
    const perm = await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
    setState(perm === 'granted' ? 'on' : 'need-permission');
  } else if (m === 'cloud') {
    if (!drive || !drive.isConfigured()) { setState('unsupported'); return; }
    // フォルダを選ぶまでは保存しない（エディターが勝手にフォルダを作らない）
    if (!drive.backups.hasFolder) { setState('need-folder'); return; }
    setState(drive.canSaveSilently() ? 'on' : 'need-login');
  } else {
    setState('off');
  }
}

export async function setMode(m) {
  prefs.set('sync.mode', m);
  checked = false;
  await refresh();
}

// フォルダを選ぶ（ボタンを押したときに呼ぶ）
export async function chooseFolder() {
  if (!folderSupported) throw new Error('このブラウザではフォルダを選べません（PC の Chrome・Edge、Android の Chrome で使えます）');
  let picked;
  try {
    picked = await window.showDirectoryPicker({ id: 'novel-editor-backup', mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') return false;
    throw e;
  }
  dir = picked;
  await meta.set(DIR_KEY, dir);
  prefs.set('sync.mode', 'folder');
  checked = false;
  await refresh();
  return true;
}

// フォルダの書き込み許可をもらい直す／クラウドにログインする（ボタンを押したときに呼ぶ）
export async function resume() {
  if (mode() === 'folder') {
    if (!dir) return false;
    const perm = await dir.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
  } else if (mode() === 'cloud') {
    await drive.signIn(); // ページごとログイン画面へ移動することがある（ホーム画面のアプリ・OneDrive）
  }
  await refresh();
  return state === 'on';
}

export async function stop() {
  dir = null;
  await meta.remove(DIR_KEY);
  prefs.set('sync.mode', 'off');
  await refresh();
}

// ---------- 保存先の読み書き ----------

function target() {
  if (state !== 'on') return null;
  if (mode() === 'folder' && dir) {
    return {
      async list() {
        const out = [];
        for await (const [name, h] of dir.entries()) if (h.kind === 'file' && NAME_RE.test(name)) out.push({ id: name, name });
        return out;
      },
      async read(id) { return (await (await dir.getFileHandle(id)).getFile()).text(); },
      async readStart(id, maxBytes) {
        const file = await (await dir.getFileHandle(id)).getFile();
        return { text: await file.slice(0, maxBytes).text(), complete: file.size <= maxBytes };
      },
      async readRange(id, start, end) {
        const file = await (await dir.getFileHandle(id)).getFile();
        return file.slice(start, end).arrayBuffer();
      },
      async write(name, text) {
        const f = await dir.getFileHandle(name, { create: true });
        const w = await f.createWritable();
        await w.write(text);
        await w.close();
      },
      async remove(id) { await dir.removeEntry(id); },
      async listAny() {
        const out = [];
        for await (const [name, h] of dir.entries()) {
          if (h.kind !== 'file' || !/\.(ayabackup|json)$/i.test(name)) continue;
          const file = await h.getFile().catch(() => null);
          out.push({ id: name, name, modifiedTime: file ? new Date(file.lastModified).toISOString() : '', size: file?.size });
        }
        return out;
      },
      // フォルダのファイルは、消すとごみ箱に入らない（完全に消える）
      async removeForever(id) { await dir.removeEntry(id); return 'deleted'; },
    };
  }
  if (mode() === 'cloud' && drive) {
    const b = drive.backups;
    return {
      list: () => drive.silently(() => b.list()),
      listAny: () => drive.silently(() => (b.listAny ? b.listAny() : b.list())),
      read: (id) => drive.silently(() => b.read(id)),
      readStart: (id, maxBytes) => drive.silently(async () => (b.readStart ? b.readStart(id, maxBytes) : { text: await b.read(id), complete: true })),
      readRange: (id, start, end) => drive.silently(() => b.readRange(id, start, end)),
      write: (name, text) => drive.silently(() => b.write(name, text)),
      remove: (id) => drive.silently(() => b.remove(id)),
      removeForever: (id) => drive.silently(async () => (b.removeForever ? b.removeForever(id) : (await b.remove(id), 'recycled'))),
    };
  }
  return null;
}

// 失敗したときの扱い：ログイン切れなら状態を変える。それ以外は覚えておき、次の間隔でもう一度
function handleError(e) {
  if (e?.name === 'NeedLoginError') { setState('need-login'); return; }
  lastError = e?.message || String(e);
  listener();
}

function stamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
export function parseName(name) {
  const m = NAME_RE.exec(name);
  if (!m) return null;
  const s = m[2];
  const parts = [+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)];
  const at = s.endsWith('Z') ? Date.UTC(...parts) : new Date(...parts).getTime();
  // 今の名前：「小説話_作品名_第3話@Win_20261030-073000.json」。端末名は「@」のあと
  if (!s.endsWith('Z')) {
    const at2 = m[1].lastIndexOf('@');
    return { prefix: at2 >= 0 ? m[1].slice(at2 + 1).replace(/_+$/, '') : '', at };
  }
  let owner = m[1].replace(/__$/, '');
  // 現行名と旧名の両方を読めるようにし、画面には端末名だけを出す。
  if (owner.startsWith('あや綴り__') || owner.startsWith('AYATUZURI__')) owner = owner.split('__').at(-1) || '端末不明';
  return { prefix: owner, at };
}

// 保存先のバックアップの一覧（新しい順）。[{ id, name, prefix, at, mine }]
export async function listAll() {
  const t = target();
  if (!t) throw new Error('自動バックアップの保存先が使えません（設定 → バックアップで確認してください）');
  try {
    const mine = new Set(prefs.get('sync.mine', []));
    return (await t.list())
      .map((f) => ({ ...f, ...parseName(f.name), mine: mine.has(f.name) }))
      .filter((f) => f.at)
      .sort((a, b) => b.at - a.at);
  } catch (e) {
    handleError(e);
    throw e;
  }
}

// 「バックアップファイルの管理」の一覧：保存先フォルダの .json すべて（新しい順）。
// listAll と違い、名前の形が違うもの（「… (2).json」や手で置いたファイル）も出す。日時は名前から、読めなければ更新日時から。
// [{ id, name, prefix, at, mine, nameless? }]
export async function listManaged() {
  const t = target();
  if (!t) throw new Error('自動バックアップの保存先が使えません（設定 → バックアップで確認してください）');
  try {
    const mine = new Set(prefs.get('sync.mine', []));
    return (await t.listAny())
      .map((f) => {
        const parsed = parseName(f.name);
        return parsed ? { ...f, ...parsed, mine: mine.has(f.name) }
          : { ...f, prefix: '', at: Date.parse(f.modifiedTime) || 0, mine: false, nameless: true };
      })
      .sort((a, b) => b.at - a.at);
  } catch (e) {
    handleError(e);
    throw e;
  }
}

export async function read(entry) {
  const t = target();
  if (!t) throw new Error('自動バックアップの保存先が使えません（設定 → バックアップで確認してください）');
  return t.read(entry.id);
}

// 先頭の maxBytes ほどだけ読む（一覧に出す管理情報用）。戻り値：{ text, complete }
export async function readStart(entry, maxBytes) {
  const t = target();
  if (!t) throw new Error('自動バックアップの保存先が使えません（設定 → バックアップで確認してください）');
  return t.readStart(entry.id, maxBytes);
}

// バックアップの指定範囲だけをバイト列で読む（end は含まない）。
export async function readRange(entry, start, end) {
  const t = target();
  if (!t) throw new Error('自動バックアップの保存先が使えません（設定 → バックアップで確認してください）');
  if (!t.readRange) throw new Error('この保存先は新しいバックアップの部分読み込みに対応していません');
  return t.readRange(entry.id, start, end);
}

export async function remove(entry) {
  const t = target();
  if (!t) throw new Error('バックアップの保存先が使えません');
  await t.remove(entry.id);
}

// ごみ箱にも残さず消す（「バックアップファイルの管理」の削除）。戻り値：'deleted'／'recycled'（完全削除が使えずごみ箱へ移した）
export async function removeForever(entry) {
  const t = target();
  if (!t) throw new Error('バックアップの保存先が使えません');
  const how = await t.removeForever(entry.id);
  // この端末が保存した記録からも外す（残す件数の数え方がずれないように）
  const mine = prefs.get('sync.mine', []);
  if (mine.includes(entry.name)) prefs.set('sync.mine', mine.filter((n) => n !== entry.name));
  return how;
}

// ---------- 保存 ----------

// 書き換えた印（編集のたびに呼ぶ）
export function markDirty() {
  lastEdit = Date.now();
  if (dirty) return;
  dirtySince = lastEdit;
  dirty = true;
  prefs.set('sync.dirty', true);
}

// バックアップは一つずつ順番に行う（自動・編集エピソード保存・バックアップパックを同時に動かさない）。
// 同時に動くと、パックの作成中に自動バックアップの「完了」が出るなど、どれが終わったのか分からなくなるため
let queue = Promise.resolve();
let queued = 0; // 動いている・待っている数
export function exclusive(fn) {
  queued++;
  const run = queue.then(fn).finally(() => { queued--; });
  queue = run.catch(() => {});
  return run;
}
export function isBusy() { return queued > 0; }

// 自動バックアップを一時停止しているか（アプリが決める。設定・バックアップの画面を開いている間など）
let pausedCheck = () => false;
export function setPauseCheck(fn) { pausedCheck = fn || (() => false); }
export function isPaused() { try { return !!pausedCheck(); } catch { return false; } }

export function backupNow(opts = {}) {
  // 自動のときは、ほかのバックアップが動いていれば今回は見送る（変更の印は残るので、次の確認で保存する）
  if (opts.auto && (running || queued)) return Promise.resolve(false);
  // 一時停止中も見送る（変更の印は残るので、画面を閉じたあとの確認で保存する）
  if (opts.auto && isPaused()) return Promise.resolve(false);
  return exclusive(() => backupOnce(opts));
}

async function backupOnce({ force = false, build = null, auto = false } = {}) {
  const t = target();
  if (!t || running) return false;
  if (!checked && !force) return false;
  running = true;
  listener();
  let made = null;
  const startedAt = Date.now();
  try {
    // 保存する前に、他の端末がもっと新しいバックアップを保存していないか確かめる（両方の端末を開いたまま書いているとき）。
    // あれば保存せず、アプリに知らせて確認してもらう（先に保存すると、他の端末の更新が隠れてしまうため）
    if (!force && await findNewer()) {
      checked = false;
      listener();
      newerHandler();
      return false;
    }
    made = build ? await build() : autoBuilder ? await autoBuilder() : await makeArchive({ environment: true, scope: 'all', reason: 'auto', device: { prefix: prefix(), id: deviceId() } });
    const text = made.blob || made.text; // パックは Blob（大きくても一つの文字列にしない）
    const name = made.name || `${prefix()}${stamp()}.ayabackup`;
    try {
      await t.write(name, text);
    } catch (e) {
      // 通信が途中で切れたなど、保存できたか分からないときは、保存先にファイルがあるかを確かめる
      if (!(await savedAnyway(t, name, e))) throw e;
    }
    try { await made.afterSave?.(); } catch { /* 記録できなくても保存は済んでいる */ }
    // 保存している間に書き換えた分は、次のバックアップに入れる
    dirty = lastEdit > startedAt;
    dirtySince = dirty ? lastEdit : 0;
    prefs.set('sync.dirty', dirty);
    const now = new Date().toISOString();
    prefs.set('sync.last', { name, at: now, syncedAt: Date.now() });
    prefs.set('lastAutoBackupAt', now);
    prefs.set('lastBackupAt', now);
    checked = true;
    lastRun = Date.now();
    lastError = '';
    // 残す件数を超えたら、この端末が保存した古いものから消す（他の端末のファイルには触らない）
    const mine = [name, ...prefs.get('sync.mine', []).filter((n) => n !== name)];
    const keep = keepCount();
    prefs.set('sync.mine', mine.slice(0, keep));
    const old = new Set(mine.slice(keep));
    if (old.size) {
      // 古いものを消せなくても、保存はできている（失敗と知らせない。消し残しは次の保存のときにまた消す）
      try {
        const files = await t.list();
        for (const f of files) if (old.has(f.name)) await t.remove(f.id);
      } catch (e) {
        prefs.set('sync.mine', mine.slice(0, keep).concat([...old]));
        console.warn('古い自動バックアップを消せませんでした', e);
      }
    }
    listener();
    resultHandler({ ok: true, auto, name, label: made.label || '', where: mode() });
    return true;
  } catch (e) {
    handleError(e);
    resultHandler({ ok: false, auto, name: made?.name || '', label: made?.label || '', where: mode(), error: e?.message || String(e) });
    return false;
  } finally {
    running = false;
    listener();
  }
}

// 書き込みでエラーになっても、実は保存できていることがある（応答だけが届かなかったなど）。
// ログイン切れ・許可切れは確かめようがないので、そのまま失敗にする
async function savedAnyway(t, name, err) {
  if (/login|auth|permission|401|403/i.test(String(err?.name || '') + String(err?.message || ''))) return false;
  resultHandler({ checking: true });
  try {
    return (await t.list()).some((f) => f.name === name);
  } catch {
    return false;
  }
}

// バックアップパック（手で内容を選んだもの）を、自動バックアップの保存先フォルダに置く。
// 自動バックアップの「変更の印」や残す件数には関係させない（パックは古くなっても自動では消さない）。
// 置いたフォルダはほかの端末も見ているので、ほかの端末では「他の端末の更新」として知らせが出る。
export function savePack(name, text) {
  return exclusive(async () => {
    const t = target();
    if (!t) throw new Error('自動バックアップの保存先が使えません（「設定」→「自動バックアップ」で保存先とフォルダを確かめてください）');
    running = true;
    listener();
    try {
      try {
        await t.write(name, text);
      } catch (e) {
        if (!(await savedAnyway(t, name, e))) throw e;
      }
      // この端末が置いたものなので、この端末には「他の端末の更新」として出さない
      const at = parseName(name)?.at || Date.now();
      prefs.set('sync.seen', name);
      prefs.set('sync.seenAt', Math.max(Number(prefs.get('sync.seenAt', 0)) || 0, at));
      // 自分で置いたパックの名前を覚えておく（他の端末の更新を確かめるとき、中身を読まずに外せるように）。新しいものから50件
      prefs.set('sync.myPacks', [name, ...prefs.get('sync.myPacks', []).filter((n) => n !== name)].slice(0, 50));
      prefs.set('lastBackupAt', new Date().toISOString());
      return { name, where: mode(), folder: folderName() };
    } finally {
      running = false;
      listener();
    }
  });
}

// 保存の結果（自動・手動とも）を受け取る：{ ok, auto, name, label, where, error } / { checking }
let resultHandler = () => {};
export function onBackupResult(fn) { resultHandler = fn || (() => {}); }

// 一定時間ごとに確認し、変更があれば次のどちらかで保存する。
//   1. 入力が IDLE_SAVE_MS（5分）止まったとき
//   2. 書き続けているとき：最初の変更から保存間隔の分だけ待ち、入力が IDLE_MS 止まった区切りで（止まらなくても IDLE_MAX_MS を超えたら保存する）
function tick() {
  if (state !== 'on' || !checked || !dirty) return;
  const now = Date.now();
  if (now - lastRun < LEAVE_MIN_MS) return;
  // 1. 入力が5分止まった（前回の起動から残っていた変更は、起動時の確認が済んだらすぐ）
  if (now - lastEdit >= IDLE_SAVE_MS) { backupNow({ auto: true }); return; }
  // 2. 書き続けているとき：「保存間隔」ごと（入力が少し止まった区切りで。止まらなくても長くは待たない）
  const interval = intervalMin() * 60_000;
  if (now - lastRun < interval || now - dirtySince < interval) return;
  if (now - lastEdit < IDLE_MS && now - dirtySince < interval + IDLE_MAX_MS) return;
  backupNow({ auto: true });
}

// 画面を閉じる・切り替えるときに呼ぶ。未保存の変更があれば保存する
export function flushNow() {
  if (state === 'on' && checked && dirty && Date.now() - lastRun >= LEAVE_MIN_MS) backupNow({ auto: true });
}

// ---------- 起動時の確認と同期 ----------

/**
 * 他の端末のほうが新しいバックアップを保存していないか調べる。
 * 戻り値: null（何もしなくてよい）／{ entry, localChanged }
 */
export async function findNewer({ ignoreSeen = false } = {}) {
  const list = await listAll();
  const newest = list[0];
  const last = lastBackup();
  if (!newest || newest.mine) return null;
  if (last && newest.name === last.name) return null;
  // この端末が置いたバックアップパック（中身を読まずに分かる）
  if (prefs.get('sync.myPacks', []).includes(newest.name)) return null;
  // 中身を読まなくても分かるもの（前回の同期より古い・もう確かめた）は、ここで終える。
  // 先に中身を読んでいたので、全作品のパックのような大きいファイルが一番新しいと、自動バックアップのたびに
  // そのファイルを丸ごと読み込んでいた（iPhone で、メモリが足りずに落ちる原因になっていた）
  const lastAt = last ? parseName(last.name)?.at || Date.parse(last.at) : 0;
  if (newest.at <= lastAt) return null;
  const seenAt = Number(prefs.get('sync.seenAt', 0)) || 0;
  if (!ignoreSeen && newest.at <= seenAt) return null;
  if (!ignoreSeen && prefs.get('sync.seen', '') === newest.name) return null;
  // ファイル名の記録が失われても、中にある端末IDが同じなら自分のバックアップ。
  try {
    // 新しい形式は索引だけ、前の版の .json は先頭だけを読む（大きいファイルを丸ごと読まない）
    let data;
    if (/\.json$/i.test(newest.name)) {
      const { text, complete } = await readStart(newest, 256 * 1024);
      data = complete ? JSON.parse(text) : parseBackupHead(text);
    } else {
      data = (await openArchive({ readRange: (start, end) => readRange(newest, start, end) })).index;
    }
    if (data?.device?.id && data.device.id === deviceId()) {
      // この端末が置いたバックアップパックは、自動バックアップの件数には入れない（古いものとして消さない）
      if (data.reason === 'manual-pack') return null;
      const mine = [newest.name, ...prefs.get('sync.mine', []).filter((n) => n !== newest.name)];
      prefs.set('sync.mine', mine.slice(0, keepCount()));
      prefs.set('sync.last', { name: newest.name, at: new Date(newest.at).toISOString(), syncedAt: Date.now() });
      return null;
    }
  } catch { /* 読めないときは従来どおり日時で判定する */ }
  return { entry: newest, localChanged: dirty };
}

// 確認が済んだ（読み込んだ、読み込まないと答えた、新しいものがなかった）
export function markChecked(seenEntry = null) {
  if (seenEntry) {
    prefs.set('sync.seen', seenEntry.name);
    const at = Number(seenEntry.at) || parseName(seenEntry.name || '')?.at || 0;
    if (at) prefs.set('sync.seenAt', Math.max(Number(prefs.get('sync.seenAt', 0)) || 0, at));
  }
  checked = true;
  listener();
}

// バックアップから小説を読み込んだ（上書き・新小説）。そのバックアップを「前回同期したもの」として記録し、確認済みにする。
// 読み込んだ内容は、次の自動バックアップ（「保存」）で他の端末にも届くよう、変更ありにする
export function markLoaded(name) {
  const parsed = parseName(name || '');
  if (parsed) prefs.set('sync.last', { name, at: new Date(parsed.at).toISOString(), syncedAt: Date.now() });
  checked = true;
  markDirty();
  listener();
}

