// 自動バックアップ（PC の Chrome / Edge）
// 一度フォルダを選ぶと、編集が止まるたび・画面を閉じる・切り替えるたびに、
// そのフォルダへ全体バックアップを書き出す。
//   小説エディター_自動バックアップ_YYYYMMDD.json（日ごとに1ファイル。古いものは14日分まで残す）
import { meta, prefs } from './db.js';
import { makeBackup } from './backup.js';

const KEY = 'autoBackupDir';
const PREFIX = '小説エディター_自動バックアップ_';
const KEEP_DAYS = 14;
const IDLE_MS = 30_000;      // 入力が止まってから書き出すまで
const MIN_INTERVAL = 60_000; // 書き出しの最短間隔

export const supported = 'showDirectoryPicker' in window;

let dir = null;
let state = 'off'; // 'off' | 'on' | 'need-permission'
let timer = null;
let pending = false;
let lastRun = 0;
let listener = () => {};

function setState(s) { state = s; listener(state); }

export function onState(fn) { listener = fn; fn(state); }
export function getState() { return state; }
export function folderName() { return dir?.name || ''; }
export function lastWrittenAt() { return prefs.get('lastAutoBackupAt', null); }

export async function init() {
  if (!supported) return;
  dir = await meta.get(KEY).catch(() => null);
  if (!dir) { setState('off'); return; }
  const perm = await dir.queryPermission({ mode: 'readwrite' }).catch(() => 'denied');
  setState(perm === 'granted' ? 'on' : 'need-permission');
}

// フォルダを選ぶ（ボタンを押したときに呼ぶ）
export async function chooseFolder() {
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

function ymd(d = new Date()) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

async function prune() {
  const names = [];
  for await (const [name] of dir.entries()) {
    if (name.startsWith(PREFIX) && name.endsWith('.json')) names.push(name);
  }
  names.sort().reverse();
  for (const name of names.slice(KEEP_DAYS)) await dir.removeEntry(name).catch(() => {});
}

export async function runNow() {
  if (state !== 'on' || !dir) return false;
  clearTimeout(timer);
  pending = false;
  const { text } = await makeBackup();
  const file = await dir.getFileHandle(`${PREFIX}${ymd()}.json`, { create: true });
  const w = await file.createWritable();
  await w.write(text);
  await w.close();
  lastRun = Date.now();
  const now = new Date().toISOString();
  prefs.set('lastAutoBackupAt', now);
  prefs.set('lastBackupAt', now);
  await prune().catch(() => {});
  listener(state);
  return true;
}

// 編集のたびに呼ぶ。入力が止まって少したったら書き出す
export function schedule() {
  if (state !== 'on') return;
  pending = true;
  clearTimeout(timer);
  const wait = Math.max(IDLE_MS, MIN_INTERVAL - (Date.now() - lastRun));
  timer = setTimeout(() => runNow().catch((e) => console.warn('自動バックアップ失敗', e)), wait);
}

// 画面を閉じる・切り替えるときに呼ぶ。未書き出しの変更があればすぐ書き出す
export function flushNow() {
  if (state === 'on' && pending) runNow().catch((e) => console.warn('自動バックアップ失敗', e));
}
