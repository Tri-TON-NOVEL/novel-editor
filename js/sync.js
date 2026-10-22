// 自動バックアップ（同期）
// 役割は2つ。
//   1. いざというときに戻すためのバックアップ（全作品・ひな型・設定を1ファイルに）
//   2. 複数の端末（Windows・Mac・iPhone・iPad・Android）のあいだの、楽観的な同期
//
// 保存先（端末ごとに選ぶ）
//   'folder' … 普通のフォルダ（PC の Chrome・Edge、Android の Chrome。OneDrive・iCloud Drive などの同期フォルダも可）
//   'gdrive' … Google ドライブ（API）の「小説エディター／自動バックアップ」。iPhone・iPad はこちらだけ
//
// ファイル名：プレフィックス + 日時（世界時）  例：iPad_20261022T001500Z.json
//   名前の日時でどれが新しいかを決める（同期ソフトがファイルの更新日時を変えても困らないように）。
//
// 端末に残す記録（設定 sync.*。全体バックアップには入らない）
//   sync.last  … 最後に同期した（自分で保存した、または読み込んだ）バックアップ { name, at }
//   sync.dirty … 最後のバックアップのあとに書き換えたか
//   sync.mine  … この端末が保存したファイル名（新しい順）。残す件数を超えたら、この中の古いものだけ消す
//   sync.seen  … 「読み込まない」と答えた他の端末のバックアップ（次に起動したとき同じことを聞かない）
//
// 起動したとき：保存先でいちばん新しいバックアップを、sync.last とくらべる（findNewer）。
//   同じ → 何もしない。他の端末のほうが新しい → 読み込むかを聞く（画面はアプリ側）。
//   読み込むときは作品ごとにまとめる（loadAndMerge）。両方で書き換えた作品だけ、どちらを使うか聞く。
// 起動時の確認が済むまでは保存しない（先に保存すると、他の端末の新しいバックアップが隠れてしまうため）。
import { meta, prefs, db, versions } from './db.js';
import { makeBackup, parseBackup } from './backup.js';
import { normalize } from './format.js';

export const DEFAULT_INTERVAL_MIN = 10;
export const DEFAULT_KEEP = 200;
const CHECK_MS = 30_000;       // 保存が必要かを確かめる間隔
const LEAVE_MIN_MS = 30_000;   // 画面を離れるときの保存の最短間隔（タブを切り替えるたびに増えないように）
const DIR_KEY = 'autoBackupDir';
const NAME_RE = /^(.*?)(\d{8}T\d{6}Z)\.json$/;

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
export function mode() { return prefs.get('sync.mode', 'off'); }
export function intervalMin() { return Math.max(1, Number(prefs.get('autoBackupInterval', DEFAULT_INTERVAL_MIN)) || DEFAULT_INTERVAL_MIN); }
export function keepCount() { return Math.max(1, Number(prefs.get('autoBackupKeep', DEFAULT_KEEP)) || DEFAULT_KEEP); }
export function lastBackup() { return prefs.get('sync.last', null); }
export function folderName() { return mode() === 'gdrive' ? drive?.backups.folderName || '' : dir?.name || ''; }

function deviceId() {
  let id = prefs.get('sync.deviceId', '');
  if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); prefs.set('sync.deviceId', id); }
  return id;
}

// ---------- 状態 ----------
// state: 'off' | 'on' | 'need-folder'（保存先のフォルダをまだ選んでいない） | 'need-permission'（フォルダの許可切れ）
//        | 'need-login'（Google のログイン切れ） | 'unsupported'
let state = 'off';
let lastError = '';
let dir = null;
let drive = null;
let dirty = !!prefs.get('sync.dirty', false);
let checked = false;   // 起動時の確認が済んだか
let lastRun = 0;
let running = false;
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

