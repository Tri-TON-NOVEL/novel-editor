// 自動バックアップ（PC の Chrome / Edge）
// 一度フォルダを選ぶと、変更があったときだけ「保存間隔」ごとに、全体バックアップを新しいファイルとして書き出す。
// 画面を閉じる・切り替えるときにも書き出す。ファイルは「残す件数」を超えたら古いものから消す（サイクリック）。
//   小説エディター_自動_YYYYMMDD_HHMMSS.json
import { meta, prefs } from './db.js';
import { makeBackup } from './backup.js';

const KEY = 'autoBackupDir';
const PREFIX = '小説エディター_自動_';
const CHECK_MS = 30_000;          // 保存が必要かを確かめる間隔
const LEAVE_MIN_MS = 60_000;      // 画面を離れるときの保存の最短間隔（タブを切り替えるたびに増えないように）

export const DEFAULT_INTERVAL_MIN = 10;
export const DEFAULT_KEEP = 200;

export const supported = 'showDirectoryPicker' in window;

let dir = null;
let state = 'off'; // 'off' | 'on' | 'need-permission'
let pending = false;
let lastRun = 0;
let running = false;
let listener = () => {};

export function intervalMin() { return Math.max(1, Number(prefs.get('autoBackupInterval', DEFAULT_INTERVAL_MIN)) || DEFAULT_INTERVAL_MIN); }
export function keepCount() { return Math.max(1, Number(prefs.get('autoBackupKeep', DEFAULT_KEEP)) || DEFAULT_KEEP); }

function setState(s) { state = s; listener(state); }

export function onState(fn) { listener = fn; fn(state); }
export function getState() { return state; }
export function folderName() { return dir?.name || ''; }
export function lastWrittenAt() { return prefs.get('lastAutoBackupAt', null); }

export async function init() {
  if (!supported) return;
  setInterval(tick, CHECK_MS);
  dir = await meta.get(KEY).catch(() => null);
  if (!dir) { setState('off'); return; }
  const perm = await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
  setState(perm === 'granted' ? 'on' : 'need-permission');
}

// フォルダを選ぶ（ボタンを押したときに呼ぶ）
export async function chooseFolder() {
  if (!supported) throw new Error('このブラウザではフォルダを選べません（Windows・Mac の Chrome / Edge で使えます）');
  let picked;
  try {
    picked = await window.showDirectoryPicker({ id: 'novel-editor-backup', mode: 'readwrite' });
  } catch (e) {
    if (e.name === 'AbortError') return false;
    throw e;
  }
  dir = picked;
  await meta.set(KEY, dir);
  setState('on');
  await runNow();
  return true;
}

// ブラウザを開き直したときに、書き込みの許可をもう一度もらう（ボタンを押したときに呼ぶ）
export async function resume() {
  if (!dir) return false;
  const perm = await dir.requestPermission({ mode: 'readwrite' });
  if (perm !== 'granted') return false;
  setState('on');
  await runNow();
  return true;
}

export async function stop() {
  dir = null;
  await meta.remove(KEY);
  setState('off');
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 残す件数を超えた古いファイルを消す（日時入りの名前なので、名前順＝日時順）
async function prune() {
  const names = [];
  for await (const [name] of dir.entries()) {
    if (name.startsWith(PREFIX) && name.endsWith('.json')) names.push(name);
  }
  names.sort().reverse();
  for (const name of names.slice(keepCount())) await dir.removeEntry(name).catch(() => {});
}

export async function runNow() {
  if (state !== 'on' || !dir || running) return false;
  running = true;
  try {
    pending = false;
    const { text } = await makeBackup();
    const file = await dir.getFileHandle(`${PREFIX}${stamp()}.json`, { create: true });
    const w = await file.createWritable();
    await w.write(text);
    await w.close();
    lastRun = Date.now();
    const now = new Date().toISOString();
    prefs.set('lastAutoBackupAt', now);
    prefs.set('lastBackupAt', now);
    await prune().catch(() => {});
  } finally {
    running = false;
  }
  listener(state);
  return true;
}

function save() {
  runNow().catch((e) => console.warn('自動バックアップ失敗', e));
}

// 変更があった印を付ける（編集のたびに呼ぶ）
export function schedule() {
  pending = true;
}

// 一定時間ごとに確認し、変更があって保存間隔を過ぎていれば保存する
function tick() {
  if (state === 'on' && pending && Date.now() - lastRun >= intervalMin() * 60_000) save();
}

// 画面を閉じる・切り替えるときに呼ぶ。未保存の変更があれば保存する
export function flushNow() {
  if (state === 'on' && pending && Date.now() - lastRun >= LEAVE_MIN_MS) save();
}