export async function init({ provider }) {
  drive = provider || null;
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
  } else if (m === 'gdrive') {
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

// フォルダの書き込み許可をもらい直す／Google にログインする（ボタンを押したときに呼ぶ）
export async function resume() {
  if (mode() === 'folder') {
    if (!dir) return false;
    const perm = await dir.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return false;
  } else if (mode() === 'gdrive') {
    await drive.signIn(); // ホーム画面のアプリでは、ここでページごと Google へ移動する
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
      async write(name, text) {
        const f = await dir.getFileHandle(name, { create: true });
        const w = await f.createWritable();
        await w.write(text);
        await w.close();
      },
      async remove(id) { await dir.removeEntry(id).catch(() => {}); },
    };
  }
  if (mode() === 'gdrive' && drive) {
    const b = drive.backups;
    return {
      list: () => drive.silently(() => b.list()),
      read: (id) => drive.silently(() => b.read(id)),
      write: (name, text) => drive.silently(() => b.write(name, text)),
      remove: (id) => drive.silently(() => b.remove(id)),
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
  const at = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));
  return { prefix: m[1], at };
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

export async function read(entry) {
  return target().read(entry.id);
}

// ---------- 保存 ----------

// 書き換えた印（編集のたびに呼ぶ）
export function markDirty() {
  if (dirty) return;
  dirty = true;
  prefs.set('sync.dirty', true);
}

export async function backupNow({ force = false } = {}) {
  const t = target();
  if (!t || running) return false;
  if (!checked && !force) return false;
  running = true;
  try {
    // 保存する前に、他の端末がもっと新しいバックアップを保存していないか確かめる（両方の端末を開いたまま書いているとき）。
    // あれば保存せず、アプリに知らせて確認してもらう（先に保存すると、他の端末の更新が隠れてしまうため）
    if (!force && await findNewer()) {
      checked = false;
      listener();
      newerHandler();
      return false;
    }
    const { text } = await makeBackup({ device: { prefix: prefix(), id: deviceId() } });
    const name = `${prefix()}${stamp()}.json`;
    await t.write(name, text);
    dirty = false;
    prefs.set('sync.dirty', false);
    const now = new Date().toISOString();
    prefs.set('sync.last', { name, at: now, syncedAt: Date.now() });
    prefs.set('lastAutoBackupAt', now);
    prefs.set('lastBackupAt', now);
    lastRun = Date.now();
    lastError = '';
    // 残す件数を超えたら、この端末が保存した古いものから消す（他の端末のファイルには触らない）
    const mine = [name, ...prefs.get('sync.mine', []).filter((n) => n !== name)];
    const keep = keepCount();
    prefs.set('sync.mine', mine.slice(0, keep));
    const old = new Set(mine.slice(keep));
    if (old.size) {
      const files = await t.list();
      for (const f of files) if (old.has(f.name)) await t.remove(f.id);
    }
    listener();
    return true;
  } catch (e) {
    handleError(e);
    return false;
  } finally {
    running = false;
  }
}

// 一定時間ごとに確認し、変更があって保存間隔を過ぎていれば保存する
function tick() {
  if (state === 'on' && checked && dirty && Date.now() - lastRun >= intervalMin() * 60_000) backupNow();
}

// 画面を閉じる・切り替えるときに呼ぶ。未保存の変更があれば保存する
export function flushNow() {
  if (state === 'on' && checked && dirty && Date.now() - lastRun >= LEAVE_MIN_MS) backupNow();
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
  const lastAt = last ? parseName(last.name)?.at || Date.parse(last.at) : 0;
  if (newest.at <= lastAt) return null;
  if (!ignoreSeen && prefs.get('sync.seen', '') === newest.name) return null;
  return { entry: newest, localChanged: dirty };
}

// 確認が済んだ（読み込んだ、読み込まないと答えた、新しいものがなかった）
export function markChecked(seenEntry = null) {
  if (seenEntry) prefs.set('sync.seen', seenEntry.name);
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

/**
 * バックアップを読み込んで、作品ごとにまとめる。
 * onConflict(local, remote) … 両方で書き換えた作品について、'remote' か 'local' を返す
 * 戻り値: { added, updated, kept }
 */
export async function loadAndMerge(entry, onConflict, opts = {}) {
  return mergeText(await read(entry), entry.name, onConflict, opts);
}

/**
 * バックアップの中身（文字列）を、この端末の作品と合わせる。一覧にないファイル（「ファイルから選ぶ」）にも使う。
 *
 * 起動時の自動の確認（explicit: false）
 *   作品ごとに更新日時の新しいほうを使う。ファイル側が新しく、この端末でも前回の同期のあとに書き換えていたら、どちらを使うか聞く（onConflict）。
 *
 * 一覧やファイルから、人が選んだとき（explicit: true）
 *   選んだファイルの内容を使う。ただし、この端末のほうが新しい作品があれば、置き換えるかを一度だけ聞く（onOlder）。
 *   onOlder(list) … list = [{ local, remote }]。'file'（ファイルの内容にする）／'local'（その作品はこの端末のまま）／null（やめる）
 *
 * どちらも、この端末にしかない作品は消さない。読み込む前の状態は「同期の前の状態」に残す。
 * name がバックアップの名前の形（プレフィックス＋日時）なら、それを「前回同期したもの」として記録する。
 * 戻り値: { added, updated, kept, addedList, updatedList, keptList }（List は [{ id, title }]）／null（やめた）
 */
export async function mergeText(text, name, onConflict, { explicit = false, onOlder = null } = {}) {
  const backup = parseBackup(text);
  const last = lastBackup();
  // この端末で書き換えたか：前回同期した時刻（この端末の時計）とくらべる（端末どうしの時計のずれに左右されないように）
  const localSince = last ? (last.syncedAt || parseName(last.name)?.at || Date.parse(last.at)) : null;
  const time = (p) => Date.parse(p?.updatedAt || 0) || 0;

  // まず、作品ごとにどうするかを決める（書き込みは、全部決まってから）
  const plan = []; // { r, take: true|false, isNew }
  const older = []; // この端末のほうが新しい作品（explicit のとき）
  for (const r of backup.projects || []) {
    if (!r?.id) continue;
    const l = await db.get(r.id);
    if (!l) { plan.push({ r, take: true, isNew: true }); continue; }
    const rT = time(r);
    const lT = time(l);
    if (rT === lT) continue;
    if (explicit) {
      if (rT > lT) plan.push({ r, take: true });
      else { const item = { r, take: false, l }; plan.push(item); older.push(item); }
      continue;
    }
    let useRemote = rT > lT; // 作品ごとに新しいほう
    // ファイル側が新しくても、この端末でも前回の同期のあとに書き換えていたら、どちらを使うか聞く
    if (useRemote && localSince !== null && lT > localSince) useRemote = (await onConflict(normalize(l), normalize(r))) === 'remote';
    plan.push({ r, take: useRemote });
  }
  if (explicit && older.length && onOlder) {
    const answer = await onOlder(older.map((o) => ({ local: normalize(o.l), remote: normalize(o.r) })));
    if (answer === null) return null;
    if (answer === 'file') for (const o of older) o.take = true;
  }

  // 読み込む前の状態を残しておく（設定 → 自動バックアップ「同期の前の状態を書き出す」）
  const before = await makeBackup();
  await meta.set('preSyncBackup', { createdAt: new Date().toISOString(), from: name, text: before.text });

  const taken = new Set();
  // どの作品がどうなったか（画面で知らせ、変わった作品を開くため）：[{ id, title }]
  const addedList = [];
  const updatedList = [];
  const keptList = [];
  const item = (p) => ({ id: p.r.id, title: p.r.title || '無題' });
  for (const p of plan) {
    if (!p.take) { keptList.push(item(p)); continue; }
    await db.put(normalize(p.r));
    taken.add(p.r.id);
    (p.isNew ? addedList : updatedList).push(item(p));
  }
  // 取り込んだ作品の版も入れる（同じ版はそのまま）
  for (const v of backup.versions || []) {
    if (v?.id && taken.has(v.projectId)) await versions.put(v);
  }
  // ひな型はまとめる（同じものは読み込んだ側）
  const remoteTemplates = backup.prefs?.templates;
  if (Array.isArray(remoteTemplates)) {
    const mine = prefs.get('templates', []) || [];
    const ids = new Set(remoteTemplates.map((t) => t.id));
    prefs.set('templates', [...remoteTemplates, ...mine.filter((t) => !ids.has(t.id))]);
  }
  const parsed = parseName(name || '');
  if (parsed) prefs.set('sync.last', { name, at: new Date(parsed.at).toISOString(), syncedAt: Date.now() });
  else if (last) prefs.set('sync.last', { ...last, syncedAt: Date.now() });
  checked = true;
  return { added: addedList.length, updated: updatedList.length, kept: keptList.length, addedList, updatedList, keptList };
}
