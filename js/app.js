import { db, prefs, versions, meta, saveEnvironment, restoreEnvironmentIfLost } from './db.js';
import {
  newProject, newEpisode, normalize, fromSingle, serialize, parse, fileName, countChars,
  draftOf, DRAFT_FIELDS, SITE_KEYS,
} from './format.js';
import * as format from './format.js';
import { categorizedTable, chapterList, CHARACTER_COLUMNS, WORLD_COLUMNS } from './tables.js';
import {
  makeBackup, isBackup, parseBackup, restoreBackup, mergeSharedPrefs, environmentSummary, applyEnvironment, backupFileName, requestPersistence,
  makeEpisodeFile, isEpisodeFile, parseEpisodeFile,
  makePack, parseAnyBackup, packFileName, describePack, packSummary, restorePack, PACK_FORMAT, materialsSignature,
} from './backup.js';
import * as sync from './sync.js';
import { initImport } from './importui.js';
import { decodeText } from './importer.js';
import { ask, askText, choose, inform } from './dialogs.js';
import {
  SITES, RUBY_LIMIT, SYMBOLS, ruby, dots, autoIndent, rubyCaretOffset, convert, convertText, countImages,
  miteminToTag, hasMiteminUrl, xLength, fillTemplate, TEMPLATE_VARS, DEFAULT_TEMPLATES, findImages,
} from './notation.js';
import { localFile, WORK_TYPES, TEXT_TYPES } from './localfile.js';
import { providers, activeProvider } from './providers/index.js';

const $ = (id) => document.getElementById(id);
const AUTOSAVE_MS = 2000;       // 入力が止まってから端末へ保存するまで
const AUTOSAVE_MAX_MS = 30_000; // 打ち続けていても、これより長くは待たない
// 更新したら上げる（設定の「表示」タブに出るので、どの版が動いているか確認できる）
const APP_VERSION = '2026.10.31-7.7.4';

const el = {
  novelTitle: $('novel-title'),
  site: $('site'),
  synopsis: $('synopsis'),
  projectMemo: $('project-memo'),
  epTitle: $('ep-title'),
  foreword: $('foreword'),
  body: $('body'),
  afterword: $('afterword'),
  plot: $('plot'),
  freeMemo: $('free-memo'),
  narouUrl: $('narou-url'),
  alphaUrl: $('alpha-url'),
  xText: $('x-text'),
  nrTitle: $('narou-report-title'),
  nrBody: $('narou-report-body'),
};

let project = null;     // 編集中の作品
let epIndex = 0;        // 編集中のエピソード
let view = 'episode';   // VIEWS のいずれか
// 活動報告はエピソードの画面の中（「活動報告」タブ）。6.0 より前は独立した画面だった
const VIEWS = ['episode', 'synopsis', 'outline', 'world', 'characters', 'project-memo'];
let fileHandle = null;  // 開いている／保存したローカルファイル（Chrome・Edge のみ）
let saveTimer = null;
let dirty = false;
let lastSavedAt = null;
let saveError = null;   // 端末への保存に失敗したときのメッセージ
let manualServerSaving = false;
let editSite = 'narou'; // 編集中の原稿（なろう用／アルファ用）。作品を開くとメイン投稿サイトになる

// 同じ作品を別のタブ・ウインドウで同時に編集していないかを見張る（後から保存した方で上書きされるため）
const TAB_ID = Math.random().toString(36).slice(2);
const tabChannel = 'BroadcastChannel' in window ? new BroadcastChannel('novel-editor') : null;
let otherTabEditing = false;

const episode = () => project.episodes[epIndex];
// 編集中のエピソードの、編集中サイトの原稿
const cur = () => episode().drafts[editSite];
const subSite = () => SITE_KEYS.find((s) => s !== project.site);
const episodeName = (ep) => format.episodeName(ep, project.site);
// メイン側の原稿（一覧・並べ替え・文字数の基準）
const mainDraft = (ep) => draftOf(ep, project.site);

// ---------- 共通 ----------

function fmtTime(iso) {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

let toastTimer = null;
function toast(msg, isError = false) {
  const t = $('toast');
  // 設定画面などの「最前面の画面（showModal）」が開いていると、その後ろに隠れて見えないので、いちばん上の画面の中に置く
  const host = [...document.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal')).pop() || document.body;
  if (t.parentNode !== host) host.append(t);
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2500);
}

// 画面を閉じたとき、その中に置いていたお知らせは元に戻す（閉じた画面と一緒に消えないように）
document.addEventListener('close', (e) => {
  const t = $('toast');
  if (t && e.target instanceof HTMLDialogElement && e.target.contains(t)) document.body.append(t);
}, true);

function fail(e) {
  console.error(e);
  toast(e.message || String(e), true);
}

// ファイルやバックアップを実際に読み込んでいる間は、開始したことが分かる表示を最前面に出す。
// 入れ子の処理（クラウドから取得 → 復元など）でも、最後の処理が終わるまで閉じない。
let busyDepth = 0;
async function withBusy(message, work) {
  const dialog = $('busy-dialog');
  busyDepth++;
  $('busy-message').textContent = message || '読み込み中…';
  if (!dialog.open) dialog.showModal();
  // 表示が描かれてから始める。アプリが裏に回っていると描画が止まるので、少し待っても描かれなければそのまま始める
  await new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 150); });
  try {
    return await work();
  } finally {
    busyDepth = Math.max(0, busyDepth - 1);
    if (!busyDepth && dialog.open) dialog.close();
  }
}

// 処理中の文言だけを変える（例：通信の結果が分からず、保存先を確かめ直しているとき）
function setBusyMessage(message) {
  if ($('busy-dialog').open) $('busy-message').textContent = message;
}

// ---------- 保存・読み込みの共通の流れ ----------
// アプリ全体で同じ動きにする：
//   1. 押したボタンだけを「処理中」の色にし、その画面のほかのボタンは押せなくする（二重に実行しない）
//   2. 処理中の文言を最前面に出す（処理が終わるまで出し続ける）
//   3. 成功：その画面を閉じ、完了の文言を出す（しばらくして消える）
//   4. 失敗：画面は閉じず、画面の中にエラーとやり直し方を出す
// work() が false を返したら「やめた」（キャンセル）として、何も知らせない。
const TASK_TEXT = {
  load: ['読み込み中…', '読み込みが完了しました'],
  save: ['保存中…', '保存が完了しました'],
  backup: ['バックアップ作成中…', 'バックアップを作成しました'],
  restore: ['復元中…', '復元が完了しました'],
};

function setTaskError(dialog, text) {
  if (!dialog) return;
  let el = dialog.querySelector('.task-error');
  if (!el && text) {
    el = Object.assign(document.createElement('p'), { className: 'task-error' });
    el.setAttribute('role', 'alert');
    const foot = dialog.querySelector('.dialog-foot');
    if (foot) foot.before(el); else dialog.querySelector('form, .dialog')?.append(el);
  }
  if (el) { el.textContent = text; el.hidden = !text; }
}

async function runTask(kind, work, { button = null, dialog = button?.closest('dialog') || null, busy, done, closeOnSuccess = true } = {}) {
  if (button?.classList.contains('task-running')) return null;
  const [busyText, doneText] = TASK_TEXT[kind] || TASK_TEXT.load;
  const controls = dialog ? [...dialog.querySelectorAll('button, input, select, textarea')] : (button ? [button] : []);
  const wasDisabled = controls.map((c) => c.disabled);
  controls.forEach((c) => { c.disabled = true; });
  button?.classList.add('task-running');
  setTaskError(dialog, '');
  try {
    // busy:false … 保存先を選ぶ画面などを先に出す処理。処理中の表示は work の中で必要なときだけ出す
    const result = busy === false ? await work() : await withBusy(busy || busyText, work);
    if (result === false) return false;
    if (dialog && closeOnSuccess && dialog.open) dialog.close();
    const text = typeof done === 'function' ? done(result) : (done || doneText);
    if (text) toast(text);
    return result;
  } catch (e) {
    console.error(e);
    const msg = e?.message || String(e);
    if (dialog?.open) setTaskError(dialog, `⚠ ${msg}\n内容を確かめて、もう一度ボタンを押すとやり直せます。`);
    toast(msg, true);
    return null;
  } finally {
    controls.forEach((c, i) => { c.disabled = wasDisabled[i]; });
    button?.classList.remove('task-running');
  }
}

function returnToEditor() {
  for (const id of ['backup-inspect-dialog', 'backup-manage-dialog', 'sync-restore-dialog', 'restore-dialog', 'settings-dialog']) {
    const dialog = $(id);
    if (dialog?.open) dialog.close();
  }
  if (project) {
    if (reportMode) setReportMode(false);
    setView('episode');
  }
}

function li(className, text) {
  return Object.assign(document.createElement('li'), { className, textContent: text });
}

function button(text, onClick, className = '') {
  const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, className });
  // その場で呼ぶ（Safari は、ファイル選択・共有メニューを押した直後でないと出せない）
  b.addEventListener('click', () => { try { Promise.resolve(onClick()).catch(fail); } catch (e) { fail(e); } });
  return b;
}

function listItem(title, meta, buttons, current = false) {
  const item = li(current ? 'current' : '', '');
  const main = document.createElement('div');
  main.className = 'item-main';
  main.innerHTML = '<div class="item-title"></div><div class="item-meta"></div>';
  main.firstChild.textContent = title;
  main.lastChild.textContent = meta;
  item.append(main, ...buttons);
  return item;
}

function isEmptyProject(p) {
  const r = p.reports || {};
  const e = p.episodes[0];
  const er = e.report || {};
  return !p.title && !p.synopsis && !p.projectMemo && !r.x && !r.narouTitle && !r.narouBody
    && !p.chapters.some((c) => c.plot) && !p.world.items.length && !p.characters.items.length
    && p.episodes.length === 1 && !e.plot && !e.freeMemo && !er.x && !er.narouTitle && !er.narouBody
    && SITE_KEYS.every((s) => DRAFT_FIELDS.every((f) => !draftOf(e, s)[f]));
}

function totalChars(p) {
  return p.episodes.reduce((n, e) => n + countChars(draftOf(e, p.site).body).all, 0);
}

function updateStatus() {
  const parts = [];
  const localSaving = !!dirty;
  const serverSaving = manualServerSaving || sync.isRunning?.();
  if (!db.persistent) parts.push('⚠ この環境では端末に保存できません');
  else if (saveError) parts.push('⚠ 保存に失敗しました');
  else if (otherTabEditing) parts.push('⚠ 別のタブでも編集中');
  else if (serverSaving) parts.push('サーバへ保存中…');
  else if (localSaving) parts.push('端末に保存中…');
  else if (lastSavedAt) parts.push('端末に保存済み ' + fmtTime(lastSavedAt));
  parts.push('メイン: ' + SITES[project.site].short);
  const s = syncStatusShort();
  if (s) parts.push(s);
  $('status').textContent = parts.join(' ・ ');
  $('status').classList.toggle('saving', serverSaving || localSaving);
  $('status').classList.toggle('warn', parts.some((p) => p.startsWith('⚠')));
  renderSaveButton();
}

// 「編集エピソード保存」：まだサーバへのバックアップに入っていない変更があれば印を付ける
function renderSaveButton() {
  const b = $('sync-save-btn');
  const unsaved = sync.isDirty();
  const saving = manualServerSaving || sync.isRunning?.();
  b.textContent = saving ? '保存中…' : unsaved ? '編集エピソード保存●' : '編集エピソード保存';
  b.disabled = !!saving;
  b.classList.toggle('saving', !!saving);
  b.classList.toggle('unsaved', unsaved);
  const last = prefs.get('lastAutoBackupAt', null);
  b.title = (unsaved ? 'まだ保存していない変更があります。' : '')
    + `表示中のエピソードをサーバへバックアップ（Ctrl+S／⌘S）${last ? `　最後の保存 ${fmtTime(last)}` : ''}`;
}

function setCount(id, text) {
  const { all, noSpace } = countChars(text);
  $('count-' + id).textContent = noSpace === all ? `${all.toLocaleString()}字` : `${all.toLocaleString()}字（空白・改行除く ${noSpace.toLocaleString()}字）`;
}

function setXCount() {
  const n = xLength(el.xText.value);
  const c = $('count-x');
  c.textContent = `${n}/280（全角換算 ${Math.ceil(n / 2)}/140字）`;
  c.classList.toggle('over', n > 280);
}

function updateCounts() {
  setCount('novel-title', el.novelTitle.value);
  setCount('synopsis', el.synopsis.value);
  setCount('project-memo', el.projectMemo.value);
  setCount('ep-title', el.epTitle.value);
  setCount('foreword', el.foreword.value);
  setCount('body', el.body.value);
  $('image-count').textContent = String(findImages(el.body.value).length);
  setCount('afterword', el.afterword.value);
  setCount('plot', el.plot.value);
  setCount('free-memo', el.freeMemo.value);
  setCount('narou-report-title', el.nrTitle.value);
  setCount('narou-report-body', el.nrBody.value);
  setXCount();
  renderFoldInfo();
}

// ---------- 本文・プロット・フリーメモの折りたたみ（端末ごと：prefs 'fold.body' など） ----------
// 折りたたんでも中身は消えず、自動保存も続く。見出しに文字数（空なら「（空）」）を出す
const FOLDS = { body: () => el.body, plot: () => el.plot, memo: () => el.freeMemo };
const isFolded = (key) => key in FOLDS && prefs.get('fold.' + key, false) === true;

function setFolded(key, on) {
  prefs.set('fold.' + key, !!on);
  applyFolds();
}

function applyFolds() {
  for (const key of Object.keys(FOLDS)) {
    const box = document.querySelector(`.field[data-field="${key}"]`);
    const folded = isFolded(key);
    box?.classList.toggle('folded', folded);
    const b = document.querySelector(`[data-fold="${key}"]`);
    if (b) { b.textContent = folded ? '▸' : '▾'; b.setAttribute('aria-expanded', String(!folded)); }
  }
  renderFoldInfo();
  scheduleFitFields();
}

function renderFoldInfo() {
  for (const [key, input] of Object.entries(FOLDS)) {
    const info = $('fold-info-' + key);
    if (!info) continue;
    const n = countChars(input().value).all;
    info.textContent = isFolded(key) ? (n ? `（折りたたみ中・${n.toLocaleString()}字）` : '（折りたたみ中・空）') : '';
  }
}

// ---------- 全て選択（その欄の文字をすべて選ぶ） ----------
function selectAllIn(id) {
  const t = $(id);
  if (!t) return;
  if (id === 'foreword') $('foreword-box').open = true;
  if (id === 'afterword') $('afterword-box').open = true;
  const fold = { body: 'body', plot: 'plot', 'free-memo': 'memo' }[id];
  if (fold && isFolded(fold)) setFolded(fold, false);
  const pane = t.closest('[data-pane]');
  if (pane) selectTab(pane.dataset.pane);
  t.focus();
  t.select();
  t.setSelectionRange(0, t.value.length);
}

// ---------- 自動保存 ----------

async function flush() {
  if (!dirty || !project) return;
  clearTimeout(saveTimer);
  unsavedSince = 0;
  dirty = false;
  try {
    await db.put(project);
    lastSavedAt = project.updatedAt;
    saveError = null;
    tabChannel?.postMessage({ type: 'saved', id: project.id, updatedAt: project.updatedAt, tab: TAB_ID });
  } catch (e) {
    dirty = true;
    saveError = e.message || String(e);
    toast('端末への保存に失敗しました：' + saveError, true);
    console.error(e);
  }
  updateStatus();
}

// 端末への保存は、入力が止まって AUTOSAVE_MS たってから（打ち続けている間は待つ）。
// ただし、まだ保存していない変更が AUTOSAVE_MAX_MS を超えたら、入力中でも保存する
let unsavedSince = 0;
function scheduleFlush() {
  if (!unsavedSince) unsavedSince = Date.now();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, Math.max(0, Math.min(AUTOSAVE_MS, unsavedSince + AUTOSAVE_MAX_MS - Date.now())));
}

function changed() {
  project.updatedAt = new Date().toISOString();
  dirty = true;
  autoDirty = true;
  sync.markDirty();
  updateStatus();
  scheduleFlush();
}

// エピソードの中身を変えたときは、そのエピソードの更新日時も進める
function touchEpisode(ep = episode()) {
  ep.updatedAt = new Date().toISOString();
}

let listTimer = null;
// タイトル・前書き・本文・後書きは編集中サイトの原稿へ、プロット・フリーメモはエピソード共通へ
function editEpisode(field, value) {
  const wasEmpty = !cur().body && !cur().title;
  if (DRAFT_FIELDS.includes(field)) {
    cur()[field] = value;
    // サイトごとの稿の「最後に書いた時刻」
    episode().siteUpdatedAt = { ...(episode().siteUpdatedAt || {}), [editSite]: new Date().toISOString() };
  } else {
    episode()[field] = value;
  }
  touchEpisode();
  refreshCurrentVersionLabel();
  if (wasEmpty !== (!cur().body && !cur().title)) renderSiteTabs(); // 「（空）」の表示を更新
  // 目次の表示（タイトル・並び順・文字数）を少し待ってから更新する
  if (field === 'title' || epSort.key !== 'file') {
    clearTimeout(listTimer);
    listTimer = setTimeout(renderEpisodeList, field === 'title' ? 0 : 800);
  }
}

// 入力欄 → 作品データ
const bindings = [
  [el.novelTitle, (v) => { project.title = v; }],
  [el.synopsis, (v) => { project.synopsis = v; }],
  [el.projectMemo, (v) => { project.projectMemo = v; }],
  [el.epTitle, (v) => editEpisode('title', v)],
  [el.foreword, (v) => editEpisode('foreword', v)],
  [el.body, (v) => editEpisode('body', v)],
  [el.afterword, (v) => editEpisode('afterword', v)],
  [el.plot, (v) => editEpisode('plot', v)],
  [el.freeMemo, (v) => editEpisode('freeMemo', v)],
  [el.xText, (v) => setReport('x', v)],
  [el.nrTitle, (v) => setReport('narouTitle', v)],
  [el.nrBody, (v) => setReport('narouBody', v)],
];

// ---------- 画面表示 ----------

// ---------- エピソードの並び順（目次の表示だけを並べ替える。データの順番＝ファイル順は変えない） ----------

const EP_SORTS = {
  file: { label: 'ファイル順', value: (e, i) => i },
  updated: { label: '更新日時', value: (e) => e.updatedAt || '', meta: (e) => fmtTime(e.updatedAt) },
  created: { label: '作成日時', value: (e) => e.createdAt || '', meta: (e) => fmtTime(e.createdAt) },
  // タイトル順は章をまたいで全エピソードを並べる（flat）。補足に章名を出す
  title: {
    label: 'タイトル',
    value: (e) => episodeName(e),
  },
  chars: { label: '本文の文字数', value: (e) => countChars(mainDraft(e).body).all, meta: (e) => `${countChars(mainDraft(e).body).all.toLocaleString()}字` },
  plot: { label: 'プロットの有無', value: (e) => (e.plot.trim() ? 1 : 0), meta: (e) => (e.plot.trim() ? 'プロットあり' : 'プロットなし') },
};
let epSort = { key: 'file', dir: 'asc', grouped: true, ...prefs.get('epSort', {}) };
if (!EP_SORTS[epSort.key]) epSort.key = 'file';
if (typeof epSort.grouped !== 'boolean') epSort.grouped = true;
// 「第2話」と「第10話」を数字の大きさで並べる
const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });

// 並べ替えは章の中で行う（indexes を省略すると全エピソード）
function sortedEpisodeIndexes(indexes = project.episodes.map((_, i) => i)) {
  const sort = EP_SORTS[epSort.key];
  const dir = epSort.dir === 'desc' ? -1 : 1;
  const idx = [...indexes];
  // 同じ値どうしはファイル順のまま
  idx.sort((a, b) => {
    const va = sort.value(project.episodes[a], a);
    const vb = sort.value(project.episodes[b], b);
    const c = typeof va === 'string' ? collator.compare(va, vb) : va - vb;
    return dir * c || a - b;
  });
  return idx;
}

function renderSortControls() {
  $('ep-grouping').value = epSort.grouped ? 'chapters' : 'flat';
  $('ep-sort').value = epSort.key;
  const dir = $('ep-sort-dir');
  dir.textContent = epSort.dir === 'asc' ? '↑ 昇順' : '↓ 降順';
  dir.title = epSort.dir === 'asc' ? '昇順（クリックで降順に）' : '降順（クリックで昇順に）';
}

function setEpisodeSort(next) {
  epSort = { ...epSort, ...next };
  prefs.set('epSort', epSort);
  renderSortControls();
  renderEpisodeList();
}

// ---------- 章とエピソード（A方式：章は独立した配列、エピソードは chapterId で章を指す） ----------
// project.episodes の並び＝ファイル順。常に「章の順 → 章の中の順 → 最後に未分類」に揃えておく。

const UNCAT = '__uncategorized__';
const chapterName = (ch) => ch?.title || '（無題の章）';

// エピソードの並びを章の順に揃える（章の中の順番は保つ）。存在しない章を指していたら未分類にする
function normalizeOrder() {
  const curId = project.episodes[epIndex]?.id;
  const pos = new Map(project.chapters.map((c, i) => [c.id, i]));
  const keyed = project.episodes.map((e, i) => {
    if (e.chapterId && !pos.has(e.chapterId)) e.chapterId = null;
    return { e, i, k: e.chapterId ? pos.get(e.chapterId) : Infinity };
  });
  keyed.sort((a, b) => a.k - b.k || a.i - b.i);
  project.episodes = keyed.map((x) => x.e);
  if (curId) epIndex = Math.max(0, project.episodes.findIndex((e) => e.id === curId));
}

// [{ chapter（未分類は null）, indexes: [エピソードの位置] }]
function episodeGroups() {
  const groups = project.chapters.map((c) => ({ chapter: c, indexes: [] }));
  const byId = new Map(groups.map((g) => [g.chapter.id, g]));
  const uncategorized = { chapter: null, indexes: [] };
  project.episodes.forEach((e, i) => (byId.get(e.chapterId) || uncategorized).indexes.push(i));
  return [...groups, uncategorized];
}

const episodeCountIn = (ch) => project.episodes.filter((e) => e.chapterId === ch.id).length;

function collapsedSet() {
  return new Set(prefs.get('collapsed:' + project.id, []));
}

function toggleChapter(key) {
  const set = collapsedSet();
  if (set.has(key)) set.delete(key); else set.add(key);
  prefs.set('collapsed:' + project.id, [...set]);
  renderEpisodeList();
}

function chapterMenu(ch) {
  const menu = Object.assign(document.createElement('details'), { className: 'menu chapter-menu' });
  const summary = Object.assign(document.createElement('summary'), { className: 'tool', textContent: '⋯' });
  summary.setAttribute('aria-label', `章「${chapterName(ch)}」の操作`);
  const list = Object.assign(document.createElement('div'), { className: 'menu-list' });
  const items = [
    ['add-ep', '＋ この章にエピソードを追加'],
    ['rename', '名前を変える…'],
    ['plot', '章のプロットを開く'],
    ['up', '↑ 章を上へ'],
    ['down', '↓ 章を下へ'],
    ['delete', '章を削除…'],
  ];
  for (const [act, text] of items) {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: text, className: act === 'delete' ? 'danger' : '' });
    b.dataset.chapterAct = act;
    b.dataset.chapterId = ch.id;
    list.append(b);
  }
  menu.append(summary, list);
  return menu;
}

function episodeRow(i, sort, flat = false) {
  const ep = project.episodes[i];
  const b = Object.assign(document.createElement('button'), { type: 'button', title: episodeName(ep) });
  b.append(Object.assign(document.createElement('span'), { className: 'ep-name', textContent: episodeName(ep) }));
  const meta = [];
  if (flat) meta.push(ep.chapterId ? chapterName(project.chapters.find((c) => c.id === ep.chapterId)) : '未分類');
  if (sort.meta) meta.push(sort.meta(ep));
  if (meta.length) b.append(Object.assign(document.createElement('small'), { className: 'ep-meta', textContent: meta.join('・') }));
  b.dataset.ep = i;
  if (view === 'episode' && i === epIndex) b.classList.add('active');
  const item = Object.assign(document.createElement('li'), { className: 'ep-row' + (flat ? ' flat' : '') });
  item.append(b);
  // 「⋯」（並べ替え・章の移動・削除）は、並び順が「ファイル順」で、検索していないときだけ出す
  // （他の並びでは、見た目の上下とファイルの順が合わないため）
  if (epSort.key === 'file' && !epSearch) item.append(episodeMenu(i));
  return item;
}

// エピソードの「⋯」メニュー：上へ・下へ・章を移動（プルダウン）・削除
function episodeMenu(i) {
  const ep = project.episodes[i];
  const menu = Object.assign(document.createElement('details'), { className: 'menu chapter-menu ep-menu' });
  const summary = Object.assign(document.createElement('summary'), { className: 'tool', textContent: '⋯' });
  summary.setAttribute('aria-label', `「${episodeName(ep)}」の操作`);
  const list = Object.assign(document.createElement('div'), { className: 'menu-list' });
  const item = (text, act, className = '') => {
    const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: text, className });
    Object.assign(btn.dataset, { epAct: act, epIndex: i });
    list.append(btn);
  };
  item('↑ 上へ', 'up');
  item('↓ 下へ', 'down');
  // 章の移動：章の数が多くても場所を取らないよう、プルダウンで選ぶ（選んだらすぐ移す）
  const sel = Object.assign(document.createElement('select'), { className: 'menu-select-input' });
  sel.setAttribute('aria-label', `「${episodeName(ep)}」を移す章`);
  const current = ep.chapterId ? chapterName(project.chapters.find((c) => c.id === ep.chapterId)) : '未分類';
  sel.append(Object.assign(new Option(`今の章：${current}`, '__current__'), { disabled: true, selected: true }));
  for (const ch of project.chapters) if (ch.id !== ep.chapterId) sel.append(new Option(chapterName(ch), ch.id));
  if (ep.chapterId) sel.append(new Option('未分類', ''));
  sel.disabled = sel.options.length < 2;
  sel.addEventListener('change', () => episodeAction('chapter', i, sel.value));
  const label = Object.assign(document.createElement('label'), { className: 'menu-select' });
  label.append('章を移動', sel);
  list.append(label, document.createElement('hr'));
  item('削除…', 'delete', 'danger');
  menu.append(summary, list);
  return menu;
}

function episodeAction(act, index, to) {
  closeMenus();
  if (epSort.key !== 'file') { toast('並べ替え・章の移動・削除は、目次の並び順が「ファイル順」のときに使えます'); return; }
  if (act === 'up') moveEpisode(-1, index);
  else if (act === 'down') moveEpisode(1, index);
  else if (act === 'chapter') moveEpisodeToChapter(to, index);
  else if (act === 'delete') deleteEpisode(index).catch(fail);
}

// ---------- 目次の検索 ----------
// 開いている側（なろう用／アルファ用）の原稿のタイトル・前書き・本文・後書きと、プロット・フリーメモから探す。
// 一覧の話を押すと、その話の最初の場所を選択する。同じ話をもう一度押すと次の場所へ。
let epSearch = '';
let searchCursor = { id: null, n: -1 };
const SEARCH_FIELDS = [['title', 'タイトル'], ['foreword', '前書き'], ['body', '本文'], ['afterword', '後書き'], ['plot', 'プロット'], ['freeMemo', 'メモ']];

function searchText(ep, key) {
  return (key === 'plot' || key === 'freeMemo' ? ep[key] : draftOf(ep, editSite)[key]) || '';
}

function findHits(ep, q = epSearch) {
  const hits = [];
  const lq = q.toLowerCase();
  if (!lq) return hits;
  for (const [key, label] of SEARCH_FIELDS) {
    const t = searchText(ep, key).toLowerCase();
    for (let i = t.indexOf(lq); i >= 0; i = t.indexOf(lq, i + lq.length)) hits.push({ key, label, index: i });
  }
  return hits;
}

function renderSearchResults(list) {
  const found = project.episodes.map((ep, i) => ({ i, hits: findHits(ep) })).filter((r) => r.hits.length);
  const total = found.reduce((n, r) => n + r.hits.length, 0);
  list.append(Object.assign(document.createElement('li'), {
    className: 'search-head',
    textContent: found.length ? `「${epSearch}」${found.length}話・${total}件（${SITES[editSite].short}用の原稿）` : `「${epSearch}」は見つかりません（${SITES[editSite].short}用の原稿）`,
  }));
  for (const { i, hits } of found) {
    const counts = new Map();
    for (const h of hits) counts.set(h.label, (counts.get(h.label) || 0) + 1);
    const meta = [...counts].map(([label, n]) => `${label} ${n}`).join('・');
    list.append(episodeRow(i, { meta: () => meta }, true));
  }
}

function setEpisodeSearch(q) {
  epSearch = q;
  searchCursor = { id: null, n: -1 };
  renderEpisodeList();
}

// 検索で見つけた場所を選択する（押すたびに次の場所へ）
function jumpToSearchHit(i) {
  const ep = project.episodes[i];
  const hits = findHits(ep);
  if (!hits.length) return;
  searchCursor = searchCursor.id === ep.id ? { id: ep.id, n: (searchCursor.n + 1) % hits.length } : { id: ep.id, n: 0 };
  const h = hits[searchCursor.n];
  const target = { title: el.epTitle, foreword: el.foreword, body: el.body, afterword: el.afterword, plot: el.plot, freeMemo: el.freeMemo }[h.key];
  if (h.key === 'foreword') $('foreword-box').open = true;
  if (h.key === 'afterword') $('afterword-box').open = true;
  if (!target || !target.offsetParent) { toast(`${h.label}にあります（${h.label}を表示にすると選択できます）`); return; }
  jumpToText(target, h.index, epSearch.length);
  toast(`${h.label}（${searchCursor.n + 1}／${hits.length}件目）${hits.length > 1 ? '　もう一度押すと次へ' : ''}`);
}

// 「表示」の章・エピソードを「リスト」にしたとき：エピソードを選ぶ一覧（章ごとにまとめる）。
// プルダウンは iPhone で今のエピソードに✓が付き、同じものを選び直しても何も起きないため、ボタンの一覧にする。
// どれを押しても（今のエピソードでも）本文の編集画面へ移る。今のエピソードは色で示す（✓は付けない）
function renderEpisodePick() {
  const box = $('ep-pick');
  const btn = (i) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ep-pick-item', textContent: `${i + 1}. ${episodeName(project.episodes[i], project.site)}` });
    b.dataset.ep = i;
    if (view === 'episode' && i === epIndex) { b.classList.add('current'); b.setAttribute('aria-current', 'true'); }
    return b;
  };
  box.replaceChildren();
  // 並べ方は目次と同じ（章あり／章なし・並び順・昇順／降順。隠していても、最後に選んだ設定で並べる）
  if (!epSort.grouped || !project.chapters.length) { box.append(...sortedEpisodeIndexes().map(btn)); return; }
  const groups = episodeGroups().filter((x) => x.indexes.length);
  const chapterGroups = groups.filter((g) => g.chapter);
  if (epSort.dir === 'desc') chapterGroups.reverse();
  for (const g of [...chapterGroups, ...groups.filter((g) => !g.chapter)]) {
    box.append(Object.assign(document.createElement('div'), { className: 'ep-pick-chapter', textContent: g.chapter ? chapterName(g.chapter) : '未分類' }), ...sortedEpisodeIndexes(g.indexes).map(btn));
  }
}

function renderEpisodeList() {
  renderEpisodePick();
  const list = $('episode-list');
  list.replaceChildren();
  // 「ボタンの一覧」でも、検索しているときは検索結果（押すと見つけた場所へ）を出す
  document.body.classList.toggle('ep-searching', !!epSearch);
  if (epSearch) { renderSearchResults(list); return; }
  const sort = EP_SORTS[epSort.key];
  // 「章なし」は章を抜きにして、全エピソードを選択した条件で並べる
  if (!epSort.grouped) {
    for (const i of sortedEpisodeIndexes()) list.append(episodeRow(i, sort, true));
    return;
  }
  const collapsed = collapsedSet();
  const groups = episodeGroups();
  // 章あり＋降順では、章の中だけでなく章自体も逆順にする。未分類は常に最後に置く。
  const uncategorized = groups.find((g) => !g.chapter);
  const chapterGroups = groups.filter((g) => g.chapter);
  if (epSort.dir === 'desc') chapterGroups.reverse();
  for (const g of [...chapterGroups, uncategorized].filter(Boolean)) {
    const key = g.chapter ? g.chapter.id : UNCAT;
    // 未分類は、中身があるときか、章が1つもないときに出す
    if (!g.chapter && !g.indexes.length && project.chapters.length) continue;
    const isOpen = !collapsed.has(key);

    const head = Object.assign(document.createElement('li'), { className: 'chapter-row' + (g.chapter ? '' : ' uncategorized') });
    const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'chapter-toggle' });
    toggle.dataset.toggleChapter = key;
    toggle.setAttribute('aria-expanded', String(isOpen));
    const name = g.chapter ? chapterName(g.chapter) : '未分類';
    toggle.title = name;
    toggle.append(
      Object.assign(document.createElement('span'), { className: 'caret', textContent: isOpen ? '▾' : '▸' }),
      Object.assign(document.createElement('span'), { className: 'chapter-name', textContent: name }),
      Object.assign(document.createElement('span'), { className: 'chapter-count', textContent: `${g.indexes.length}` }));
    head.append(toggle);
    if (g.chapter) head.append(chapterMenu(g.chapter));
    list.append(head);
    if (!isOpen) continue;

    for (const i of sortedEpisodeIndexes(g.indexes)) list.append(episodeRow(i, sort));
  }
}

// --- 章の操作（目次と全体プロットで共通） ---

function addChapter(afterIndex = project.chapters.length - 1, title = '') {
  const ch = format.newChapter({ title });
  project.chapters.splice(afterIndex + 1, 0, ch);
  normalizeOrder();
  changed();
  renderEpisodeList();
  return ch;
}

async function addChapterFromList() {
  const title = await askText('新しい章の名前', `第${project.chapters.length + 1}章`);
  if (title === null) return;
  addChapter(project.chapters.length - 1, title.trim());
  toast(`章「${title.trim() || '（無題の章）'}」を追加しました`);
}

async function renameChapter(ch) {
  const title = await askText('章の名前', ch.title);
  if (title === null) return;
  ch.title = title.trim();
  changed();
  renderEpisodeList();
}

function moveChapter(ch, delta) {
  const i = project.chapters.indexOf(ch);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= project.chapters.length) return false;
  [project.chapters[i], project.chapters[j]] = [project.chapters[j], project.chapters[i]];
  normalizeOrder();
  changed();
  renderEpisodeList();
  return true;
}

// 章を消しても、所属していたエピソードは消さずに未分類へ移す
async function removeChapter(ch) {
  const n = episodeCountIn(ch);
  const name = chapterName(ch);
  if (!(await ask(`章「${name}」を削除しますか？\n${n ? `所属している ${n}話は「未分類」に移ります（エピソードは消えません）。` : '所属しているエピソードはありません。'}`))) return false;
  if (ch.plot && !(await ask(`【最終確認】章「${name}」のプロット ${countChars(ch.plot).all.toLocaleString()}字は消えます。削除しますか？`))) return false;
  for (const e of project.episodes) if (e.chapterId === ch.id) e.chapterId = null;
  project.chapters.splice(project.chapters.indexOf(ch), 1);
  normalizeOrder();
  changed();
  renderEpisodeList();
  toast(`章「${name}」を削除しました${n ? `（${n}話を未分類へ）` : ''}`);
  return true;
}

function chapterAction(act, chapterId) {
  const ch = project.chapters.find((c) => c.id === chapterId);
  if (!ch) return;
  closeMenus();
  if (act === 'add-ep') addEpisode(ch.id);
  else if (act === 'rename') renameChapter(ch);
  else if (act === 'plot') { outline.select(ch.id); setView('outline'); }
  else if (act === 'up') moveChapter(ch, -1);
  else if (act === 'down') moveChapter(ch, 1);
  else if (act === 'delete') removeChapter(ch);
}

// エピソードを別の章（または未分類）へ移す。移した先の章の最後に並べる。開いているエピソードはそのまま
function moveEpisodeToChapter(chapterId, index = epIndex) {
  const ep = project.episodes[index];
  const to = chapterId || null;
  if (!ep || ep.chapterId === to) return;
  const current = episode();
  ep.chapterId = to;
  project.episodes.splice(index, 1);
  project.episodes.push(ep);
  epIndex = project.episodes.indexOf(current);
  normalizeOrder();
  changed();
  // 移した先の章が折りたたまれていたら開く
  const set = collapsedSet();
  if (set.delete(to || UNCAT)) prefs.set('collapsed:' + project.id, [...set]);
  renderEpisodeList();
  const dest = to ? chapterName(project.chapters.find((c) => c.id === to)) : '未分類';
  toast(`「${episodeName(ep)}」を「${dest}」へ移しました`);
}

function showEpisode() {
  const ep = episode();
  const d = cur();
  el.epTitle.value = d.title;
  el.foreword.value = d.foreword;
  el.body.value = d.body;
  el.afterword.value = d.afterword;
  el.plot.value = ep.plot;
  el.freeMemo.value = ep.freeMemo;
  // このエピソードの活動報告
  const r = epReport(ep);
  el.xText.value = r.x;
  el.nrTitle.value = r.narouTitle;
  el.nrBody.value = r.narouBody;
  if (reportMode) renderReportView();
  // 前書き・後書きは中身があるときだけ開いておく
  $('foreword-box').open = !!d.foreword;
  $('afterword-box').open = !!d.afterword;
  updateCounts();
  renderSiteTabs();
  renderEpisodeVersions().catch(() => {});
}

// ---------- 活動報告（エピソードごと：ep.report = { x, narouTitle, narouBody, updatedAt }） ----------
// エピソードの画面の「活動報告」タブで開く（なろう用・アルファ用と同じ並び）。
let reportMode = false;

function epReport(ep = episode()) {
  return { x: '', narouTitle: '', narouBody: '', ...(ep.report || {}) };
}

function setReport(key, value) {
  const ep = episode();
  ep.report = { ...epReport(ep), [key]: value, updatedAt: new Date().toISOString() };
  touchEpisode(ep);
}

function setReportMode(on) {
  reportMode = !!on && uiPref('show.report');
  document.body.classList.toggle('report-mode', reportMode);
  $('report-pane').hidden = !reportMode;
  $('report-tab').setAttribute('aria-selected', String(reportMode));
  if (reportMode && maximized) restoreMaximized();
  renderSiteTabs();
  if (reportMode) renderReportView();
}

// 6.0 より前の、作品に1つだった活動報告を、エピソードの活動報告へ移す（移す先を選んでもらう。元の内容は作品にも残す）
let reportMigrationAsked = null;
async function migrateProjectReports() {
  const p = project;
  const r = p.reports || {};
  if (p.reportsMigrated || reportMigrationAsked === p.id) return;
  if (!(r.x || r.narouTitle || r.narouBody)) { p.reportsMigrated = true; quietSave(); return; }
  reportMigrationAsked = p.id; // 「あとで」を選んだら、作品を開き直すまで聞かない
  const last = p.episodes.length - 1;
  const ans = await choose('活動報告は、エピソードごとに保存するようになりました。\nこの作品の今までの活動報告（X の投稿文・なろう活動報告）を、どのエピソードの活動報告にしますか？',
    [{ value: 'move', label: 'このエピソードに移す', primary: true }],
    { cancel: 'あとで', select: { label: '移す先のエピソード', options: p.episodes.map((e, i) => ({ value: String(i), label: `${i + 1}. ${episodeName(e, p.site)}` })), value: String(last) } });
  if (!ans || project !== p) return;
  const ep = p.episodes[Number(ans.value)] || p.episodes[last];
  const now = epReport(ep);
  ep.report = { x: now.x || r.x || '', narouTitle: now.narouTitle || r.narouTitle || '', narouBody: now.narouBody || r.narouBody || '', updatedAt: new Date().toISOString() };
  p.reportsMigrated = true;
  changed();
  if (ep === episode()) showEpisode();
  toast(`今までの活動報告を「${episodeName(ep, p.site)}」の活動報告に移しました`);
}

// 編集中の原稿（なろう用／アルファ用）に合わせて、使える機能（ボタン・前書き・後書き）を切り替える
function applySite() {
  document.body.dataset.site = editSite;
  $('site-badge').textContent = SITES[editSite].label + '用の原稿' + (editSite === project.site ? '（メイン）' : '（サブ）');
  el.body.placeholder = editSite === 'narou'
    ? '本文\n\nみてみんの画像URL（https://〜.mitemin.net/i〜/）を貼り付けると、挿絵タグに自動で変わります'
    : '本文';
}

// なろう用／アルファ用のタブ。メイン側に印を付ける
function renderSiteTabs() {
  document.querySelectorAll('[data-edit-site]').forEach((b) => {
    const s = b.dataset.editSite;
    const d = draftOf(episode(), s);
    const filled = d.body || d.title ? '' : '（空）';
    b.replaceChildren(document.createTextNode(`${SITES[s].short}用${filled}`));
    if (s === project.site) b.append(Object.assign(document.createElement('span'), { className: 'main-mark', textContent: 'メイン' }));
    b.setAttribute('aria-selected', String(s === editSite && !reportMode));
  });
  const copyBtn = $('copy-main-to-sub');
  copyBtn.replaceChildren(
    Object.assign(document.createElement('span'), { className: 'long', textContent: `${SITES[project.site].short}（メイン）→ ${SITES[subSite()].short}（サブ）にコピー…` }),
    Object.assign(document.createElement('span'), { className: 'short', textContent: `${SITES[subSite()].short}へコピー…` }));
  copyBtn.setAttribute('aria-label', `${SITES[project.site].short}（メイン）から${SITES[subSite()].short}（サブ）へコピー`);
}

function setEditSite(site) {
  if (reportMode) setReportMode(false); // 活動報告からなろう用・アルファ用へ戻る
  if (!SITE_KEYS.includes(site) || site === editSite) return;
  editSite = site;
  applySite();
  showEpisode();
}

function setView(next) {
  view = next;
  for (const v of VIEWS) $('view-' + v).hidden = v !== view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'outline') outline.render();
  if (view === 'world') worldTable.render();
  if (view === 'characters') characterTable.render();
  renderEpisodeList();
  document.body.classList.remove('drawer-open');
}

function selectEpisode(i) {
  epIndex = Math.max(0, Math.min(i, project.episodes.length - 1));
  prefs.set('ep:' + project.id, project.episodes[epIndex].id);
  showEpisode();
  setView('episode');
}

function showProject(p, handle = null) {
  if (project?.id !== p.id && epSearch) { epSearch = ''; $('ep-search').value = ''; } // 作品を替えたら検索を消す
  project = normalize(p);
  fileHandle = handle;
  el.novelTitle.value = project.title;
  el.site.value = project.site;
  el.synopsis.value = project.synopsis;
  el.projectMemo.value = project.projectMemo || '';
  el.narouUrl.value = project.narouUrl;
  el.alphaUrl.value = project.alphaUrl;
  $('work-ncode').value = project.narouNcode || '';
  $('work-alpha-id').value = project.alphaWorkId || '';
  renderWorkCodes();
  // 前回開いていたエピソード（ID で覚える。旧版は位置で覚えていた）
  const last = prefs.get('ep:' + project.id, 0);
  epIndex = typeof last === 'string'
    ? Math.max(0, project.episodes.findIndex((e) => e.id === last))
    : Math.min(Number(last) || 0, project.episodes.length - 1);
  normalizeOrder();
  lastSavedAt = project.updatedAt;
  dirty = false;
  autoDirty = false;
  lastAutoVersionAt = Date.now();
  prefs.set('currentId', project.id);
  editSite = project.site;
  applySite();
  showEpisode();
  setView('episode');
  updateStatus();
  // 以前の版の、作品に1つだった活動報告があれば、エピソードへ移す（画面が出そろってから聞く）
  setTimeout(() => migrateProjectReports().catch(fail), 800);
}

async function switchTo(p, handle = null) {
  await flush();
  await autoVersion(60_000);
  // 何も書いていない作品は一覧に残さない
  if (project && p.id !== project.id && isEmptyProject(project) && !Object.keys(project.links || {}).length) {
    await db.remove(project.id);
  }
  await db.put(p);
  showProject(p, handle);
}

// ---------- エピソード操作 ----------

// 追加先の章：指定がなければ、いま開いているエピソードと同じ章（その章の最後に入る）
function addEpisode(chapterId = episode()?.chapterId ?? null) {
  const ep = newEpisode({ chapterId });
  project.episodes.push(ep);
  normalizeOrder();
  changed();
  selectEpisode(project.episodes.indexOf(ep));
  el.epTitle.focus();
}

// 上へ・下へ：同じ章の中で前後と入れ替える。開いているエピソードはそのまま
function moveEpisode(delta, index = epIndex) {
  if (epSort.key !== 'file') {
    toast('並べ替えは、目次の並び順が「ファイル順」のときに使えます');
    return;
  }
  if (epSort.dir === 'desc') delta = -delta; // 降順表示では見た目の上下に合わせる
  const group = episodeGroups().find((g) => g.indexes.includes(index)).indexes;
  const to = group[group.indexOf(index) + delta];
  if (to === undefined) {
    toast(delta < 0 ? 'この章の最初のエピソードです（別の章へは「⋯」→「章を移動」で移せます）' : 'この章の最後のエピソードです（別の章へは「⋯」→「章を移動」で移せます）');
    return;
  }
  const current = episode();
  const eps = project.episodes;
  [eps[index], eps[to]] = [eps[to], eps[index]];
  epIndex = eps.indexOf(current);
  changed();
  renderEpisodeList();
}

// 間違って消さないよう、2回確認する
async function deleteEpisode(index = epIndex) {
  const ep = project.episodes[index];
  const name = `「${episodeName(ep)}」`;
  const size = countChars(mainDraft(ep).body).all;
  if (!(await ask(project.episodes.length === 1 ? `${name}の内容を消しますか？` : `${name}を削除しますか？`))) return;
  if (!(await ask(`【最終確認】本当に${name}を削除しますか？\n本文 ${size.toLocaleString()}字が消え、元に戻せません。`))) return;
  // 確認している間に並びが変わっていても、同じエピソードを消す
  index = project.episodes.indexOf(ep);
  if (index < 0) return;
  const last = project.episodes.length === 1;
  if (last) project.episodes[0] = newEpisode();
  else project.episodes.splice(index, 1);
  removeEpisodeVersions(ep.id).catch(() => {});
  changed();
  const next = index < epIndex ? epIndex - 1 : Math.min(epIndex, project.episodes.length - 1);
  if (view === 'episode') selectEpisode(next);
  else { epIndex = next; renderEpisodeList(); }
  toast(`${name}を削除しました`);
}

// メイン投稿サイトを変える。原稿はサイトごとに別々に持っているので、書き換えや変換はしない
function changeSite(site) {
  if (site === project.site) return;
  project.site = site;
  changed();
  editSite = site;
  applySite();
  showEpisode();
  renderEpisodeList();
  const empty = project.episodes.every((e) => !draftOf(e, site).body);
  toast(`メイン投稿サイトを${SITES[site].label}にしました。`
    + (empty ? '　こちらの原稿はまだ空です（もう一方の原稿は残っています）' : '　なろう用・アルファ用の原稿はそれぞれそのまま残っています'));
  updateStatus();
}

// ---------- 作品一覧 ----------

async function allProjects() {
  return (await db.all()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

async function createProject() {
  await flush();
  if (isEmptyProject(project)) { el.novelTitle.focus(); return; }
  await switchTo(newProject({ site: project.site }));
  el.novelTitle.focus();
  toast('新しい作品を作成しました');
}

async function renderLibrary() {
  const list = $('library-list');
  list.replaceChildren();
  const projects = await allProjects();
  if (!projects.length) { list.append(li('empty', '作品がありません')); return; }
  for (const p of projects) {
    const current = p.id === project.id;
    const buttons = [];
    if (!current) buttons.push(button('開く', async () => { $('library-dialog').close(); await switchTo(p); }));
    buttons.push(button('削除', async () => {
      if (!(await confirmProjectDelete(p))) return;
      await db.remove(p.id);
      await versions.removeProject(p.id);
      if (current) {
        dirty = false;
        const next = (await allProjects())[0] || newProject();
        await db.put(next);
        showProject(next);
      }
      renderLibrary();
    }, 'danger'));
    const codes = [p.narouNcode && `なろう ${p.narouNcode}`, p.alphaWorkId && `アルファ ${p.alphaWorkId}`].filter(Boolean);
    const meta = `${p.episodes.length}話 ・ 本文 ${totalChars(p).toLocaleString()}字 ・ ${fmtTime(p.updatedAt)}${codes.length ? ' ・ ' + codes.join('・') : ''}`;
    list.append(listItem(p.title || '（無題）', meta, buttons, current));
  }
}

// 作品の削除は3段階で確認する（最後は作品名の入力）
async function confirmProjectDelete(p) {
  const n = normalize(p);
  const name = n.title || '無題';
  const vcount = (await versions.list(p.id)).length;
  if (!(await ask(`作品「${name}」をこの端末から削除しますか？`))) return false;
  if (!(await ask(`【2回目の確認】\n「${name}」の ${n.episodes.length}話・本文 ${totalChars(n).toLocaleString()}字、`
    + `プロット・世界観・用語・登場人物、変更履歴${vcount}件がすべて消えます。\n`
    + '（「ファイル」で保存したものや、サーバのバックアップファイルは残ります）\n本当に削除しますか？'))) return false;
  const word = n.title || '削除';
  const typed = await askText(`【最終確認】削除するには、${n.title ? '作品名' : '「削除」'}を正確に入力してください。\n${word}`, '', { ok: '削除する', danger: true });
  if (typed === null) return false;
  if (typed.trim() !== word) { toast('入力が一致しなかったので、削除しませんでした'); return false; }
  return true;
}

async function openLibrary() {
  await flush();
  await renderLibrary();
  $('library-dialog').showModal();
}

// 読み込んだ内容を端末の作品に入れる。同じ作品（タイトルと作成日時が同じ）があればそれを更新する
async function importContent(content, links = {}) {
  const projects = await allProjects();
  // 同じ作品か：① workId が一致 ② クラウドの同じファイル ③ タイトルと作成日時が一致（workId のない旧データ）
  const same = (content.workId && projects.find((p) => p.workId === content.workId))
    || projects.find((p) => Object.entries(links).some(([k, v]) => p.links?.[k] === v))
    || projects.find((p) => p.createdAt === content.createdAt && p.title === content.title);
  if (same) {
    const localNewer = content.updatedAt && same.updatedAt > content.updatedAt;
    if (localNewer && serialize(same) !== serialize({ ...same, ...content })
      && !(await ask('この端末の内容の方が新しいようです。\n読み込んだ内容で上書きしますか？\n（「キャンセル」で端末の内容を開きます）'))) {
      return { ...same, links: { ...same.links, ...links } };
    }
    return normalize({ ...same, ...content, id: same.id, links: { ...same.links, ...links } });
  }
  if (isEmptyProject(project) && !Object.keys(project.links || {}).length) {
    return normalize({ ...content, id: project.id, links });
  }
  return normalize({ ...newProject(), ...content, links });
}

// ---------- ローカルファイル ----------

// ---------- 保存先の選択（クラウド／この端末・その他） ----------
// クラウドは「設定」→「クラウド」で選んだ1つ（Google ドライブか OneDrive）。
// 設定（端末ごと）：'ask' 毎回選ぶ（既定）／'cloud' クラウドを優先／'local' この端末・その他を優先
// クラウドを設定していない端末では、選ぶ画面を出さずに「この端末・その他」にする。
// （以前の版の 'gdrive' は 'cloud' として読む）
const DEST_KEY = 'file.destination';
const oldCloud = (v) => (v === 'gdrive' ? 'cloud' : v);

// 「ファイル」で使えるクラウド（選んだクラウドに ID を入れてあれば）
function driveProvider() {
  const p = activeProvider();
  return p?.isConfigured() && p.save ? p : null;
}
const cloudName = () => activeProvider()?.label || 'クラウド';
const cloudDestinationLabel = () => `${cloudName()}（クラウドで設定したドライブ）`;

// 「ファイル」タブの設定が「だけを使う」なら選ぶ画面を出さず、そのまま返す（すぐにそれぞれの画面へ）
async function chooseDestination(kind) {
  const p = driveProvider();
  if (!p) return 'local';
  const pref = oldCloud(prefs.get(DEST_KEY, 'ask'));
  if (pref !== 'ask') return pref;
  const last = oldCloud(prefs.get('file.lastDestination', 'local'));
  const drive = { value: 'cloud', label: cloudDestinationLabel(), primary: last === 'cloud' };
  const local = { value: 'local', label: 'この端末・その他（iCloud など）', primary: last !== 'cloud' };
  // 前回使ったほうを右端（目立つボタン）に置く
  const r = await choose(kind === 'open' ? 'どこから開きますか？' : 'どこに保存しますか？', last === 'cloud' ? [local, drive] : [drive, local]);
  if (r) prefs.set('file.lastDestination', r);
  return r;
}

// ファイルの種類：json（AYATUZURI のファイル）／txt（プレーンテキスト）
const FILE_KINDS = {
  json: { ext: '.json', mime: 'application/json', types: WORK_TYPES },
  txt: { ext: '.txt', mime: 'text/plain', types: TEXT_TYPES },
  // TXT インポート：TXT と ZIP を、文字にせずそのまま読む（文字コードはインポートの画面で判定する）
  import: { ext: '.txt', exts: ['.txt', '.zip'], bytes: true },
};

// ---------- クラウドの画面（エディター内のフォルダ選択。Google ドライブ・OneDrive 共通） ----------
// iPhone・iPad でも、クラウドのフォルダをたどって選び、その場で新しいフォルダを作れる。
// フォルダの読み方はサービスごと：Google ドライブは全部を一度に（folders）、OneDrive は開くたびに（childFolders）。
//
// mode: 'save'   … ファイル名を入れて、このフォルダに保存（一覧のファイルを押すと上書き）
//       'open'   … フォルダをたどって、ファイルを選ぶ
//       'folder' … フォルダを選ぶ（「クラウド」タブの保存先フォルダ・自動バックアップのフォルダ）
// 戻り値: save → { type: 'cloud', label, id, name }／'local'（この端末・その他を選び直した）／null
//         open → { id, name }／'local'／null
//         folder → { id, name }／null
let driveUi = null; // { p, mode, kind, text, workId, resolve, folders, byId, cur, lazy, loaded }

const hasExt = (name, kind) => (FILE_KINDS[kind].exts || [FILE_KINDS[kind].ext]).some((ext) => name.toLowerCase().endsWith(ext));
// 前回開いたフォルダ（サービスごと。Google ドライブは以前の版と同じ gdrive.lastFolder）
const lastFolderKey = (p) => `${p.id}.lastFolder`;

function driveBrowse({ p, mode, kind = 'json', title, name = '', text = '', workId = '' }) {
  return new Promise((resolve) => {
    driveUi = { p, mode, kind, text, workId, resolve, folders: null, byId: new Map(), cur: null, lazy: !p.folders, loaded: new Set() };
    $('drive-title').textContent = title;
    $('drive-name').value = name;
    $('drive-name-row').hidden = mode !== 'save';
    $('drive-ok').hidden = mode === 'open';
    $('drive-ok').textContent = mode === 'folder' ? 'このフォルダにする' : '保存';
    $('drive-local').hidden = mode === 'folder';
    $('drive-local').textContent = mode === 'open' ? 'この端末・その他から開く…' : 'この端末・その他に保存…';
    $('drive-hint').textContent = p.browseHint || '';
    $('drive-dialog').showModal();
    withBusy('一覧を読み込み中…', loadDriveFolders).catch((e) => { finishDrive(null); fail(e); });
  });
}

// 開くたびに読むサービス：そのフォルダの中のフォルダを読んでおく（一番上は null）
async function ensureDriveChildren(ui, id) {
  if (!ui.lazy || ui.loaded.has(id ?? '')) return;
  const subs = await ui.p.childFolders(id);
  for (const f of subs) {
    if (!ui.byId.has(f.id)) { ui.folders.push(f); ui.byId.set(f.id, f); }
  }
  ui.loaded.add(id ?? '');
}

function finishDrive(result) {
  const ui = driveUi;
  driveUi = null;
  if ($('drive-dialog').open) $('drive-dialog').close();
  ui?.resolve(result);
}

// フォルダの一覧を読み、最初に開くフォルダを決める（前回のフォルダ → 保存先フォルダ → 一番上）
async function loadDriveFolders() {
  const ui = driveUi;
  const list = $('drive-list');
  $('drive-path').replaceChildren();
  // ログイン画面は、押したとき以外は出せない（iPhone・iPad）。ログインしていなければボタンを出す
  if (!ui.p.canSaveSilently()) {
    list.replaceChildren(listItem('フォルダを見るには、ログインが必要です', '', [
      button('ログインして続ける', async () => { await ui.p.signIn(); if (driveUi === ui) await withBusy('一覧を読み込み中…', loadDriveFolders); }),
    ]));
    $('drive-ok').disabled = true;
    return;
  }
  list.replaceChildren(li('empty', '読み込み中…'));
  const home = await ui.p.defaultFolderId().catch(() => null);
  const last = prefs.get(lastFolderKey(ui.p), null);
  if (ui.lazy) {
    // 前回のフォルダ → 保存先フォルダ → 一番上。そのフォルダまでの並びを読んでおく（消されていれば次の候補）
    ui.folders = [];
    ui.byId = new Map();
    let start = null;
    for (const id of [last, home]) {
      if (!id) continue;
      const path = await ui.p.folderPath(id).catch(() => null);
      if (driveUi !== ui) return;
      if (path?.length) {
        for (const f of path) if (!ui.byId.has(f.id)) { ui.folders.push(f); ui.byId.set(f.id, f); }
        start = id;
        break;
      }
    }
    await ensureDriveChildren(ui, null);
    if (start) await ensureDriveChildren(ui, start);
    if (driveUi !== ui) return;
    ui.cur = start;
    await renderDrive();
    return;
  }
  const folders = await ui.p.folders();
  if (driveUi !== ui) return;
  ui.folders = folders;
  ui.byId = new Map(folders.map((f) => [f.id, f]));
  ui.cur = [last, home].find((id) => id && ui.byId.has(id)) || null;
  await renderDrive();
}

// 見えるフォルダの中での親（親が見えないフォルダは一番上に並べる）
function driveParent(f) {
  return (f?.parents || []).find((id) => driveUi.byId.has(id)) || null;
}

function drivePath(id) {
  const path = [];
  for (let f = driveUi.byId.get(id); f; f = driveUi.byId.get(driveParent(f))) {
    path.unshift(f);
    if (path.length > 30) break;
  }
  return path;
}

function goDriveFolder(id) {
  const ui = driveUi;
  if (!ui) return;
  ui.cur = id;
  if (ui.lazy && !ui.loaded.has(id ?? '')) $('drive-list').replaceChildren(li('empty', '読み込み中…'));
  withBusy('一覧を読み込み中…', async () => {
    await ensureDriveChildren(ui, id);
    if (driveUi === ui) await renderDrive();
  }).catch(fail);
}

async function renderDrive() {
  const ui = driveUi;
  if (!ui) return;
  // 場所（パンくず）
  const path = $('drive-path');
  const crumbs = [{ id: null, name: ui.p.rootName || ui.p.label }, ...drivePath(ui.cur)];
  path.replaceChildren();
  crumbs.forEach((c, i) => {
    if (i) path.append(Object.assign(document.createElement('span'), { className: 'sep', textContent: '▸' }));
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: c.name, disabled: i === crumbs.length - 1 });
    b.addEventListener('click', () => goDriveFolder(c.id));
    path.append(b);
  });
  $('drive-up').disabled = !ui.cur;
  $('drive-ok').disabled = !ui.cur; // 一番上（マイドライブ直下の一覧）ではフォルダを選んでもらう

  const list = $('drive-list');
  list.replaceChildren();
  const subs = ui.folders.filter((f) => driveParent(f) === ui.cur).sort((a, b) => collator.compare(a.name, b.name));
  for (const f of subs) {
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'drive-folder' });
    b.append('📁 ', Object.assign(document.createElement('span'), { textContent: f.name }), Object.assign(document.createElement('span'), { className: 'go', textContent: '▸' }));
    b.addEventListener('click', () => goDriveFolder(f.id));
    const item = document.createElement('li');
    item.append(b);
    list.append(item);
  }
  if (ui.mode !== 'folder' && ui.cur) {
    let files = [];
    try {
      files = (await ui.p.filesIn(ui.cur)).filter((f) => hasExt(f.name, ui.kind));
    } catch (e) {
      list.append(li('empty', 'ファイルを読み込めませんでした：' + e.message));
    }
    if (driveUi !== ui) return;
    for (const f of files) {
      // 最初から強調するボタンは置かない（押したボタンだけを処理中の色にする）
      const act = Object.assign(document.createElement('button'), { type: 'button', textContent: ui.mode === 'open' ? '開く' : '上書き', className: ui.mode === 'open' ? '' : 'danger' });
      act.addEventListener('click', () => (ui.mode === 'open'
        // 開く：読み込みが済んでから画面を閉じる（失敗したら画面に理由を出す）
        ? runTask('load', () => (FILE_KINDS[ui.kind].bytes ? ui.p.loadBytes(f.id) : ui.p.load(f.id)), { button: act, dialog: $('drive-dialog'), busy: 'ファイルを読み込み中…', done: null, closeOnSuccess: false })
          .then((data) => {
            if (typeof data === 'string') finishDrive({ id: f.id, name: f.name, text: data });
            else if (data instanceof ArrayBuffer) finishDrive({ id: f.id, name: f.name, bytes: data });
          })
        : ask(`「${f.name}」を、今の内容で上書きしますか？\n（前の内容は ${ui.p.label} の版の履歴から戻せます）`, { ok: '上書きする' })
          .then((yes) => (yes ? runDriveSave(f.name, f.id, act) : null))).catch(fail));
      list.append(listItem(f.name, '更新 ' + fmtTime(f.modifiedTime), [act]));
    }
  }
  if (!list.children.length) {
    list.append(li('empty', ui.cur ? (ui.mode === 'open' ? 'このフォルダには開けるファイルがありません' : 'このフォルダは空です') : '見えるフォルダがありません。「＋ 新しいフォルダ」で作ってください'));
  }
}

async function newDriveFolder() {
  const ui = driveUi;
  if (!ui) return;
  const name = await askText(`新しいフォルダの名前（${ui.cur ? `「${ui.byId.get(ui.cur).name}」の中` : `${ui.p.rootName || ui.p.label}の直下`}に作ります）`, '小説');
  if (!name || !name.trim() || driveUi !== ui) return;
  // 同じ場所に同じ名前のフォルダがあれば、作らずにそれを開く（同じ名前のフォルダが並ばないように）
  const f = await ui.p.makeFolder(name.trim(), ui.cur);
  if (!ui.byId.has(f.id)) {
    // 開くたびに読むサービスでは、親が一番上でも一覧の上に並ぶよう、親を今のフォルダにそろえる
    const entry = ui.lazy ? { ...f, parents: ui.cur ? [ui.cur] : [] } : f;
    ui.folders.push(entry);
    ui.byId.set(f.id, entry);
  }
  goDriveFolder(f.id);
  toast(f.existed ? `同じ名前のフォルダ「${f.name}」が既にあるので、それを開きました` : `フォルダ「${f.name}」を作りました`);
}

// 「このフォルダに保存」「このフォルダにする」
async function driveOk() {
  const ui = driveUi;
  if (!ui?.cur) return;
  prefs.set(lastFolderKey(ui.p), ui.cur);
  if (ui.mode === 'folder') { const f = ui.byId.get(ui.cur); finishDrive({ id: f.id, name: f.name }); return; }
  if (ui.mode === 'save') await runDriveSave($('drive-name').value, null, $('drive-ok'));
}

// 通信が途中で切れたなどで結果が分からないとき、保存先に実際にファイルができたかを確かめる。
// できていれば成功とする（保存できているのに「失敗」と出さないため）
async function confirmCloudSaved(p, folderId, name, startedAt) {
  setBusyMessage('処理結果を確認しています…');
  try {
    const files = await p.filesIn(folderId);
    const hit = files.find((f) => f.name === name && (!f.modifiedTime || Date.parse(f.modifiedTime) >= startedAt - 120_000));
    return hit || null;
  } catch {
    return null;
  }
}

async function runDriveSave(name, fileId = null, btn = $('drive-ok')) {
  const ui = driveUi;
  if (!ui || !ui.cur) return;
  let finalName = name.trim() || 'untitled';
  if (!hasExt(finalName, ui.kind)) finalName += FILE_KINDS[ui.kind].ext;
  const saved = await runTask('save', async () => {
    const startedAt = Date.now();
    try {
      // 戻り値は ID（Google ドライブ）か { id, name }（OneDrive。同じ名前があって番号を付けたときは、その名前）
      return await ui.p.save(ui.text, finalName, fileId, { workId: ui.workId, mime: FILE_KINDS[ui.kind].mime, folderId: ui.cur });
    } catch (e) {
      if (e?.name === 'NeedLoginError') throw e;
      const hit = await confirmCloudSaved(ui.p, ui.cur, finalName, startedAt);
      if (hit) return { id: hit.id, name: hit.name };
      throw e;
    }
  }, { button: btn, dialog: $('drive-dialog'), busy: ui.busyText || '保存中…', done: null, closeOnSuccess: false });
  if (saved === null || saved === false) return; // 失敗：画面は開いたまま（理由は画面に出ている）
  prefs.set(lastFolderKey(ui.p), ui.cur);
  prefs.set('file.lastDestination', 'cloud');
  finishDrive({ type: 'cloud', label: ui.p.label, id: saved?.id ?? saved, name: saved?.name || finalName });
}

// 保存・開くで使う入口（前の版からの名前）。busyText：書き込む間に出す文言（「バックアップ作成中…」など）
async function openDriveSave({ p, title, name, text, workId = '', kind = 'json', busyText = '' }) {
  const r = driveBrowse({ p, mode: 'save', kind, title, name, text, workId });
  if (driveUi) driveUi.busyText = busyText;
  return r;
}

function pickDriveFile(p, title, kind = 'json') {
  return driveBrowse({ p, mode: 'open', kind, title });
}

/**
 * 保存先を選んで保存する（クラウド／この端末・その他）。設定の「ファイル」タブに従う。
 * title：クラウドの画面の見出し（「（全体：すべての作品）」など。前に「○○に保存」を付ける）
 * 戻り値: { type: 'cloud', label, id, name }／{ type: 'local', handle, how, name }／null（やめた）
 */
async function saveTextTo(text, name, { title, force = false, workId = '', kind = 'json', busyText = '保存中…' } = {}) {
  const dest = await chooseDestination('save', { force });
  let where = dest;
  if (dest === 'cloud') {
    const r = await openDriveSave({ p: driveProvider(), title, name, text, workId, kind, busyText });
    if (r !== 'local') return r;
    where = 'local';
  }
  if (where !== 'local') return null;
  // iPhone・iPad では共有メニューが出るので、「"ファイル"に保存」を選んでもらう
  if (localFile.saveMethod === 'share') toast('共有メニューが開きます。「"ファイル"に保存」を選ぶと、保存先（iCloud Drive・OneDrive など）を選べます');
  // 保存先を選んだあと、実際に書き込む間だけ処理中の文言を出す
  const r = await localFile.saveAs(text, name, FILE_KINDS[kind].types, FILE_KINDS[kind].mime, (write) => withBusy(busyText, write));
  if (!r) return null;
  prefs.set('file.lastDestination', 'local');
  return typeof r === 'string' ? { type: 'local', handle: null, how: r, name } : { type: 'local', handle: r, how: 'picker', name: r.name };
}

// 保存が終わったときの知らせ。head：完了の文言（「保存が完了しました」「バックアップを作成しました」）
// ダウンロード・共有メニューは、ブラウザーの外で保存されるため「完了」とは言わず、確かめ方を伝える
function savedMessage(r, what, head = '保存が完了しました') {
  if (r.type === 'cloud') return `${head}\n${what}：${r.label} の「${r.name}」`;
  if (r.how === 'downloaded') return `${what}をダウンロードとして書き出しました（「ダウンロード」フォルダを確かめてください）`;
  if (r.how === 'shared') return `${what}を共有メニューに渡しました（選んだ保存先に保存されたか確かめてください）`;
  return `${head}\n${what}：「${r.name}」`;
}

/**
 * 保存先を選んで開く（「どこから開きますか？」。設定の「ファイル」タブに従う）。kind: 'json'／'txt'
 * 戻り値: { text, name, source: 'cloud'|'local', id?, handle?, file? }／null
 */
async function openFrom(title, { force = false, kind = 'json' } = {}) {
  const dest = await chooseDestination('open', { force });
  let where = dest;
  if (dest === 'cloud') {
    const p = driveProvider();
    const f = await pickDriveFile(p, title, kind);
    // クラウドの画面の「開く」で、読み込みが済んでから画面を閉じている（f.text）
    if (f && f !== 'local') return { text: f.text ?? await withBusy('ファイルを読み込み中…', () => p.load(f.id)), name: f.name, source: 'cloud', id: f.id };
    if (f !== 'local') return null;
    where = 'local'; // 「この端末・その他から開く」を選び直した
  }
  if (where !== 'local') return null;
  const r = await localFile.open(kind, (file) => withBusy('ファイルを読み込み中…', () => file.text()));
  return r ? { ...r, source: 'local' } : null;
}

// ---------- 全体（すべての作品・ひな型・設定を1ファイルに） ----------
// 「ファイル」は、明示的に好きな場所・名前で保存する／開くときだけに使う（上書き保存は「保存」ボタン＝自動バックアップ）

async function allSaveAs({ force = false } = {}) {
  await flush();
  const { text, count } = await makeBackup();
  const r = await saveTextTo(text, backupFileName(), { title: `${cloudName()}に保存（全体：すべての作品）`, force });
  if (!r) return;
  prefs.set('lastBackupAt', new Date().toISOString());
  toast(savedMessage(r, `全体（${count}作品・ひな型・設定）`));
}

// 全体のファイルのほか、以前の版で保存した「作品1つ」の .json も開ける（作品として取り込む）
async function allOpen({ force = false } = {}) {
  const src = await openFrom('全体を開く（すべての作品）', { force });
  if (!src) return;
  if (isEpisodeFile(src.text)) { toast('エピソードのファイルです。「ファイル」→ エピソードの「開く」で開いてください', true); return; }
  if (isBackup(src.text)) {
    openRestoreDialog(src.text, src.name);
    return;
  }
  await withBusy('読み込み中…', async () => switchTo(await importContent(parse(src.text, src.name))));
  returnToEditor();
  toast(`読み込みが完了しました\n「${src.name}」を作品として開きました`);
}

// ---------- 選択式バックアップパック ----------

let inspectedBackup = null; // { pack, name, acknowledge }。acknowledge は選択時点で一覧にあった最新バックアップ

function episodeDisplayName(p, ep, i) {
  return `${i + 1}. ${episodeName(ep, p.site)}（${countChars(draftOf(ep, p.site).body).all.toLocaleString()}字・${fmtTime(ep.updatedAt)}）`;
}

async function renderPackEpisodes(projectId) {
  const p = (await allProjects()).find((x) => x.id === projectId);
  const box = $('backup-pack-episodes');
  box.replaceChildren();
  if (!p) return;
  p.episodes.forEach((ep, i) => {
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', value: ep.id, checked: false });
    const label = document.createElement('label');
    label.append(input, document.createTextNode(episodeDisplayName(p, ep, i)));
    box.append(label);
  });
}

const PACK_SCOPE_HINT = {
  all: 'すべての作品を、稿・履歴とあわせて保存します。',
  project: '選んだ作品を丸ごと（作品資料・全エピソード・稿・履歴）保存します。',
  materials: 'あらすじ・全体プロット・章・世界観／用語・登場人物・メモを保存します（エピソードは含みません）。',
  episodes: '選んだエピソード（複数可）を、両サイトの全稿・プロット・フリーメモ・活動報告とあわせて保存します。',
};

let packFormProjects = [];
function updatePackForm() {
  const form = $('backup-pack-form');
  const scope = form.elements.scope.value;
  const includeNovel = form.elements.includeNovel.checked;
  const env = form.elements.environment.checked;
  // 「小説を含める」を外したら、範囲の選択は見た目でも押せなくする（選んでいた範囲は残しておき、付け直すと元に戻る）
  $('backup-pack-novel-data').disabled = !includeNovel;
  $('backup-pack-project-row').hidden = scope === 'all';
  $('backup-pack-custom').hidden = scope !== 'episodes';
  $('backup-pack-scope-hint').textContent = PACK_SCOPE_HINT[scope] || '';
  const checked = [...$('backup-pack-episodes').querySelectorAll('input:checked')].map((x) => x.value);
  const hasNovel = includeNovel && (scope !== 'episodes' || checked.length > 0);
  const has = env || hasNovel;
  $('backup-pack-save').disabled = !has;
  $('backup-pack-validation').textContent = has ? ''
    : !env && !includeNovel ? '「環境設定を含める」「小説を含める」のどちらかを選んでください。' : '保存するエピソードを一つ以上選んでください。';
  // ファイル名の見本（実際の名前は、作成した時刻で決まる）
  const p = packFormProjects.find((x) => x.id === form.elements.project.value);
  const items = !hasNovel ? [] : scope === 'all' ? packFormProjects.map((x) => ({ type: 'project', project: x }))
    : !p ? [] : scope === 'project' ? [{ type: 'project', project: p }]
      : scope === 'materials' ? [{ type: 'materials', project: p }]
        : p.episodes.map((ep, order) => ({ type: 'episode', project: p, order, episode: ep })).filter((x) => checked.includes(x.episode.id));
  $('backup-pack-name').textContent = has
    ? packFileName({ environment: env ? { prefs: { x: 1 } } : null, items, meta: { scope: items.length ? scope : null }, reason: 'manual-pack', createdAt: new Date().toISOString() })
    : '—';
}

async function openBackupPackCreate() {
  await flush();
  const form = $('backup-pack-form');
  const projects = await allProjects();
  packFormProjects = projects;
  form.elements.project.replaceChildren(...projects.map((p) => new Option(p.title || '無題', p.id)));
  form.elements.project.value = project.id;
  form.elements.scope.value = 'project';
  form.elements.environment.checked = false;
  form.elements.includeNovel.checked = true;
  form.elements.autoTargets.checked = true;
  setTaskError($('backup-pack-dialog'), '');
  await renderPackEpisodes(project.id);
  updatePackForm();
  $('backup-pack-dialog').showModal();
}

// 「次へ」：保存先を選んで保存する。保存が終わるまで画面は閉じない（失敗したら、画面の中で知らせてやり直せる）
async function createBackupPack(btn = $('backup-pack-save')) {
  const form = $('backup-pack-form');
  const dialog = $('backup-pack-dialog');
  const saved = await runTask('backup', async () => {
    for (const site of SITE_KEYS) {
      const state = await ensureEdition(episode(), site);
      await storeEdition(episode(), site, state.cur);
    }
    await flush();
    const scope = form.elements.includeNovel.checked ? form.elements.scope.value : 'none';
    const plan = {
      environment: form.elements.environment.checked,
      scope,
      projectId: form.elements.project.value,
      episodeIds: scope === 'episodes' ? [...$('backup-pack-episodes').querySelectorAll('input:checked')].map((x) => x.value) : [],
      reason: 'manual-pack', appVersion: APP_VERSION,
      device: { prefix: sync.prefix(), id: sync.deviceId() },
    };
    const made = await makePack(plan);
    const selectedProject = (await allProjects()).find((p) => p.id === plan.projectId);
    const r = await saveTextTo(made.text, packFileName(made.pack), { title: `${cloudName()}に保存（バックアップ）`, force: true, busyText: 'バックアップ作成中…' });
    if (!r) return false; // 保存先を選ぶ画面を閉じた（やめた）
    if (scope === 'episodes' && form.elements.autoTargets.checked) {
      prefs.set('sync.episodeTargets', plan.episodeIds.length ? [{ workId: selectedProject?.workId || project.workId, episodeIds: plan.episodeIds }] : []);
    }
    return { r, made };
  }, { button: btn, dialog, busy: false, done: ({ r, made }) => savedMessage(r, `バックアップ（${made.itemCount}項目${made.pack.environment ? '・環境設定' : ''}）`, 'バックアップを作成しました') });
  return saved;
}
function itemDetail(item) {
  if (item.type === 'project') {
    const p = normalize(item.project);
    return [`作品全体：${p.title || '無題'}`, `エピソード：${p.episodes.length}話`, `本文：${totalChars(p).toLocaleString()}字`, `稿・履歴：${(item.versions || []).length}件`, `更新：${fmtTime(p.updatedAt)}`].join('\n');
  }
  if (item.type === 'materials') {
    const d = item.data || {};
    return [`作品資料：${item.project?.title || '無題'}`, `あらすじ：${d.synopsis ? 'あり' : 'なし'}`, `全体プロット：${(d.chapters || []).length}章`, `世界観・用語：${d.world?.items?.length || 0}件`, `登場人物：${d.characters?.items?.length || 0}人`, `メモ：${d.projectMemo ? 'あり' : 'なし'}`].join('\n');
  }
  const ep = item.episode || {};
  const sites = ['narou', 'alpha'].map((site) => {
    const list = (item.versions || []).filter((v) => v.site === site);
    const d = draftOf(ep, site);
    return `${SITES[site].short}：${list.length}稿・本文 ${countChars(d.body).all.toLocaleString()}字`;
  });
  const preview = draftOf(ep, project?.site || 'narou').body.slice(0, 800);
  return [`エピソード：${episodeName(ep)}`, `作品：${item.project?.title || '無題'}`, `所属章：${item.chapter?.title || '未分類'}`, ...sites,
    `プロット：${ep.plot ? 'あり' : 'なし'}／フリーメモ：${ep.freeMemo ? 'あり' : 'なし'}／活動報告：${ep.report && Object.values(ep.report).some(Boolean) ? 'あり' : 'なし'}`,
    '', '本文の冒頭', preview || '（本文なし）'].join('\n');
}

function renderBackupInspection(pack, name = '', { acknowledge = null } = {}) {
  inspectedBackup = { pack, name, acknowledge };
  const s = packSummary(pack);
  const reason = { 'manual-pack': '手動バックアップパック', 'manual-episode': '上段の保存', 'auto-episode': 'サーバへの自動バックアップ', 'legacy-full': '旧形式の全体バックアップ' }[pack.reason] || pack.reason || '不明';
  const d = describePack(pack);
  $('backup-inspect-summary').textContent = `${name ? `ファイル：${name}\n` : ''}作成日時：${fmtTime(pack.createdAt)}\n作成方法：${reason}（${d.kind}）\n端末：${d.device}\n`
    + `環境：${d.environment}${pack.environment?.clientIdIncluded ? '（OAuth Client IDを含む）' : ''}・小説：${d.novel}・範囲：${d.scope}・作品：${d.project}・話：${d.episode}\n内容：${s.environment ? '環境設定・' : ''}${s.projects.length}作品・${s.episodes}選択エピソード`;
  $('backup-inspect-warning').textContent = pack.legacy ? '旧形式のバックアップです。内容を確認してから読み込んでください。' : '';
  const tree = $('backup-inspect-tree');
  tree.replaceChildren();
  const add = (key, label, detail, checked = true) => {
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', value: key, checked });
    const row = document.createElement('label');
    row.append(input, document.createTextNode(label));
    row.addEventListener('click', () => { $('backup-inspect-detail').textContent = detail; });
    tree.append(row);
  };
  if (pack.environment) add('environment', '環境設定', environmentSummary(pack.environment).join('\n') || '環境設定');
  for (const item of pack.items || []) {
    const label = item.type === 'project' ? `作品全体：${item.project?.title || '無題'}`
      : item.type === 'materials' ? `作品資料：${item.project?.title || '無題'}`
        : `エピソード：${item.project?.title || '無題'}／${episodeName(item.episode)}`;
    add(item.key, label, itemDetail(item), item.type !== 'episode');
  }
  $('backup-inspect-detail').textContent = '左の項目を押すと詳細を表示します。チェックした項目だけを読み込めます。';
  $('backup-inspect-dialog').showModal();
}

async function inspectBackupText(text, name = '', options = {}) {
  try { renderBackupInspection(parseAnyBackup(text), name, options); }
  catch (e) { await inform(`バックアップを確認できませんでした。\n${e.message}`); }
}

async function openBackupPackFile() {
  const src = await openFrom('バックアップパックを確認・読み込む', { force: true });
  if (src) await inspectBackupText(src.text, src.name);
}

// バックアップを読み込む前の備え（読み込みで変わる作品だけ）：
//   ・書きかけの原稿を今の稿にしまう（読み込んだあとも、この端末の稿として残るように）
//   ・作品ごとに復元ポイント「バックアップ読み込み前（自動）」を作る（自動では消えない）
//   ・端末全体の状態を「同期の前の状態」として残す（設定 → バックアップ の「同期の前の状態を書き出す」）
async function protectBeforeRestore(pack, selected, name = '') {
  const keys = new Set(selected);
  const workIds = new Set((pack.items || []).filter((it) => keys.has(it.key))
    .map((it) => (it.type === 'project' ? it.project?.workId : it.project?.workId)).filter(Boolean));
  if (!workIds.size) return;
  const now = new Date();
  for (const p of await allProjects()) {
    if (!workIds.has(p.workId)) continue;
    const all = await versions.list(p.id);
    for (const ep of p.episodes) {
      for (const site of SITE_KEYS) {
        const v = all.find((x) => x.id === ep.editionIds?.[site]);
        if (!v) continue;
        const data = editionData(draftOf(ep, site));
        if (JSON.stringify(editionData(v.data)) === JSON.stringify(data)) continue;
        await versions.put({ ...v, data, chars: countChars(data.body).all, updatedAt: ep.siteUpdatedAt?.[site] || now.toISOString() });
      }
    }
    await versions.put({
      id: newVersionId(), kind: 'project', projectId: p.id,
      name: 'バックアップ読み込み前（自動）',
      memo: `${now.toLocaleString('ja-JP')} に${name ? `「${name}」を` : 'バックアップを'}読み込む前の状態`,
      auto: false, createdAt: now.toISOString(), chars: totalChars(p), episodes: p.episodes.length,
      data: JSON.parse(serialize(p)).project,
    });
  }
  const before = await makeBackup();
  await meta.set('preSyncBackup', { createdAt: now.toISOString(), from: name, text: before.text });
}

async function restoreInspected(asNew = false, btn = null) {
  if (!inspectedBackup) return;
  const selected = [...$('backup-inspect-tree').querySelectorAll('input:checked')].map((x) => x.value);
  if (!selected.length) { setTaskError($('backup-inspect-dialog'), '⚠ 読み込む内容を、左の一覧で一つ以上選んでください。'); return; }
  const verb = asNew ? '既存の作品を変更せず、新しい作品として読み込みますか？'
    : '選択した内容をこの端末へ読み込みますか？同じ作品・エピソードは、バックアップの内容になります。\n'
      + '読み込む前の状態は、それぞれの作品の「変更履歴と復元ポイント」に「バックアップ読み込み前（自動）」として残します。この端末にしかない稿は消えません。';
  if (!(await ask(verb, { ok: '読み込む' }))) return;
  // 復元が済んでから画面を閉じる。失敗したら画面は開いたまま、理由を出す
  const result = await runTask('restore', async () => {
    await flush();
    if (!asNew) await protectBeforeRestore(inspectedBackup.pack, selected, inspectedBackup.name);
    const restored = await restorePack(inspectedBackup.pack, { selected, asNew, environmentMode: 'merge' });
    if (inspectedBackup.name && sync.parseName(inspectedBackup.name)) sync.markLoaded(inspectedBackup.name);
    // 過去版を意図して選んだ場合、その時点ですでに一覧にあった新しい版は確認済みとする。
    // これ以降に作成されたバックアップだけを、次回から「他の端末の更新」として通知する。
    if (inspectedBackup.acknowledge) sync.markChecked(inspectedBackup.acknowledge);
    syncPending = null;
    const open = restored.updatedList[0] || restored.addedList[0];
    if (open) {
      const p = await db.get(open.id);
      if (p) showProject(p);
    }
    return restored;
  }, {
    button: btn || $('backup-restore'), dialog: $('backup-inspect-dialog'),
    done: (r) => `復元が完了しました（追加${r.addedList.length}・更新${r.updatedList.length}${selected.includes('environment') ? '・環境設定' : ''}）`,
  });
  if (!result) return;
  returnToEditor();
  const follow = environmentFollowUp(result.environmentResult);
  if (follow) {
    await inform(`環境設定を読み込みました。${follow}`);
    // 使うクラウド・クライアントIDが変わったときは、つなぎ直すために画面を読み直す
    if (result.environmentResult.providerChanged || result.environmentResult.idsChanged) location.reload();
  }
}

// ---------- エピソード専用ファイル（今開いているエピソード） ----------

async function epSaveAs({ force = false } = {}) {
  await flush();
  const ep = episode();
  const label = mainDraft(ep).title || `第${epIndex + 1}話`;
  const r = await saveTextTo(makeEpisodeFile(ep, project.title), fileName(`${project.title || '無題'}_${label}`, '.json'), { title: `${cloudName()}に保存（このエピソード）`, force });
  if (r) toast(savedMessage(r, `エピソード「${label}」`));
}

async function epOpen({ force = false } = {}) {
  const src = await openFrom('エピソードを開く', { force });
  if (!src) return;
  if (!isEpisodeFile(src.text)) {
    toast(isBackup(src.text) ? '全体のバックアップです。「設定」→「バックアップ」→「バックアップファイルの管理」から読み込んでください' : 'エピソードのファイルではありません', true);
    return;
  }
  const data = parseEpisodeFile(src.text);
  const ep = episode();
  const name = mainDraft(ep).title || `第${epIndex + 1}話`;
  if (!(await ask(`今のエピソード「${name}」を、「${src.name}」の内容で上書きしますか？\n（なろう用・アルファ用の原稿、プロット、フリーメモが入れ替わります。上書き前の原稿は、両サイトとも前の番号の稿に残ります）`, { ok: '上書きする' }))) return;
  await withBusy('読み込み中…', async () => {
    // 開く前の原稿は前の番号の稿に残し、両サイトとも新しい稿に開く
    for (const site of SITE_KEYS) await raiseEdition(ep, site);
    applyEpisodeSnapshot(ep, data.episode);
    touchEpisode(ep);
    changed();
    showEpisode();
    renderEpisodeList();
  });
  returnToEditor();
  toast(`読み込みが完了しました\n「${src.name}」を今のエピソードに開きました`);
}

// ---------- インポート・エクスポート（プレーンテキスト） ----------

// プレーンテキスト → 今のエピソードの本文（開いている側の原稿）
async function importText() {
  const src = await openFrom('プレーンテキストを開く', { kind: 'txt' });
  if (!src) return;
  const text = src.file
    ? await withBusy('ファイルを読み込み中…', async () => decodeText(await src.file.arrayBuffer()).text)
    : src.text;
  const body = text.replace(/\r\n?/g, '\n');
  const d = cur();
  if (d.body && !(await ask(`今のエピソードの本文（${SITES[editSite].short}用）を、「${src.name}」の内容で上書きしますか？\n（上書き前の内容は、前の番号の稿に残します）`, { ok: '上書きする' }))) return;
  await withBusy('読み込み中…', async () => {
    if (d.body) await raiseEdition(episode(), editSite); // 読み込む前の内容は前の番号の稿に残る
    d.body = body;
    episode().siteUpdatedAt = { ...(episode().siteUpdatedAt || {}), [editSite]: new Date().toISOString() };
    touchEpisode();
    changed();
    showEpisode();
    renderEpisodeList();
  });
  returnToEditor();
  toast(`読み込みが完了しました\n「${src.name}」を本文（${SITES[editSite].short}用）に読み込みました（${countChars(body).all.toLocaleString()}字）`);
}

// 書き出しは、いま編集している側（なろう用／アルファ用）の原稿
async function exportEpisode() {
  const d = cur();
  if (!d.body) { toast('本文は空です'); return; }
  const name = fileName(`${project.title || '無題'}_${d.title || epIndex + 1}`, '.txt');
  const r = await saveTextTo(convert(editSite, d.body), name, { title: `${cloudName()}に保存（このエピソードのテキスト）`, kind: 'txt' });
  if (r) toast(savedMessage(r, `「${d.title || '（無題）'}」のテキスト（${SITES[editSite].short}用）`));
}

async function exportAll() {
  const text = project.episodes
    .map((e) => draftOf(e, editSite))
    .map((d) => `${d.title}\n\n${convert(editSite, d.body)}`)
    .join('\n\n――――――――――\n\n');
  const head = project.title ? project.title + '\n\n' : '';
  const r = await saveTextTo(head + text, fileName(`${project.title || '無題'}_${SITES[editSite].short}`, '.txt'), { title: `${cloudName()}に保存（全エピソードのテキスト）`, kind: 'txt' });
  if (r) toast(savedMessage(r, `全${project.episodes.length}話のテキスト（${SITES[editSite].short}用）`));
}

// ---------- メイン → サブのコピー（明示的に押したときだけ。自動では同期しない） ----------

const COPY_FIELDS = [['title', 'タイトル'], ['body', '本文'], ['foreword', '前書き'], ['afterword', '後書き']];
// コピー先がその欄を持てるか（アルファポリスには前書き・後書きの欄を出していない）
const siteSupports = (site, f) => site === 'narou' || f === 'title' || f === 'body';

function mergeWarnings(into, list) {
  for (const w of list) {
    const x = into.find((y) => y.type === w.type);
    if (x) { x.count += w.count; x.samples.push(...w.samples.slice(0, Math.max(0, 3 - x.samples.length))); } else into.push({ ...w, samples: [...w.samples] });
  }
}

// メイン（の今の稿）→ サブへのコピー。対象は開いているエピソードだけ。
// mode：'new' サブ側に新しい稿を作ってコピー（今の稿は残る）／'overwrite' サブ側の今の稿に上書き
function buildCopyPlan() {
  const form = $('site-copy-form');
  const from = project.site;
  const to = subSite();
  const mode = form.elements.mode.value === 'overwrite' ? 'overwrite' : 'new';
  const fields = COPY_FIELDS.map(([f]) => f).filter((f) => form.elements['f-' + f]?.checked && siteSupports(to, f));
  const eps = [episode()];
  const changes = [];
  const warnings = [];
  for (const ep of eps) {
    for (const f of fields) {
      const src = draftOf(ep, from)[f];
      if (!src) continue; // 空でコピー先を消さない
      const conv = convertText(from, to, src);
      mergeWarnings(warnings, conv.warnings);
      const before = draftOf(ep, to)[f];
      if (conv.text !== before) changes.push({ ep, f, text: conv.text, before });
    }
  }
  return { from, to, mode, fields, eps, changes, warnings };
}

async function openSiteCopy() {
  const from = project.site;
  const to = subSite();
  const ep = episode();
  const [src, dest] = [await ensureEdition(ep, from), await ensureEdition(ep, to)];
  const next = `第${nextEditionNo(dest.list)}稿`;
  $('site-copy-title').textContent = `${SITES[from].short}（メイン）の${src.cur.name} → ${SITES[to].short}（サブ）にコピー`;
  $('site-copy-desc').textContent = `「${episodeName(ep)}」の、メインの今の稿（${src.cur.name}）を${SITES[to].label}の書き方に変換して、サブ側へ写します。メイン側は変わりません。`;
  $('site-copy-mode-new').textContent = `新しい稿（${SITES[to].short}用の${next}）として追加（おすすめ。今の${dest.cur.name}はそのまま残ります）`;
  $('site-copy-mode-over').textContent = `${SITES[to].short}用の今の稿（${dest.cur.name}）に上書き`;
  $('site-copy-form').dataset.overName = dest.cur.name;
  const box = $('site-copy-fields');
  box.querySelectorAll('label').forEach((n) => n.remove());
  for (const [f, label] of COPY_FIELDS) {
    const ok = siteSupports(to, f);
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'f-' + f, checked: ok, disabled: !ok });
    const l = document.createElement('label');
    l.append(input, ` ${label}${ok ? '' : '（コピー先に欄がないため対象外）'}`);
    box.append(l);
  }
  $('site-copy-form').elements.mode.value = 'new';
  updateSiteCopy();
  $('site-copy-dialog').showModal();
}

function updateSiteCopy() {
  const plan = buildCopyPlan();
  const label = Object.fromEntries(COPY_FIELDS);
  // 上書きになるもの（「今の稿に上書き」のときだけ）
  const over = plan.mode === 'overwrite' ? plan.changes.filter((c) => c.before) : [];
  const ow = $('site-copy-overwrite');
  ow.hidden = !over.length;
  if (over.length) {
    const ul = document.createElement('ul');
    for (const c of over) {
      ul.append(Object.assign(document.createElement('li'), {
        textContent: `${label[c.f]}　今 ${countChars(c.before).all.toLocaleString()}字 → ${countChars(c.text).all.toLocaleString()}字`,
      }));
    }
    ow.replaceChildren(Object.assign(document.createElement('strong'), { textContent: `⚠ ${SITES[plan.to].short}用の今の稿（${$('site-copy-form').dataset.overName || ''}）の内容が上書きされます（${over.length}件。元に戻せません）` }), ul);
  }
  // 変換の警告
  const wb = $('site-copy-warnings');
  wb.hidden = !plan.warnings.length;
  if (plan.warnings.length) {
    const ul = document.createElement('ul');
    for (const w of plan.warnings) {
      const item = Object.assign(document.createElement('li'), { textContent: `${w.message}（${w.count}か所）` });
      if (w.samples.length) item.append(Object.assign(document.createElement('div'), { className: 'samples', textContent: '例：' + w.samples.join('　/　') }));
      ul.append(item);
    }
    wb.replaceChildren(Object.assign(document.createElement('strong'), { textContent: '変換についての注意' }), ul);
  }
  // プレビュー（開いているエピソードの本文。なければ最初の変更）
  const body = plan.changes.find((c) => c.f === 'body' && c.ep === episode()) || plan.changes.find((c) => c.f === 'body');
  $('site-copy-preview').value = body ? body.text : '（本文の変更はありません）';
  const ok = $('site-copy-ok');
  ok.disabled = !plan.changes.length;
  ok.textContent = !plan.changes.length ? 'コピーする内容がありません'
    : over.length ? `上書きしてコピー（${plan.changes.length}件）`
      : plan.mode === 'new' ? `新しい稿にコピー（${plan.changes.length}件）` : `コピーする（${plan.changes.length}件）`;
  ok.classList.toggle('danger-solid', !!over.length);
  ok.classList.toggle('primary', !over.length);
}

async function runSiteCopy() {
  const plan = buildCopyPlan();
  if (!plan.changes.length) return;
  const ep = plan.eps[0];
  const toName = SITES[plan.to].short;
  const over = plan.mode === 'overwrite' ? plan.changes.filter((c) => c.before) : [];
  const { cur: dest } = await ensureEdition(ep, plan.to);
  if (over.length && !(await ask(`${toName}用の今の稿（${dest.name}）の内容を、メインからのコピーで上書きします。\n上書きした内容は元に戻せません（残したいときは「新しい稿として追加」を選んでください）。よろしいですか？`, { ok: '上書きする', danger: true }))) return;
  // 新しい稿として追加：サブ側の今の稿はそのまま残し、次の番号の稿にコピーする
  let target = dest;
  if (plan.mode === 'new') target = (await raiseEdition(ep, plan.to)).to;
  for (const c of plan.changes) c.ep.drafts[plan.to][c.f] = c.text;
  ep.siteUpdatedAt = { ...(ep.siteUpdatedAt || {}), [plan.to]: new Date().toISOString() };
  touchEpisode(ep);
  changed();
  editSite = plan.to;
  applySite();
  showEpisode();
  renderEpisodeList();
  toast(plan.mode === 'new'
    ? `${toName}用の新しい稿（${target.name}）にコピーしました（${dest.name}はそのまま残っています）`
    : `${toName}用の今の稿（${dest.name}）に上書きしてコピーしました`);
}

// ---------- 稿と版 ----------
// どちらも versions ストアに入れ、kind で分ける。
//   エピソードの稿（kind: 'episode'、site: 'narou'|'alpha'）… なろう用・アルファ用で別々に持つ、エピソードの原稿の稿
//   以前の版（kind: 'episode-legacy'）… 6.0 より前の「両サイトの原稿＋プロット・フリーメモ」をまとめた版。稿に分けた元として残す
//   作品全体のバックアップ版（kind なし／'project'）… 設定の「バックアップ」タブ。自動でも残る

const newVersionId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const isEpisodeVersion = (v) => v.kind === 'episode' || v.kind === 'episode-legacy';

// エピソードファイルの中身（両サイトの原稿・プロット・フリーメモ）をエピソードへ入れる（旧形式 { title, foreword, body, afterword, plot } にも対応）
function applyEpisodeSnapshot(ep, data, site = project.site) {
  if (data.drafts) {
    ep.drafts = { ...ep.drafts, ...structuredClone(data.drafts) };
  } else {
    ep.drafts[site] = { title: data.title ?? '', foreword: data.foreword ?? '', body: data.body ?? '', afterword: data.afterword ?? '' };
  }
  ep.plot = data.plot ?? ep.plot;
  if ('freeMemo' in data) ep.freeMemo = data.freeMemo;
}

// --- エピソードの稿（なろう用・アルファ用で別々） ---
// 稿に入るのは、そのサイトの原稿（タイトル・前書き・本文・後書き）だけ。プロット・フリーメモはエピソードに1つ（全稿・両サイト共通）。
// 編集している内容は、サイトごとに、いつもどれか1つの稿（ep.editionIds[site]）。書いた内容はその稿のもの。
// 別の稿を選ぶと、今の稿に今の内容をしまってから、選んだ稿の内容を出す（何も消えない）。もう一方のサイトは変わらない。
// 「稿を上げる」は、今の稿をしまって、同じ内容で次の番号の稿（第N+1稿）を作り、それを編集する。

const EDITION_FIELDS = ['title', 'foreword', 'body', 'afterword'];

function editionData(src) {
  return Object.fromEntries(EDITION_FIELDS.map((f) => [f, String(src?.[f] ?? '')]));
}

function editionSnapshot(ep, site) {
  return editionData(draftOf(ep, site));
}

function applyEdition(ep, site, data) {
  ep.drafts[site] = { ...format.emptyDraft(), ...editionData(data) };
}

// エピソードの稿・以前の版すべて（両サイト）
async function allEpisodeVersions(episodeId) {
  return (await versions.list(project.id)).filter((v) => isEpisodeVersion(v) && v.episodeId === episodeId);
}

async function saveEdition(ep, site, name, data = editionSnapshot(ep, site)) {
  const now = new Date().toISOString();
  const v = {
    id: newVersionId(), kind: 'episode', site, projectId: project.id, episodeId: ep.id,
    name, memo: '', createdAt: now, updatedAt: now, chars: countChars(data.body).all, data: editionData(data),
  };
  await versions.put(v);
  return v;
}

// 稿の割り当てだけを変えたとき：作品の更新日時は変えずに端末へ保存する
function quietSave() {
  dirty = true;
  scheduleFlush();
}

// 6.0 より前の版（両サイトの原稿＋プロット・フリーメモを1つに持つ）を、サイト別の稿に分ける。
// 元の版は 'episode-legacy' として残す（消さない）。編集していた版（ep.versionId）は、両サイトの今の稿になる。
const migratingEditions = new Map();
function migrateLegacyEditions(ep) {
  if (!migratingEditions.has(ep.id)) {
    migratingEditions.set(ep.id, (async () => {
      const legacy = (await allEpisodeVersions(ep.id)).filter((v) => v.kind === 'episode' && !v.site);
      if (!legacy.length) {
        if (ep.versionId) { delete ep.versionId; quietSave(); }
        return;
      }
      const made = new Map();
      for (const v of legacy) {
        const name = String(v.name || '').replace(/^第(\d+)版$/, '第$1稿');
        const ids = {};
        for (const site of SITE_KEYS) {
          // 両サイトの原稿を持つ版と、さらに古い1サイトだけの版（メイン投稿サイトの原稿）
          const src = v.data?.drafts ? v.data.drafts[site] : (site === project.site ? v.data : null);
          const data = editionData(src);
          const e = { ...v, id: newVersionId(), kind: 'episode', site, name, chars: countChars(data.body).all, data, legacyId: v.id };
          await versions.put(e);
          ids[site] = e.id;
        }
        made.set(v.id, ids);
        await versions.put({ ...v, kind: 'episode-legacy' });
      }
      if (ep.versionId && made.has(ep.versionId)) ep.editionIds = { ...made.get(ep.versionId), ...(ep.editionIds || {}) };
      delete ep.versionId;
      quietSave();
    })().finally(() => migratingEditions.delete(ep.id)));
  }
  return migratingEditions.get(ep.id);
}

const editionNo = (v) => Number(/^第(\d+)[稿版]$/.exec(v?.name || '')?.[1] || 0);
const versionTime = (v) => v.updatedAt || v.createdAt;
const nextEditionNo = (list) => Math.max(0, ...list.map(editionNo)) + 1;
// 番号の大きい順（番号のないものは新しい順で後ろ）
const sortEditions = (list) => [...list].sort((a, b) => editionNo(b) - editionNo(a) || String(versionTime(b)).localeCompare(String(versionTime(a))));

// そのサイトの稿の一覧と、今の稿。今の稿がなければ（以前の版で作ったエピソードなど）、今の内容を次の番号の稿にする
const ensuringEdition = new Map();
function ensureEdition(ep, site = editSite) {
  const key = ep.id + '|' + site;
  if (!ensuringEdition.has(key)) {
    ensuringEdition.set(key, (async () => {
      await migrateLegacyEditions(ep);
      const list = (await allEpisodeVersions(ep.id)).filter((v) => v.kind === 'episode' && v.site === site);
      let cur = list.find((v) => v.id === ep.editionIds?.[site]);
      if (!cur) {
        cur = await saveEdition(ep, site, `第${nextEditionNo(list)}稿`);
        list.unshift(cur);
        ep.editionIds = { ...(ep.editionIds || {}), [site]: cur.id };
        quietSave();
      }
      return { list, cur };
    })().finally(() => ensuringEdition.delete(key)));
  }
  return ensuringEdition.get(key);
}

// 今の稿に、今の内容をしまう
async function storeEdition(ep, site, cur) {
  const data = editionSnapshot(ep, site);
  if (JSON.stringify(editionData(cur.data)) === JSON.stringify(data)) return cur;
  const v = { ...cur, data, chars: countChars(data.body).all, updatedAt: ep.siteUpdatedAt?.[site] || new Date().toISOString() };
  await versions.put(v);
  return v;
}

// 稿を上げる（前の稿は今の内容のまま残り、同じ内容の新しい番号の稿を編集する）。もう一方のサイトは変えない
async function raiseEdition(ep = episode(), site = editSite) {
  await flush();
  const { list, cur } = await ensureEdition(ep, site);
  await storeEdition(ep, site, cur);
  const v = await saveEdition(ep, site, `第${nextEditionNo(list)}稿`);
  ep.editionIds = { ...(ep.editionIds || {}), [site]: v.id };
  changed();
  return { from: cur, to: v };
}

const versionLabel = (name, time, chars) => `${name}　${fmtTime(time)}　${Number(chars || 0).toLocaleString()}字`;
// 今の稿の時刻：その稿を最後に書いた時刻
const editionNowTime = (ep, site, v) => [ep.siteUpdatedAt?.[site], versionTime(v)].filter(Boolean).sort().pop();

// 稿の一覧（「第○稿　時刻　文字数」）。編集中のサイトの稿だけを出し、編集している稿を選んだ状態にする
let versionRenderSeq = 0;
async function renderEpisodeVersions() {
  const sel = $('ep-version');
  const ep = episode();
  const site = editSite;
  const seq = ++versionRenderSeq;
  const { list, cur } = await ensureEdition(ep, site);
  if (seq !== versionRenderSeq || ep !== episode() || site !== editSite) return; // あとから呼ばれた描画を優先する
  sel.replaceChildren(...sortEditions(list).map((v) => (v.id === cur.id
    ? new Option(versionLabel(v.name, editionNowTime(ep, site, v), countChars(draftOf(ep, site).body).all), v.id)
    : new Option(versionLabel(v.name, versionTime(v), v.chars), v.id))));
  sel.value = cur.id;
  sel.setAttribute('aria-label', `${SITES[site].short}用の稿`);
}

// 書いているあいだ、編集している稿の「時刻・文字数」を新しくする
let versionLabelTimer = null;
function refreshCurrentVersionLabel() {
  clearTimeout(versionLabelTimer);
  versionLabelTimer = setTimeout(() => {
    const ep = episode();
    const opt = $('ep-version').selectedOptions[0];
    if (!opt || opt.value !== ep.editionIds?.[editSite]) return;
    opt.textContent = versionLabel(opt.textContent.split('　')[0], ep.siteUpdatedAt?.[editSite] || ep.updatedAt, countChars(draftOf(ep, editSite).body).all);
  }, 1000);
}

// 一覧で稿を選んだら、今の稿に今の内容をしまってから、その稿の内容に切り替える（編集中のサイトだけ）
async function switchEpisodeVersion(id) {
  const ep = episode();
  const site = editSite;
  const { list, cur } = await ensureEdition(ep, site);
  const v = list.find((x) => x.id === id);
  if (!v || v.id === cur.id) return;
  await storeEdition(ep, site, cur);
  applyEdition(ep, site, v.data);
  ep.editionIds = { ...(ep.editionIds || {}), [site]: v.id };
  ep.siteUpdatedAt = { ...(ep.siteUpdatedAt || {}), [site]: versionTime(v) }; // その稿を最後に書いた時刻
  changed();
  showEpisode();
  renderEpisodeList();
  toast(`${SITES[site].short}用を ${v.name} に切り替えました（${cur.name}は残っています）`);
}

// 「この稿を削除」：編集中のサイトの、今表示している稿を削除する。もう一方のサイトの稿は変えない。
// 残っている稿があれば一番新しい稿を、なければ空の「第1稿」にし、共通のプロット・フリーメモも空にする
async function deleteEpisodeVersion() {
  const ep = episode();
  const site = editSite;
  const other = SITE_KEYS.find((s) => s !== site);
  const { list, cur } = await ensureEdition(ep, site);
  const rest = sortEditions(list.filter((v) => v.id !== cur.id));
  const chars = countChars(draftOf(ep, site).body).all;
  const after = rest.length
    ? `削除すると「${rest[0].name}」を表示します。`
    : `${SITES[site].short}用の稿はこれだけなので、削除すると空の「第1稿」になります（タイトル・前書き・本文・後書き・プロット・フリーメモが空になります）。`;
  if (!(await ask(`${SITES[site].label}用の「${cur.name}」（本文 ${chars.toLocaleString()}字）を削除しますか？\n${after}\n${SITES[other].short}用の稿は変わりません。削除した稿は元に戻せません。`, { ok: '削除する', danger: true }))) return;
  await versions.remove(cur.id);
  let next = rest[0];
  if (next) {
    applyEdition(ep, site, next.data);
  } else {
    applyEdition(ep, site, format.emptyDraft());
    ep.plot = '';
    ep.freeMemo = '';
    next = await saveEdition(ep, site, '第1稿');
  }
  ep.editionIds = { ...(ep.editionIds || {}), [site]: next.id };
  ep.siteUpdatedAt = { ...(ep.siteUpdatedAt || {}), [site]: versionTime(next) };
  changed();
  showEpisode();
  renderEpisodeList();
  toast(rest.length ? `「${cur.name}」を削除して、「${next.name}」を表示しました` : `「${cur.name}」を削除しました（${SITES[site].short}用は空の第1稿になりました）`);
}

async function episodeVersionUp() {
  const ep = episode();
  const site = editSite;
  const { from, to } = await raiseEdition(ep, site);
  await renderEpisodeVersions();
  toast(`${SITES[site].short}用を ${to.name}にしました（${from.name}は今の内容のまま残っています）`);
}

async function removeEpisodeVersions(episodeId) {
  for (const v of await allEpisodeVersions(episodeId)) await versions.remove(v.id);
}

// --- 作品全体のバックアップ版 ---

// 作品の中身だけを取り出したコピー（id・クラウド連携は含めない）
function snapshot() {
  return JSON.parse(serialize(project)).project;
}

async function projectVersions() {
  return (await versions.list(project.id)).filter((v) => !isEpisodeVersion(v));
}

async function saveVersion(name, memo = '', auto = false) {
  await flush();
  const v = {
    id: newVersionId(),
    kind: 'project',
    projectId: project.id,
    name,
    memo,
    auto,
    createdAt: new Date().toISOString(),
    chars: totalChars(project),
    episodes: project.episodes.length,
    data: snapshot(),
  };
  await versions.put(v);
  return v;
}

// 自動で残す：書いている間は10分ごと、画面を閉じる・切り替えるときにも
const AUTO_VERSION_MS = 10 * 60_000;
const DEFAULT_AUTO_VERSION_KEEP = 30;
function autoVersionKeep() {
  return Math.min(500, Math.max(1, Number(prefs.get('projectVersionKeep', DEFAULT_AUTO_VERSION_KEEP)) || DEFAULT_AUTO_VERSION_KEEP));
}

async function trimAutoVersions(projectId = project.id) {
  const autos = (await versions.list(projectId)).filter((v) => !isEpisodeVersion(v) && v.auto);
  for (const old of autos.slice(autoVersionKeep())) await versions.remove(old.id);
}
let autoDirty = false;
let lastAutoVersionAt = Date.now();

async function autoVersion(minInterval = AUTO_VERSION_MS) {
  if (!autoDirty || !project || Date.now() - lastAutoVersionAt < minInterval) return;
  autoDirty = false;
  lastAutoVersionAt = Date.now();
  const time = new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  await saveVersion(`自動保存 ${time}`, '', true);
  await trimAutoVersions();
}

async function openVersionSave() {
  const n = (await projectVersions()).filter((v) => !v.auto).length + 1;
  const form = $('version-save-form');
  form.name.value = `バックアップ${n}`;
  form.memo.value = '';
  $('version-save-dialog').showModal();
  form.name.select();
}

// 設定の「バックアップ」タブの一覧
async function renderProjectVersions() {
  const list = $('project-versions');
  list.replaceChildren();
  const all = await projectVersions();
  if (!all.length) { list.append(li('empty', 'まだありません')); return; }
  for (const v of all) {
    const meta = `${new Date(v.createdAt).toLocaleString('ja-JP')} ・ ${v.episodes}話 ・ ${v.chars.toLocaleString()}字${v.auto ? ' ・ 自動' : ''}`;
    list.append(listItem(v.name, meta, [
      button('開く', () => openVersion(v.id)),
      button('削除', () => deleteVersion(v).catch(fail), 'danger'),
    ]));
  }
}

// --- 版の確認画面（共通） ---

let currentVersion = null;
async function openVersion(id) {
  const v = await versions.get(id);
  if (!v) { toast('この変更履歴・復元ポイントは見つかりませんでした', true); return; }
  currentVersion = v;
  const ep = isEpisodeVersion(v) ? project.episodes.find((e) => e.id === v.episodeId) : null;
  $('version-title').textContent = v.name;
  $('version-copy').hidden = isEpisodeVersion(v);
  const info = $('version-info');
  info.replaceChildren();
  const row = (label, value, cls = '') => {
    info.append(Object.assign(document.createElement('dt'), { textContent: label }),
      Object.assign(document.createElement('dd'), { textContent: value, className: cls }));
  };
  const now = isEpisodeVersion(v) ? countChars(ep ? mainDraft(ep).body : '').all : totalChars(project);
  const diff = v.chars - now;
  row('保存日時', new Date(v.createdAt).toLocaleString('ja-JP'));
  if (isEpisodeVersion(v)) {
    row('エピソード', v.data.drafts ? format.episodeName(v.data, project.site) : (v.data.title || '（無題）'));
    row('本文', `${v.chars.toLocaleString()}字`);
  } else {
    row('小説タイトル', v.data.title || '（無題）');
    row('エピソード', `${v.episodes}話（今は${project.episodes.length}話）`);
    row('本文の合計', `${v.chars.toLocaleString()}字`);
  }
  row('今との差', diff === 0 ? '同じ' : `今より ${Math.abs(diff).toLocaleString()}字 ${diff > 0 ? '多い' : '少ない'}`, diff > 0 ? 'plus' : diff < 0 ? 'minus' : '');
  if (v.memo) row('メモ', v.memo);
  $('version-dialog').showModal();
}

async function restoreVersion(v) {
  // エピソードの稿は、その稿に切り替えるだけ（今の稿は今の内容のまま残る）
  if (isEpisodeVersion(v)) {
    const index = project.episodes.findIndex((e) => e.id === v.episodeId);
    if (index < 0) { toast('このエピソードは削除されています', true); return; }
    if (!v.site) { toast('以前の形式の版です（両サイトの稿に分けてあります）', true); return; }
    selectEpisode(index);
    if (v.site !== editSite) setEditSite(v.site);
    await switchEpisodeVersion(v.id);
    return;
  }
  if (!(await ask(`「${v.name}」の内容に戻しますか？\n今の内容は「${v.name}に戻す前」として自動で残ります。`))) return;
  await saveVersion(`${v.name}に戻す前`, `${new Date().toLocaleString('ja-JP')} に「${v.name}」へ戻す前の状態`);
  const restored = normalize({ ...v.data, id: project.id, links: project.links, createdAt: project.createdAt });
  restored.updatedAt = new Date().toISOString();
  await db.put(restored);
  showProject(restored, fileHandle);
  $('settings-dialog').close();
  toast(`作品全体を「${v.name}」に戻しました`);
}

async function copyVersion(v) {
  const p = normalize({ ...newProject(), ...v.data, title: `${v.data.title || '無題'}（${v.name}）` });
  p.updatedAt = new Date().toISOString();
  await switchTo(p);
  $('settings-dialog').close();
  toast(`「${v.name}」を別の作品として開きました（作品一覧から元の作品に戻れます）`);
}

async function deleteVersion(v) {
  if (!(await ask(`変更履歴・復元ポイント「${v.name}」を削除しますか？`))) return;
  if (!(await ask(`【最終確認】「${v.name}」を削除すると元に戻せません。削除しますか？`))) return;
  await versions.remove(v.id);
  toast(`変更履歴・復元ポイント「${v.name}」を削除しました`);
  if (isEpisodeVersion(v)) renderEpisodeVersions();
  else renderProjectVersions();
}

// ---------- 全体バックアップ・復元 ----------

const BACKUP_REMIND_DAYS = 7;

let pendingBackup = null;
let pendingBackupName = '';
let pendingBackupAcknowledge = null;
function openRestoreDialog(text, name = '', { acknowledge = null } = {}) {
  pendingBackup = parseBackup(text);
  pendingBackupName = name;
  pendingBackupAcknowledge = acknowledge;
  const when = pendingBackup.createdAt ? new Date(pendingBackup.createdAt).toLocaleString('ja-JP') : '不明';
  const titles = pendingBackup.projects.map((p) => p.title || '（無題）');
  $('restore-info').textContent =
    `${name ? `「${name}」\n` : ''}作成日時：${when}\n作品：${titles.length}件（${titles.slice(0, 5).join('、')}${titles.length > 5 ? ' ほか' : ''}）\nひな型・設定も戻します。`;
  $('restore-dialog').showModal();
}

async function runRestore(mode) {
  if (!pendingBackup) return;
  if (mode === 'replace' && !(await ask('【最終確認】この端末の作品をすべて消して、バックアップの内容に入れ替えます。よろしいですか？'))) return;
  const backup = pendingBackup;
  const loadedName = pendingBackupName;
  const acknowledge = pendingBackupAcknowledge;
  const before = await withBusy('復元中…', async () => {
    await flush();
    const current = new Set((await db.all()).map((p) => p.id));
    await restoreBackup(backup, mode);
    return current;
  });
  pendingBackup = null;
  pendingBackupName = '';
  pendingBackupAcknowledge = null;
  if (loadedName && sync.parseName(loadedName)) sync.markLoaded(loadedName);
  if (acknowledge) sync.markChecked(acknowledge);
  sync.markDirty(); // 戻した内容を、次の自動バックアップに入れる
  const items = (backup.projects || []).filter((p) => p?.id).map((p) => ({ id: p.id, title: p.title || '無題' }));
  if (mode === 'replace') {
    // 入れ替え：この端末の作品はすべてバックアップの内容になった
    reportAndReload(`この端末の作品をすべて、バックアップの内容（${items.length}作品）に入れ替えました。`, { updatedList: items.filter((x) => before.has(x.id)), addedList: items.filter((x) => !before.has(x.id)) });
  } else {
    reportAndReload(`バックアップの内容を、この端末の作品とまとめました（${items.length}作品）。`, { addedList: items.filter((x) => !before.has(x.id)), updatedList: items.filter((x) => before.has(x.id)) });
  }
}

async function remindBackup() {
  if (sync.getState() === 'on') return;
  const projects = await db.all();
  if (!projects.some((p) => !isEmptyProject(normalize(p)))) return;
  const last = prefs.get('lastBackupAt', null);
  const days = last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
  if (days === null || days >= BACKUP_REMIND_DAYS) {
    toast(days === null
      ? 'まだ全体のバックアップがありません。「設定」→「自動バックアップ」で保存先を選ぶか、「ファイル」→ 全体の「名前を付けて保存」で保存しておくと安心です'
      : `最後のバックアップから${days}日たっています。「ファイル」→ 全体の「名前を付けて保存」か、「設定」→「自動バックアップ」をおすすめします`);
  }
}

// ---------- 自動バックアップ（同期） ----------
// 仕組みは sync.js。ここは画面（状態の表示・起動時の確認・設定）。

let syncPending = null; // 「あとで」と答えた、他の端末の新しいバックアップ

// 自動バックアップの「クラウド」方式で使うサービス（「設定」→「クラウド」で選んだもの）
function syncProvider() {
  const p = activeProvider();
  return p?.backups ? p : null;
}

function savedSyncTargets() {
  const value = prefs.get('sync.episodeTargets', []);
  return Array.isArray(value) ? value : [];
}

function currentSyncTarget() {
  return [{ workId: project.workId, episodeIds: [episode().id] }];
}

async function buildEpisodeBackup(reason = 'auto-episode', targets = null) {
  // 表示中の稿は編集中の内容を稿ストアへ確定してからパックする。
  await flush();
  for (const site of SITE_KEYS) {
    const state = await ensureEdition(episode(), site);
    await storeEdition(episode(), site, state.cur);
  }
  await flush();
  const projects = await allProjects();
  const chosen = targets?.length ? targets : savedSyncTargets().length ? savedSyncTargets() : currentSyncTarget();
  // 作品資料（章・あらすじ・全体プロット・世界観・登場人物・メモ）は、前に送ったときから変わっていれば一緒に入れる
  const sent = prefs.get('sync.materialsSent', {}) || {};
  const nowSigs = {};
  const planTargets = chosen.map((t) => {
    const p = projects.find((x) => x.workId === t.workId || x.id === t.projectId);
    if (!p) return null;
    const sig = materialsSignature(p);
    const materials = sent[p.workId] !== sig && !(p.workId in nowSigs);
    if (materials) nowSigs[p.workId] = sig;
    return { projectId: p.id, episodeIds: t.episodeIds || [], materials };
  }).filter(Boolean);
  const made = await makePack({ scope: 'targets', targets: planTargets, reason, appVersion: APP_VERSION, device: { prefix: sync.prefix(), id: sync.deviceId() } });
  // 保存できたときだけ「送った」と記録する（失敗したら次の保存でもう一度入れる）
  made.afterSave = () => prefs.set('sync.materialsSent', { ...(prefs.get('sync.materialsSent', {}) || {}), ...nowSigs });
  // 共有フォルダに置くので、どの端末のものか分かるよう端末名を付ける（例：小説話_作品名_第3話@Win_20261030-073000.json）
  made.name = packFileName(made.pack, { device: sync.prefix() });
  // 知らせに出す名前：小説・作品名・第3話（作品資料も入れたときは「・作品資料」）
  const d = describePack(made.pack);
  made.label = ['小説', d.project, d.episode !== '—' ? d.episode : '', made.pack.items.some((x) => x.type === 'materials') ? '作品資料' : ''].filter(Boolean).join('・');
  return made;
}

async function openSyncTargets() {
  const chosen = new Map(savedSyncTargets().map((x) => [x.workId, new Set(x.episodeIds || [])]));
  const box = $('sync-target-list');
  box.replaceChildren();
  for (const p of await allProjects()) {
    box.append(Object.assign(document.createElement('div'), { className: 'target-project', textContent: p.title || '無題' }));
    p.episodes.forEach((ep, i) => {
      const input = Object.assign(document.createElement('input'), { type: 'checkbox', value: `${p.workId}|${ep.id}`, checked: chosen.get(p.workId)?.has(ep.id) || false });
      const label = document.createElement('label');
      label.append(input, document.createTextNode(episodeDisplayName(p, ep, i)));
      box.append(label);
    });
  }
  $('sync-target-dialog').showModal();
}

function saveSyncTargets() {
  const grouped = new Map();
  for (const input of $('sync-target-list').querySelectorAll('input:checked')) {
    const [workId, episodeId] = input.value.split('|');
    if (!grouped.has(workId)) grouped.set(workId, []);
    grouped.get(workId).push(episodeId);
  }
  prefs.set('sync.episodeTargets', [...grouped].map(([workId, episodeIds]) => ({ workId, episodeIds })));
  sync.markDirty();
  toast(`${[...grouped.values()].reduce((n, x) => n + x.length, 0)}エピソードを自動バックアップの対象にしました`);
}

let managedBackupFiles = [];
let managedBackupLatest = null;
async function loadBackupManager() {
  const box = $('backup-file-list');
  const gen = ++backupManagerGen;
  box.replaceChildren(Object.assign(document.createElement('p'), { className: 'hint', textContent: '一覧を読み込んでいます…' }));
  managedBackupLatest = null;
  // 名前の形が違うファイル（「… (2).json」など）も出す。出ないと、ここから消せないため
  // 一覧を読み終わるまで、読み込み中の画面を出す（中身の情報は、そのあと一覧の中で少しずつ足す）
  try { managedBackupFiles = await withBusy('バックアップの一覧を読み込み中…', () => sync.listManaged()); }
  catch (e) { if (gen === backupManagerGen) box.textContent = `一覧を読み込めませんでした：${e.message}`; return; }
  if (gen !== backupManagerGen) return;
  managedBackupLatest = managedBackupFiles.find((f) => !f.nameless) || null;
  box.replaceChildren();
  if (!managedBackupFiles.length) { box.textContent = 'バックアップファイルはありません。'; return; }
  // まずファイル名と日時だけで一覧を出す（すぐに選べる・消せる）。
  // 中の管理情報は、あとから少しずつ読んで足す（全部を一度に読むと、ファイルが多いとき一覧が出てこないため）
  const progress = Object.assign(document.createElement('p'), { className: 'hint' });
  box.append(progress);
  const when = (f, info) => {
    const t = info?.desc?.createdAt ? Date.parse(info.desc.createdAt) : f.at;
    return t ? fmtTime(new Date(t).toISOString()) : '日時不明';
  };
  const fileMeta = (f, info) => `${f.name}\n${when(f, info)}・${info?.desc ? backupDescriptionLine(info.desc) : `端末：${f.prefix || '不明'}${info ? '' : '・内容を確認中…'}`}${info?.size ? `・${Math.ceil(info.size / 1024).toLocaleString()}KB` : ''}${info?.error ? `・⚠ ${info.error}` : ''}`;
  const rows = managedBackupFiles.map((f) => {
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', value: f.id });
    const row = Object.assign(document.createElement('label'), { className: 'file-row' });
    const name = Object.assign(document.createElement('span'), { className: 'file-name', textContent: f.name.replace(/\.json$/i, '') });
    const metaEl = Object.assign(document.createElement('span'), { className: 'file-meta', textContent: fileMeta(f, null) });
    row.append(input, name, metaEl);
    box.append(row);
    return { f, row, name, metaEl, info: null };
  });
  const targets = rows.slice(0, 300);
  let done = 0;
  const showProgress = () => { progress.textContent = `内容を確認しています…（${done}／${targets.length}件）`; };
  showProgress();
  await Promise.all(targets.map(async (r) => {
    const info = await inspectBackupFile(r.f);
    if (gen !== backupManagerGen) return;
    r.info = info;
    if (info) {
      r.name.textContent = info.alias;
      r.metaEl.textContent = fileMeta(r.f, info);
    }
    done++;
    showProgress();
  }));
  if (gen !== backupManagerGen) return;
  progress.remove();
  // 読み終わったら並べ直す：エピソード → 作品 → 作品資料 → 環境の順、同じ種類では新しい順（チェックはそのまま）
  rows.sort((a, b) => (a.info?.priority ?? 8) - (b.info?.priority ?? 8) || b.f.at - a.f.at);
  for (const r of rows) box.append(r.row);
  const newest = rows.find((r) => r.info?.priority === 0);
  if (newest) newest.name.textContent = `最新　${newest.info.alias}`;
  managedBackupFiles = rows.map((r) => r.f);
}

// 保存先のファイルの中身を読むのは、同時に3件まで（一覧を開いたときに通信が詰まらないように）
const BACKUP_READ_LIMIT = 3;
let backupReading = 0;
let backupReadQueue = [];
let backupManagerGen = 0;
function queuedBackupRead(f) {
  return new Promise((resolve, reject) => {
    backupReadQueue.push({ f, resolve, reject });
    pumpBackupReads();
  });
}
function pumpBackupReads() {
  while (backupReading < BACKUP_READ_LIMIT && backupReadQueue.length) {
    const { f, resolve, reject } = backupReadQueue.shift();
    backupReading++;
    sync.read(f).then(resolve, reject).finally(() => { backupReading--; pumpBackupReads(); });
  }
}
// 一覧の画面を閉じたら、まだ読んでいないものは読まない
function cancelQueuedBackupReads() {
  const waiting = backupReadQueue;
  backupReadQueue = [];
  for (const w of waiting) w.reject(Object.assign(new Error('取りやめました'), { name: 'AbortError' }));
}

// バックアップの中身を読んで、一覧用の別名・種類・管理情報にする（同じファイルは読み直さない）。
// 戻り値：{ alias, priority, desc, size, error? }／null（取りやめた）
const backupInspections = new Map();
function inspectBackupFile(f) {
  const key = `${f.id}|${f.name}`;
  if (!backupInspections.has(key)) {
    backupInspections.set(key, queuedBackupRead(f).then((text) => {
      // ファイル名ではなく中の管理情報から、利用者向けの別名と種類を作る
      const pack = parseAnyBackup(text);
      const summary = packSummary(pack);
      const episodeItems = pack.items.filter((x) => x.type === 'episode');
      const projectItems = pack.items.filter((x) => x.type === 'project');
      const materialItems = pack.items.filter((x) => x.type === 'materials');
      const priority = episodeItems.length ? 0 : projectItems.length ? 1 : materialItems.length ? 2 : 3;
      let alias;
      if (pack.reason === 'manual-episode' && episodeItems.length === 1) alias = `${episodeItems[0].project?.title || '無題'}／${episodeName(episodeItems[0].episode)}`;
      else if (episodeItems.length) alias = `エピソード ${episodeItems.length}件（${summary.projects.map((p) => p.title).join('、')}）`;
      else if (projectItems.length) alias = projectItems.length === 1 ? `作品全体「${projectItems[0].project?.title || '無題'}」` : `全小説 ${projectItems.length}作品`;
      else if (materialItems.length) alias = `作品資料「${materialItems[0].project?.title || '無題'}」`;
      else alias = '環境設定';
      return { alias, priority, desc: describePack(pack), size: new Blob([text]).size };
    }).catch((e) => {
      if (e?.name === 'AbortError') { backupInspections.delete(key); return null; }
      return {
        alias: '内容を確認できないバックアップ', priority: 9, error: e?.message || String(e),
        desc: { kind: '不明', environment: '不明', novel: '不明', scope: '不明', project: '不明', episode: '不明', device: f.prefix || '不明' },
      };
    }));
  }
  return backupInspections.get(key);
}

async function openBackupManager() {
  const usable = sync.getState() === 'on';
  $('backup-manage-hint').textContent = usable
    ? `自動バックアップの保存先「${sync.folderName()}」にある .json ファイルを、すべて表示します。「バックアップパックを作成」などで別のフォルダに保存したファイルは、ここには出ません（そのフォルダは、保存の画面の上に出る場所で確かめられます）。`
    : '保存先が利用できません。サーバへの自動バックアップで保存先を設定してください。';
  $('backup-files-delete').disabled = !usable;
  $('backup-file-inspect').disabled = !usable;
  $('backup-manage-dialog').showModal();
  if (usable) await loadBackupManager();
}

function selectedManagedFiles() {
  const ids = new Set([...$('backup-file-list').querySelectorAll('input:checked')].map((x) => x.value));
  return managedBackupFiles.filter((f) => ids.has(String(f.id)));
}

async function inspectManagedBackup() {
  const files = selectedManagedFiles();
  if (files.length !== 1) { toast('内容を確認するファイルを一つ選んでください', true); return; }
  const text = await runTask('load', async () => (
    files[0].pack ? JSON.stringify(files[0].pack) : sync.read(files[0])
  ), { button: $('backup-file-inspect'), dialog: $('backup-manage-dialog'), busy: 'ファイルを読み込み中…', done: null, closeOnSuccess: false });
  if (!text) return;
  $('backup-manage-dialog').close();
  toast('読み込みが完了しました\n戻す内容を選んでください');
  await inspectBackupText(text, files[0].name, { acknowledge: managedBackupLatest });
}

async function deleteManagedBackups() {
  const files = selectedManagedFiles();
  if (!files.length) { toast('削除するファイルを選んでください', true); return; }
  const names = files.slice(0, 8).map((f) => `・${f.name}`).join('\n') + (files.length > 8 ? `\nほか${files.length - 8}件` : '');
  const where = sync.mode() === 'cloud' ? `${syncProvider()?.label || 'クラウド'}の「${sync.folderName()}」` : `フォルダ「${sync.folderName()}」`;
  if (!(await ask(`${where}から、次の${files.length}件のファイルを完全に削除します。\n${names}\n\nごみ箱にも残さないため、削除したファイルは元に戻せません。削除してよろしいですか？`, { ok: `${files.length}件を完全に削除`, danger: true }))) return;
  let deleted = 0;
  let recycled = 0;
  const failed = [];
  await withBusy('削除中…', async () => {
    for (const f of files) {
      try {
        if ((await sync.removeForever(f)) === 'recycled') recycled++; else deleted++;
      } catch (e) {
        console.warn(e);
        failed.push(`・${f.name}：${e?.message || e}`);
      }
    }
  });
  backupInspections.clear();
  await loadBackupManager();
  const lines = [];
  if (deleted) lines.push(`${deleted}件のファイルを完全に削除しました`);
  // 個人用 OneDrive などは、完全削除をアプリに許していない。ごみ箱に移ったことを伝える
  if (recycled) lines.push(`${recycled}件は、このクラウドでは完全に削除できないため、ごみ箱に移しました（ごみ箱を空にすると完全に消えます）`);
  if (failed.length) lines.push(`${failed.length}件は削除できませんでした：\n${failed.slice(0, 3).join('\n')}`);
  if (failed.length || recycled) await inform(lines.join('\n'));
  else toast(lines.join('\n'));
}

function syncStatusShort() {
  const st = sync.getState();
  if (st === 'off' || st === 'unsupported') return '';
  if (st === 'need-folder') return '⚠ サーバへのバックアップ先が未設定';
  if (st === 'need-permission') return '⚠ サーバへの自動バックアップ停止中（許可切れ）';
  if (st === 'need-login') return '⚠ サーバへの自動バックアップ停止中（ログインが必要）';
  if (syncPending) return '⚠ 他の端末で更新あり（自動バックアップ停止中）';
  if (sync.getError()) return '⚠ サーバへの自動バックアップに失敗';
  if (!sync.isChecked()) return 'サーバへの自動バックアップ：確認中';
  const last = prefs.get('lastAutoBackupAt', null);
  return last ? 'サーバ保存 ' + fmtTime(last) : 'サーバへの自動バックアップ 有効';
}

function renderSyncState() {
  const st = sync.getState();
  const m = sync.mode();
  const cloud = syncProvider();
  const cloudLabel = cloud?.label || 'クラウド';
  const b = $('sync-attention');
  const attention = syncPending ? '⚠ 他の端末の更新を確認'
    : st === 'need-folder' ? '⚠ 自動バックアップのフォルダを選ぶ'
    : st === 'need-permission' ? '⚠ 自動バックアップを再開'
      : st === 'need-login' ? `⚠ ${cloudLabel}にログイン（自動バックアップ）`
        : '';
  b.textContent = attention;
  b.hidden = !attention;

  const sel = $('sync-mode');
  const cloudOpt = sel.querySelector('option[value="cloud"]');
  cloudOpt.textContent = `${cloudLabel}（クラウドで設定したドライブ）`;
  sel.value = m;
  sel.querySelector('option[value="folder"]').disabled = !sync.folderSupported && m !== 'folder';
  cloudOpt.disabled = !cloud?.isConfigured() && m !== 'cloud';
  $('sync-mode-hint').textContent = m === 'cloud'
    ? `${cloudLabel}の、自分で作ったフォルダ（名前は自由）を選ぶと、そのフォルダに直接保存します。選ぶ画面で新しいフォルダも作れます。端末どうしで同期するときは、すべての端末で同じクラウド・同じフォルダを選んでください。`
      + (cloud?.id === 'onedrive' ? 'ログインは約1日続きます（使っているあいだは自動で更新します）。切れたら上に出るボタンを押してください。' : 'ログインは約1時間で切れます。切れたら上に出るボタンを押してください。')
    : m === 'folder'
      ? '自分で作ったフォルダを選ぶと、そのフォルダに直接保存します。PC のネットワークドライブ（NAS など）や、OneDrive・iCloud Drive・Google ドライブ（パソコン版）の同期フォルダも選べます。iPhone・iPad（クラウド方式）と同期するときは、OneDrive なら、パソコン版 OneDrive の「アプリ」（Apps）の中のあや綴りのフォルダの中の、iPhone・iPad と同じフォルダを選んでください。Google ドライブは、パソコン版の同期フォルダで書いたファイルを iPhone・iPad のあや綴りから読めないため、PC もクラウド方式にしてください。'
      : sync.folderSupported
        ? `iPhone・iPad と同期するときは「${cloudLabel}」がおすすめです（「クラウド」タブで選んで、接続IDを入れると使えます）。`
        : `この端末では「${cloudLabel}」を選べます（「クラウド」タブで選んで、接続IDを入れると使えます）。`;

  // バックアップ先のフォルダ（フォルダ方式：端末のフォルダ／クラウド方式：クラウドのフォルダ）
  const backupInfo = m === 'cloud' ? cloud?.backupFolderInfo?.() : null;
  $('sync-folder-line').textContent = m === 'folder' ? `バックアップ先：${sync.folderName() || '（まだ選んでいません）'}`
    : m === 'cloud' ? `バックアップ先：${backupInfo ? `${cloudLabel}の「${backupInfo.name}」` : '（まだ選んでいません）'}` : '';
  $('sync-folder-line').hidden = !$('sync-folder-line').textContent;
  $('sync-choose').textContent = m === 'folder' ? (sync.folderName() ? 'フォルダを選び直す…' : 'フォルダを選ぶ…')
    : st === 'need-login' ? `${cloudLabel}にログイン` : (backupInfo ? 'フォルダを選び直す・作る…' : 'フォルダを選ぶ・作る…');
  $('sync-folder-row').hidden = !(m === 'folder' || m === 'cloud');

  const last = sync.lastBackup();
  const lastText = last ? `\n最後に同期したバックアップ：${last.name}（${fmtTime(last.at)}）` : '';
  const err = sync.getError() ? `\n⚠ 前回の保存に失敗しました：${sync.getError()}` : '';
  const text = st === 'off' ? '止まっています。保存先を選ぶと始まります。'
    : st === 'need-folder' ? '⚠ バックアップ先のフォルダを選んでください（「フォルダを選ぶ」）。選ぶまでは保存しません。'
    : st === 'unsupported' ? (m === 'folder' ? `このブラウザではフォルダを使えません。「${cloudLabel}」を選んでください。` : `${cloudLabel}を使うには、「クラウド」タブで接続IDを入れてください。`)
      : st === 'need-permission' ? `⚠ 「${sync.folderName()}」への書き込みの許可が切れています。上の「自動バックアップを再開」を押してください。`
        : st === 'need-login' ? `⚠ ${cloudLabel}へのログインが必要です。上のボタン（または下の「${cloudLabel}にログイン」）を押してください。`
          : syncPending ? '⚠ 他の端末で新しいバックアップが保存されています。上の「他の端末の更新を確認」を押してください（それまで自動バックアップは止まります）。'
            : `✅ 「${sync.folderName()}」に、${sync.intervalMin()}分ごと（変更があるときだけ）・閉じるときに保存しています。この端末の分は最新${sync.keepCount()}件まで残します。`;
  $('sync-status').textContent = text + lastText + err;
  const on = st === 'on';
  $('sync-check').disabled = !on;
  $('sync-manage').disabled = false; // 端末のファイルを選ぶ機能は、サーバ未設定でも使える
  if (project) updateStatus();
}

// 起動したとき・保存先を変えたとき・「他の端末の更新を確認」：他の端末のほうが新しいバックアップを保存していないか調べる
async function runSyncCheck({ manual = false } = {}) {
  if (sync.getState() !== 'on') {
    if (manual) toast('自動バックアップの保存先が使えません（設定 → 自動バックアップ）', true);
    return;
  }
  let r;
  try {
    // 押して確かめるときは、終わるまで読み込み中の画面を出す（起動時の確認は裏で行う）
    r = manual
      ? await withBusy('他の端末の更新を確認中…', () => sync.findNewer({ ignoreSeen: manual }))
      : await sync.findNewer({ ignoreSeen: manual });
  } catch (e) {
    renderSyncState();
    if (manual) fail(e);
    return;
  }
  if (!r) {
    syncPending = null;
    sync.markChecked();
    if (manual) toast('他の端末の新しいバックアップはありません');
    return;
  }
  // 新しいバックアップがある：お知らせとバックアップの一覧を、1つの画面で出す（どの OS・保存先でも同じ）
  await openSyncRestore('sync', { notice: r });
}

// 両方で書き換えた作品について、どちらを使うか聞く
async function askSyncConflict(l, r) {
  const c = await choose(`「${l.title || '無題'}」は、この端末と他の端末の両方で書き換えられています。どちらを使いますか？\n\n` +
    `この端末：${fmtTime(l.updatedAt)} 更新・${totalChars(l).toLocaleString()}字\n` +
    `他の端末：${fmtTime(r.updatedAt)} 更新・${totalChars(r).toLocaleString()}字\n\n` +
    '（使わなかったほうも、「設定」→「自動バックアップ」の「同期の前の状態を書き出す」から取り出せます）',
  [{ value: 'local', label: 'この端末' }, { value: 'remote', label: '他の端末', primary: true }], { cancel: 'この端末のまま' });
  return c === 'remote' ? 'remote' : 'local';
}

// 人が選んだファイルを読み込むとき：この端末のほうが新しい作品を、ファイルの内容で置き換えるか（一度だけ聞く）
async function askReplaceNewer(name, list) {
  const lines = list.slice(0, 8).map(({ local, remote }) => `・「${local.title || '無題'}」　この端末 ${fmtTime(local.updatedAt)}／ファイル ${fmtTime(remote.updatedAt)}`);
  if (list.length > 8) lines.push(`ほか ${list.length - 8}作品`);
  return choose(`「${name}」より、この端末のほうが新しい作品があります。\n${lines.join('\n')}\n\n`
    + 'ファイルの内容で置き換えますか？（置き換える前の状態は「同期の前の状態を書き出す」から取り出せます）',
  [{ value: 'local', label: 'その作品はこの端末のまま' }, { value: 'file', label: 'ファイルの内容にする', primary: true }], { cancel: 'やめる' });
}

function afterMerge(res, name) {
  if (!res) { toast('読み込みをやめました'); return; }
  syncPending = null;
  reportAndReload(`「${name}」を読み込みました。`, res);
}

/**
 * 読み込み・復元のあと：どの作品が「新しい小説として増えた」「中身が置き換わった」「この端末のまま」かを知らせ、
 * 変わった作品を開いてから画面を読み直す（古い作品が表示されたままで、何が変わったか分からない、とならないように）。
 * 開く作品：今開いている作品が置き換わったならそのまま。そうでなければ、追加した作品 → 置き換えた作品の順で最初のもの。
 * res = { addedList, updatedList, keptList }（[{ id, title }]）
 */
function reportAndReload(head, { addedList = [], updatedList = [], keptList = [] }) {
  const names = (list) => list.slice(0, 10).map((x) => `「${x.title}」`).join('、') + (list.length > 10 ? ` ほか${list.length - 10}作品` : '');
  const lines = [head];
  if (addedList.length) lines.push(`・新しい小説として追加（${addedList.length}）：${names(addedList)}`);
  if (updatedList.length) lines.push(`・中身を置き換え（${updatedList.length}）：${names(updatedList)}`);
  if (keptList.length) lines.push(`・この端末のまま（${keptList.length}）：${names(keptList)}`);
  if (!addedList.length && !updatedList.length) lines.push('変わった作品はありません。');
  const current = prefs.get('currentId', null);
  let open = null;
  if (updatedList.some((x) => x.id === current)) open = { ...updatedList.find((x) => x.id === current), how: 'この小説は中身を置き換えました' };
  else if (addedList.length) open = { ...addedList[0], how: '追加した小説を開きました' };
  else if (updatedList.length) open = { ...updatedList[0], how: '中身を置き換えた小説を開きました' };
  if (open) {
    prefs.set('currentId', open.id);
    lines.push('', `いま開いているのは「${open.title}」です（${open.how}）。ほかの作品は「作品一覧」から開けます。`);
  }
  prefs.set('restoredReport', lines.join('\n'));
  location.reload();
}

// explicit：一覧やファイルから人が選んだとき（選んだファイルの内容を使う）。起動時の自動の確認では false（作品ごとに新しいほう）
// newest：そのときいちばん新しいバックアップの名前。古いものをあえて選んだときは、次の起動で最新を勧めないよう「確認済み」にする
async function mergeFrom(entry, { explicit = false, newest = null } = {}) {
  await flush();
  const opts = {
    ...(explicit ? { explicit: true, onOlder: (list) => askReplaceNewer(entry.name, list) } : {}),
    // 自動同期でバックアップパックを読む場合も、手動読込と同じ安全策を必ず通す。
    beforePackRestore: (pack, name) => protectBeforeRestore(pack, (pack.items || []).map((item) => item.key), name),
  };
  const res = await sync.loadAndMerge(entry, askSyncConflict, opts);
  if (res && explicit && newest && newest.name !== entry.name) sync.markChecked(newest);
  afterMerge(res, entry.name);
}

/**
 * バックアップから小説を1つ読み込む（「読み込む」「ファイルから選ぶ」のあと。どの OS・端末でも同じ）
 *   バックアップの中の小説を選び（今開いている小説と同じものがあれば、それが最初に選ばれている）、
 *   「上書き」… 今開いている小説を、選んだ小説の内容（タイトルから全部）で置き換える。置き換える前の内容は、作品のバックアップ版に残す
 *   「新小説」… 選んだ小説を、新しい小説として追加して開く
 *   「キャンセル」… 何もしない
 * newest：そのときいちばん新しいバックアップ。一覧にある過去版をあえて選んだときは、既存の最新までを確認済みにする
 * 戻り値：読み込んだら true（キャンセルは false）
 */
async function loadBackupAs(text, name, { newest = null } = {}) {
  const backup = parseBackup(text);
  const novels = (backup.projects || []).filter((p) => p?.id).map((p) => normalize(p));
  const env = environmentSummary(backup);
  if (!novels.length && !env.length) { toast('このバックアップには小説も環境も入っていません', true); return false; }
  const time = (p) => Date.parse(p.updatedAt || 0) || 0;
  novels.sort((a, b) => time(b) - time(a));
  const same = novels.find((p) => p.id === project.id);
  const label = (p) => `${p.title || '無題'}（${p.episodes.length}話・${fmtTime(p.updatedAt)} 更新）`;
  const cur = project.title || '無題';
  // 一覧の最後に「環境」（設定・ひな型・リンクなど）も入れる。選ぶと、環境だけを読み込む
  const options = novels.map((p) => ({ value: p.id, label: label(p) }));
  if (env.length) options.push({ value: ENV_CHOICE, label: '⚙ 環境（設定・ひな型・リンク・アカウントなど）' });
  const r = await choose(`「${name}」から読み込みます。\n\n`
    + `・上書き：いま開いている小説「${cur}」を、選んだ小説の内容（タイトルから全部）で置き換えます。置き換える前の内容は「作品のバックアップ版」に残します。\n`
    + '・新小説：選んだ小説を、新しい小説として追加して開きます（いま開いている小説はそのまま残ります）。'
    + (env.length ? '\n・一覧の最後の「⚙ 環境」を選ぶと、小説ではなく設定・ひな型・リンクなどを読み込みます（どちらのボタンでも、次に読み込み方を選べます）。' : ''),
  [{ value: 'overwrite', label: '上書き', danger: true }, { value: 'new', label: '新小説', primary: true }],
  { select: { label: 'バックアップの中の小説・環境', options, value: (same || novels[0])?.id ?? ENV_CHOICE } });
  if (!r) return false;
  if (r.value === ENV_CHOICE) return loadEnvironmentFrom(backup, name, env);
  const src = novels.find((p) => p.id === r.value);
  if (!src) { toast('読み込む小説を選んでください', true); return false; }
  await withBusy('復元中…', async () => {
    await flush();
    // ひな型・リンク・アカウントなどの設定も、この端末の設定を消さずにまとめる
    mergeSharedPrefs(backup.prefs);
    renderTemplateSelects();
    buildLinksMenu();
    const now = new Date().toISOString();
    if (r.choice === 'overwrite') {
      await saveVersion(`「${name}」で上書きする前（自動）`, '', true);
      const p = normalize({ ...structuredClone(src), id: project.id, workId: project.workId, links: project.links || {}, updatedAt: now });
      await db.put(p);
      showProject(p);
    } else {
      const p = normalize({ ...structuredClone(src), id: format.makeId(), workId: format.makeId(), links: {}, updatedAt: now });
      await switchTo(p);
    }
    syncPending = null;
    sync.markLoaded(name);
    if (newest && newest.name !== name) sync.markChecked(newest);
  });
  if (r.choice === 'overwrite') {
    await inform(`復元が完了しました\n\nいま開いている小説を、「${name}」の「${src.title || '無題'}」の内容で上書きしました。\n（上書きする前の内容は「変更履歴と復元ポイント」に残しています）`);
  } else {
    await inform(`復元が完了しました\n\n「${name}」の「${src.title || '無題'}」を、新しい小説として追加して開きました。\n（前に開いていた「${cur}」はそのまま残っています。「作品一覧」から開けます）`);
  }
  returnToEditor();
  return true;
}

const ENV_CHOICE = '__environment__';

// 環境を読み込んだあと、つなぎ直し・フォルダの選び直しが要るかを知らせる文
function environmentFollowUp(res) {
  if (!res) return '';
  const lines = [];
  if (res.providerChanged || res.idsChanged) lines.push('・使うクラウドかクライアントIDが変わりました。「設定」→「クラウド」でログインし直してください。');
  if (res.cloudChanged?.some((k) => /folder|backupFolder/i.test(k))) lines.push('・保存先フォルダの設定を読み込みました。この端末で使えないときは「設定」でフォルダを選び直してください。');
  if (res.cloudChanged?.includes('sync.mode')) lines.push('・自動バックアップの方式を読み込みました。「設定」→「自動バックアップ」で保存先が使えるか確かめてください（フォルダ方式は、この端末でフォルダを選び直す必要があります）。');
  return lines.length ? `\n\n${lines.join('\n')}` : '';
}

// バックアップの「環境」（設定・ひな型・リンク・アカウントなど）を読み込む。小説は変えない。読み込んだら画面を読み直す
async function loadEnvironmentFrom(backup, name, env) {
  const list = env.map((l) => '・' + l).join('\n');
  const how = await choose(`「${name}」の環境を読み込みます。小説は変わりません。\n\n入っているもの：\n${list}\n\n`
    + '・まとめる：この端末の設定を残したまま、足りないものを足します（ひな型・リンク・TXT インポートの条件は足し合わせ、アカウントは空の欄だけ埋めます）。\n'
    + '・置き換える：バックアップの設定で上書きします（表示・ファイル・自動バックアップの間隔なども）。\n'
    + '端末の名前（プレフィックス）とログインは、どちらでも変わりません。クライアントIDが入っていないときは、この端末のクライアントIDをそのまま使います。',
  [{ value: 'replace', label: '置き換える', danger: true }, { value: 'merge', label: 'まとめる', primary: true }]);
  if (!how) return false;
  await withBusy('復元中…', async () => {
    await flush();
    const res = applyEnvironment(backup, how);
    prefs.set('restoredReport', `復元が完了しました\n「${name}」の環境を${how === 'merge' ? 'まとめて' : '置き換えて'}読み込みました。\n${list}${environmentFollowUp(res)}`);
  });
  location.reload();
  return true;
}

// 一覧に出ないバックアップ（ほかの場所に置いたものなど）を、ファイルを選んで読み込む
async function syncFromFile(mode) {
  const src = await openFrom('バックアップのファイルを選ぶ');
  if (!src) return false;
  const isNewPack = (() => { try { return JSON.parse(src.text)?.format === PACK_FORMAT; } catch { return false; } })();
  if (!isBackup(src.text) && !isNewPack) { toast('あや綴りのバックアップファイルではありません', true); return false; }
  if (isNewPack) { await inspectBackupText(src.text, src.name); return true; }
  if (mode === 'restore') { openRestoreDialog(src.text, src.name); return true; }
  const newest = (await sync.listAll().catch(() => []))[0] || null;
  return loadBackupAs(src.text, src.name, { newest });
}

// 許可・ログインが戻っていれば、起動時の確認をする
async function syncResumeIfReady() {
  await sync.refresh();
  if (sync.getState() === 'on' && !sync.isChecked() && !syncPending) await runSyncCheck();
}

async function resolveSyncAttention() {
  if (syncPending) { await runSyncCheck({ manual: true }); return; }
  if (sync.getState() === 'need-folder') { openSettings('backup'); return; }
  const ok = await sync.resume(); // Google ドライブ（ホーム画面のアプリ）では、ここでページごと Google へ移動する
  if (!ok) { toast(sync.mode() === 'folder' ? '書き込みが許可されませんでした' : 'ログインできませんでした', true); return; }
  toast('自動バックアップを再開しました');
  await runSyncCheck();
}

/**
 * 保存先のバックアップ（全端末：Win_・Mac_・iPhone_・iPad_・android_ など）の一覧から選ぶ。新しい順、先頭が「最新」。
 * mode 'sync'    …「他の端末の更新を確認」：選んだバックアップの内容を使う（普通は最新を選ぶ）
 * mode 'restore' …「バックアップから戻す」：選んだバックアップに戻す（次の画面で「まとめる／入れ替える」）
 * notice（sync のみ）… 新しいバックアップが見つかったとき（起動時・保存の前）の { entry, localChanged }。
 *   お知らせと一覧を同じ画面に出し、「この端末の記録を使う」「あとで（読み込まない）」も選べるようにする。どの OS・保存先でも同じ。
 */
async function openSyncRestore(mode = 'restore', { notice = null } = {}) {
  const isSync = mode === 'sync';
  const dialog = $('sync-restore-dialog');
  $('sync-restore-title').textContent = notice ? '他の端末で新しいバックアップがあります' : isSync ? '他の端末の記録を読み込む' : 'バックアップから戻す';
  const n = $('sync-restore-notice');
  n.hidden = !notice;
  if (notice) {
    const { entry, localChanged } = notice;
    const who = `${entry.prefix || '（プレフィックスなし）'}　${fmtTime(new Date(entry.at).toISOString())}`;
    n.textContent = `⚠ 他の端末（${who}）で、新しいバックアップが保存されています。`
      + (localChanged ? '\nこの端末にも、まだ保存していない変更があります。' : '')
      + '\n下の一覧から読み込むものを選んでください（先頭の「最新」が候補です）。'
      + (localChanged ? '\n他の端末の記録を使わないときは「この端末の記録を使う」を押すと、今の内容をすぐ保存して最新にします。' : '');
  }
  $('sync-restore-hint').textContent = isSync
    ? '選んだファイルの内容を使います。この端末のほうが新しい作品があるときは、置き換えるかを聞きます。この端末にしかない作品は消えません。'
    : '戻したいバックアップを選んでください。次の画面で「まとめる／入れ替える」を選べます。';
  // お知らせのときは「この端末の記録を使う」「あとで／読み込まない」、そうでなければ「閉じる」
  const keep = $('sync-keep-mine');
  const later = $('sync-later');
  keep.hidden = !(notice && notice.localChanged);
  later.hidden = !notice;
  later.textContent = notice?.localChanged ? 'あとで' : '読み込まない';
  $('sync-restore-close').hidden = !!notice;
  let decided = false;
  const decide = () => { decided = true; };
  const doLater = () => {
    if (!notice) return;
    if (notice.localChanged) {
      // あとで：決めるまで自動バックアップは止めておく（先に保存すると、他の端末の更新が隠れてしまうため）
      syncPending = notice.entry;
    } else {
      syncPending = null;
      sync.markChecked(notice.entry); // 読み込まない：次に起動したとき同じことは聞かない
    }
    renderSyncState();
  };
  keep.onclick = async () => {
    const ok = await runTask('backup', async () => {
      const ok = await sync.backupNow({ force: true });
      if (!ok) throw new Error('保存できませんでした：' + (sync.getError() || '原因不明'));
      return true;
    }, { button: keep, dialog, closeOnSuccess: false, done: 'バックアップを作成しました\nこの端末の記録が最新になります' });
    if (!ok) return;
    decide();
    dialog.close();
    syncPending = null;
    sync.markChecked(notice.entry);
  };
  later.onclick = () => { decide(); dialog.close(); doLater(); };
  // Esc などで閉じたときは「あとで／読み込まない」と同じ
  dialog.onclose = () => { if (notice && !decided) doLater(); };

  const list = $('sync-restore-list');
  const filter = $('sync-restore-filter');
  list.replaceChildren(li('empty', '読み込み中…'));
  filter.replaceChildren(new Option('すべての端末', ''));
  dialog.showModal();
  let files;
  // 一覧に出ないファイルも選べるように（押したその場でファイル選択を出す）
  $('sync-from-file').onclick = () => {
    try { syncFromFile(mode).then((done) => { if (done) { decide(); dialog.close(); } }).catch(fail); } catch (err) { fail(err); }
  };
  try {
    // 一覧を読み終わるまで、読み込み中の画面を出す（バックアップの保存のときと同じ）
    files = await withBusy('バックアップの一覧を読み込み中…', () => sync.listAll());
  } catch (e) {
    list.replaceChildren(li('empty', '一覧を読み込めませんでした：' + e.message + '（「ファイルから選ぶ」は使えます）'));
    return;
  }
  const keyOf = (f) => f.prefix || '__none__';
  const prefixes = [...new Set(files.map(keyOf))].sort((a, b) => collator.compare(a, b));
  for (const p of prefixes) filter.append(new Option(`${p === '__none__' ? '（プレフィックスなし）' : p}（${files.filter((f) => keyOf(f) === p).length}件）`, p));
  const last = sync.lastBackup()?.name;
  const render = () => {
    const shown = files.filter((f) => !filter.value || keyOf(f) === filter.value);
    list.replaceChildren();
    if (!shown.length) { list.append(li('empty', 'まだバックアップはありません')); return; }
    for (const f of shown.slice(0, 300)) {
      const tags = [fmtTime(new Date(f.at).toISOString())];
      if (f === files[0]) tags.push('最新');
      if (f.mine) tags.push('この端末');
      if (f.name === last) tags.push('前回同期したもの');
      // 最初はどのボタンも強調しない。押したボタンだけ「処理中」の色になる（runTask）
      const act = button(isSync ? '読み込む' : '選ぶ', async () => {
        const read = await runTask('load', async () => {
          const text = await sync.read(f);
          const isPack = (() => { try { return JSON.parse(text)?.format === PACK_FORMAT; } catch { throw new Error('ファイルの中身を読み取れませんでした（壊れているか、あや綴りのファイルではありません）'); } })();
          return { text, isPack };
        }, { button: act, dialog, busy: 'ファイルを読み込み中…', done: null, closeOnSuccess: false });
        if (!read) return;
        const { text, isPack } = read;
        if (isPack) {
          decide();
          dialog.close();
          toast('読み込みが完了しました\n戻す内容を選んでください');
          await inspectBackupText(text, f.name, { acknowledge: files[0] });
          return;
        }
        if (isSync) {
          // 一覧の画面は開いたまま、その上で「上書き／新小説／キャンセル」を聞く（キャンセルなら一覧に戻る）
          if (!(await loadBackupAs(text, f.name, { newest: files[0] }))) return;
          decide();
          dialog.close();
          return;
        }
        dialog.close();
        openRestoreDialog(text, f.name, { acknowledge: files[0] });
      });
      const item = listItem(f.name, tags.join('・'), [act]);
      list.append(item);
      // 中の管理情報（自動／手動・環境・範囲・作品・話・端末）は、あとから読んで足す
      const metaEl = item.querySelector('.item-meta');
      // 通信が多くなりすぎないよう、上から60件まで
      if (list.children.length <= 60) describeBackupFile(f).then((d) => { if (d && metaEl.isConnected) metaEl.textContent = `${tags.join('・')}\n${backupDescriptionLine(d)}`; });
    }
  };
  filter.onchange = render;
  render();
}

// 一覧に出す管理情報の1行。分からないところは「不明」
function backupDescriptionLine(d) {
  return `${d.kind}・環境：${d.environment}・小説：${d.novel}・範囲：${d.scope}・作品：${d.project}・話：${d.episode}・端末：${d.device}`;
}

// 保存先にあるバックアップの中身を読んで、一覧用の情報にする（同じファイルは読み直さない）
function describeBackupFile(f) {
  return inspectBackupFile(f).then((x) => x?.desc || null);
}

async function exportPreSync() {
  const saved = await meta.get('preSyncBackup');
  if (!saved) { toast('同期の前の状態はありません'); return; }
  const d = new Date(saved.createdAt);
  const p = (n) => String(n).padStart(2, '0');
  const r = await localFile.saveAs(saved.text, backupFileName('同期の前', d), WORK_TYPES, 'application/json', (write) => withBusy('保存中…', write));
  if (r) toast('同期の前の状態を書き出しました（「設定」→「バックアップ」→「バックアップファイルの管理」から戻せます）');
}

// ---------- クラウド（設定の「クラウド」タブ） ----------

// 使うクラウド（Google ドライブ／OneDrive）を切り替える。つなぎ直すため、画面を読み直す
async function changeCloudProvider(id) {
  const current = activeProvider();
  const next = id === 'none' ? null : providers.find((p) => p.id === id);
  if (id !== 'none' && !next) return;
  if (next === current) return;
  const nextLabel = next?.label || 'なし';
  const currentLabel = current?.label || 'なし';
  const usingBackup = sync.mode() === 'cloud';
  if (!(await ask(`利用できるクラウドを「${nextLabel}」に切り替えますか？\n画面を読み直します。`
    + (usingBackup ? (next
      ? `\nサーバへの自動バックアップも「${nextLabel}」を利用します（${currentLabel}のバックアップは消えません）。`
      : '\nクラウド方式の自動バックアップは、別のクラウドを選ぶまで利用できなくなります。') : ''),
  { ok: '切り替える', danger: false }))) {
    $('cloud-provider').value = current?.id || 'none';
    return;
  }
  await flush();
  prefs.set('cloud.provider', next?.id || 'none');
  prefs.set('settingsTab', 'cloud');
  prefs.set('restoredMessage', `利用できるクラウドを「${nextLabel}」にしました`);
  location.reload();
}

function renderCloudActions() {
  const p = activeProvider();
  $('cloud-provider').value = p?.id || 'none';
  const login = $('cloud-login');
  const configured = !!p?.isConfigured?.();
  login.disabled = !configured;
  login.textContent = p ? `${p.label}にログイン` : 'ログイン';
  $('cloud-login-state').textContent = !p ? '利用するクラウドを選んでください。'
    : !configured ? '先に接続IDを設定してください。'
      : p.isSignedIn?.() ? 'ログイン済みです。必要ならログインし直せます。' : 'ログインしていません。';
}

async function loginCloud() {
  const p = activeProvider();
  if (!p) { toast('利用するクラウドを選んでください', true); return; }
  if (!p.isConfigured?.()) { toast('先にドライブの接続IDを設定してください', true); return; }
  await flush();
  await p.signIn();
  renderCloudActions();
  renderSyncState();
  if (p.isSignedIn?.()) toast(`${p.label}にログインしました`);
}

// 保存先フォルダ（端末ごとの設定）
function renderCloudFolder(p) {
  const wrap = Object.assign(document.createElement('div'), { className: 'cloud-folder' });
  const f = p.folderInfo();
  wrap.append(Object.assign(document.createElement('div'), {
    className: 'cloud-folder-name',
    textContent: `保存先フォルダ：${f.name}${f.id && !f.isDefault ? `（ID：${f.id}）` : ''}`,
  }));
  const row = Object.assign(document.createElement('div'), { className: 'button-row' });
  const after = (folder) => {
    if (!folder) return;
    renderCloudActions();
    renderSyncState();
    toast(`「ファイル」の保存先を「${folder.name}」にしました（自動バックアップの場所は「自動バックアップ」タブで決めます）`);
  };
  // エディター内の画面で、クラウドのフォルダを選ぶ・作る（iPhone・iPad でも使える）
  const choose = button('フォルダを選ぶ・作る…', async () => {
    const folder = await driveBrowse({ p, mode: 'folder', title: '保存先のフォルダを選ぶ' });
    if (!folder) return;
    p.setFolder(folder);
    after(folder);
  });
  row.append(choose);
  if (!f.isDefault) {
    const top = p.rootName || p.label;
    row.append(button(`${top}の一番上に戻す`, async () => {
      if (!(await ask(`保存先を、${top}の一番上に戻しますか？（保存済みのファイルは移動しません）`))) return;
      p.resetFolder();
      renderCloudActions();
      renderSyncState();
    }));
  }
  wrap.append(row, Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: `「ファイル」で ${p.label} に保存・開くとき、最初に開くフォルダです（端末ごとの設定）。自動バックアップの場所は「自動バックアップ」タブで決めます。`
      + '保存先を変えても、すでに保存したファイルは移動しません。同じフォルダに同じ名前のファイルがあるときは、上書きせずに名前の後ろに番号を付けます。',
  }));
  return wrap;
}

// ---------- コピー・編集補助 ----------

const copySources = {
  'novel-title': () => ['小説タイトル', project.title],
  synopsis: () => ['あらすじ', project.synopsis],
  'project-memo': () => ['メモ', project.projectMemo || ''],
  'ep-title': () => ['エピソードタイトル', cur().title],
  foreword: () => ['前書き', convert(editSite, cur().foreword)],
  body: () => ['本文', convert(editSite, cur().body)],
  afterword: () => ['後書き', convert(editSite, cur().afterword)],
  'free-memo': () => ['フリーメモ', episode().freeMemo],
  plot: () => ['プロット', episode().plot],
  'x-text': () => ['X の投稿文', epReport().x],
  'narou-report-title': () => ['活動報告のタイトル', epReport().narouTitle],
  'narou-report-body': () => ['活動報告の本文', epReport().narouBody],
};

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

async function copyText(text, label) {
  const ok = await writeClipboard(text);
  toast(ok ? `${label}をコピーしました` : 'コピーできませんでした', !ok);
}

// 全体プロット・設定・登場人物の画面
const sectionOpts = { onChange: () => changed(), toast, copy: (t, label) => copyText(t, label).catch(fail) };
const outline = chapterList($('chapters'), () => project.chapters, {
  ...sectionOpts,
  onChange: (what) => { changed(); if (what?.chapterTitle) renderEpisodeList(); },
  addChapter: (afterIndex) => addChapter(afterIndex),
  moveChapter: (ch, d) => moveChapter(ch, d),
  removeChapter: (ch) => removeChapter(ch),
  episodeCount: (ch) => episodeCountIn(ch),
  find: (target, label) => openFind(target, label),
});
// 設定・登場人物の「テキストに書き出す」→「ファイルに保存」
const tableOpts = {
  ...sectionOpts,
  fileBase: () => project.title || '作品',
  save: (text, name, what) => saveTextTo(text, name, { title: `${what}を保存`, kind: 'txt' })
    .then((r) => { if (r) toast(savedMessage(r, what)); }).catch(fail),
};
const worldTable = categorizedTable($('world-tables'), () => project.world, {
  ...tableOpts, columns: WORLD_COLUMNS, itemLabel: '項目', title: '世界観・用語', exportKey: 'world', memberSource: () => project.characters,
});
const characterTable = categorizedTable($('character-tables'), () => project.characters, {
  ...tableOpts, columns: CHARACTER_COLUMNS, itemLabel: '人物', title: '登場人物', exportKey: 'characters', orgSource: () => project.world,
});

// TXT インポート（確定するまで作品は変更しない）
const importScreen = initImport({
  db, versions, meta, prefs, toast, fail,
  getProject: () => project,
  flush: () => flush(),
  switchTo: (p) => switchTo(p),
  closeSettings: () => $('settings-dialog').close(),
  withBusy,
  returnToEditor,
  // 「クラウド」タブで選んだクラウドの名前（使えないときは ''）と、そこから TXT／ZIP を選ぶ画面
  cloudLabel: () => driveProvider()?.label || '',
  pickCloudImportFile: () => {
    const p = driveProvider();
    return p ? pickDriveFile(p, `${p.label}から TXT／ZIP を選ぶ`, 'import') : Promise.resolve(null);
  },
});

async function copyField(key) {
  const [label, text] = copySources[key]();
  if (!text) { toast(label + 'は空です'); return; }
  const ok = await writeClipboard(text);
  if (!ok) { toast('コピーできませんでした', true); return; }
  let msg = `${label}をコピーしました（${countChars(text).all.toLocaleString()}字）`;
  if (key === 'body') {
    msg = `${label}を${SITES[editSite].short}用にコピーしました（${countChars(text).all.toLocaleString()}字）`;
    const images = countImages(cur().body);
    if (editSite === 'alpha' && images) msg += `　※挿絵${images}か所は【挿絵】の位置に手で入れてください`;
  }
  toast(msg);
}

// 選択範囲を text に置き換える（「元に戻す」が効くよう execCommand を優先）
function replaceSelection(target, text, start = target.selectionStart, end = target.selectionEnd) {
  target.focus();
  target.setSelectionRange(start, end);
  if (!document.execCommand('insertText', false, text)) {
    target.setRangeText(text, start, end, 'end');
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// 入力補助の対象：最後に触った 前書き／本文／後書き
let editTarget = null;
const target = () => editTarget || el.body;

function insertRuby() {
  const t = target();
  const { selectionStart: s, selectionEnd: e } = t;
  const sel = t.value.slice(s, e).replace(/\n/g, '');
  if (editSite === 'narou' && [...sel].length > RUBY_LIMIT) {
    toast(`なろうのルビは${RUBY_LIMIT}文字までです（選択 ${[...sel].length}文字）`, true);
    return;
  }
  replaceSelection(t, ruby(editSite, sel, ''), s, e);
  const caret = s + (sel ? rubyCaretOffset(editSite, sel) : 1);
  t.setSelectionRange(caret, caret);
}

function insertDots() {
  const t = target();
  const { selectionStart: s, selectionEnd: e } = t;
  if (s === e) { toast('傍点を付ける文字を選択してから押してください'); return; }
  replaceSelection(t, dots(editSite, t.value.slice(s, e)), s, e);
}

function insertSymbol(sym) {
  const t = target();
  const { selectionStart: s, selectionEnd: e } = t;
  // 「」などの対の記号は、選択した文字を囲む
  const pair = sym.length === 2 && /^[「『（【]/.test(sym);
  const sel = t.value.slice(s, e);
  replaceSelection(t, pair ? sym[0] + sel + sym[1] : sym, s, e);
  if (pair && !sel) t.setSelectionRange(s + 1, s + 1);
}

async function runAutoIndent() {
  const t = el.body;
  if (autoIndent(t.value) === t.value) { toast('字下げが必要な段落はありません'); return; }
  if (!(await ask('段落の先頭を一字下げますか？\n（「 などで始まる行、すでに字下げしてある行は除きます）'))) return;
  const next = autoIndent(t.value);
  const lines = next.split('\n').filter((l, i) => l !== t.value.split('\n')[i]).length;
  replaceSelection(t, next, 0, t.value.length);
  t.setSelectionRange(0, 0);
  t.scrollTop = 0;
  toast(`${lines}か所を字下げしました（元に戻す：Ctrl+Z）`);
}

// ---------- 入力欄の検索 ----------

let findTarget = null;
let findCursor = -1;
const FIND_LABELS = {
  'novel-title': '小説タイトル', 'ep-title': 'エピソードタイトル', body: '本文', foreword: '前書き', afterword: '後書き',
  plot: 'プロット', 'free-memo': 'フリーメモ', synopsis: 'あらすじ', 'project-memo': '作品のメモ',
  'x-text': 'X 投稿文', 'narou-report-title': '活動報告のタイトル', 'narou-report-body': '活動報告の本文',
};

function openFind(targetOrId, label = '') {
  const target = typeof targetOrId === 'string' ? $(targetOrId) : targetOrId;
  if (!target || !('value' in target)) return;
  findTarget = target;
  findCursor = target.selectionStart ?? -1;
  const form = $('find-form');
  const selected = target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0);
  if (selected && !selected.includes('\n')) form.query.value = selected;
  $('find-field-name').textContent = label || FIND_LABELS[target.id] || target.getAttribute('aria-label') || '入力欄';
  $('find-result').textContent = '';
  const dialog = $('find-dialog');
  if (!dialog.open) dialog.show();
  form.query.focus();
  form.query.select();
}

// textarea は選択範囲を変えただけでは、長い文章の内部スクロールが検索位置まで動かないブラウザーがある。
// 同じ幅・書体の一時要素で検索位置の高さを測り、見つけた文字が入力欄の中央付近に来るようにする。
function revealTextPosition(target, index) {
  if (target instanceof HTMLTextAreaElement) {
    const style = getComputedStyle(target);
    const mirror = document.createElement('div');
    const props = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth'];
    for (const prop of props) mirror.style[prop] = style[prop];
    Object.assign(mirror.style, {
      position: 'fixed', left: '-100000px', top: '0', visibility: 'hidden', pointerEvents: 'none',
      boxSizing: style.boxSizing, width: `${target.clientWidth}px`, whiteSpace: 'pre-wrap', overflowWrap: 'break-word', wordBreak: style.wordBreak,
    });
    mirror.append(document.createTextNode(target.value.slice(0, index)));
    const marker = document.createElement('span');
    marker.textContent = target.value.slice(index, index + 1) || '\u200b';
    mirror.append(marker);
    document.body.append(mirror);
    target.scrollTop = Math.max(0, marker.offsetTop - target.clientHeight / 2);
    mirror.remove();
  }
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function findInField(direction = 1) {
  if (!findTarget) return;
  const form = $('find-form');
  const query = form.query.value;
  if (!query) { $('find-result').textContent = '検索する文字を入力してください。'; form.query.focus(); return; }
  const source = form.caseSensitive.checked ? findTarget.value : findTarget.value.toLocaleLowerCase('ja');
  const needle = form.caseSensitive.checked ? query : query.toLocaleLowerCase('ja');
  const hits = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + Math.max(needle.length, 1))) hits.push(at);
  if (!hits.length) { $('find-result').textContent = '見つかりませんでした。'; return; }
  let index;
  if (direction > 0) index = hits.find((at) => at > findCursor) ?? hits[0];
  else index = [...hits].reverse().find((at) => at < findCursor) ?? hits[hits.length - 1];
  findCursor = index;
  const fold = { body: 'body', plot: 'plot', 'free-memo': 'memo' }[findTarget.id];
  if (fold && isFolded(fold)) setFolded(fold, false);
  if (findTarget.id === 'foreword') $('foreword-box').open = true;
  if (findTarget.id === 'afterword') $('afterword-box').open = true;
  findTarget.focus({ preventScroll: true });
  findTarget.setSelectionRange(index, index + query.length);
  revealTextPosition(findTarget, index);
  $('find-result').textContent = `${hits.indexOf(index) + 1}／${hits.length}件目`;
}

// ---------- 一括置換 ----------

// 置換は、いま編集している側（なろう用／アルファ用）の原稿が対象
function replaceFields() {
  return editSite === 'narou' ? ['foreword', 'body', 'afterword'] : ['body'];
}

function countMatches(from, scope) {
  if (!from) return 0;
  const eps = scope === 'all' ? project.episodes : [episode()];
  return eps.reduce((n, e) => n + replaceFields().reduce((m, f) => m + draftOf(e, editSite)[f].split(from).length - 1, 0), 0);
}

function updateReplacePreview() {
  const form = $('replace-form');
  const n = countMatches(form.from.value, form.scope.value);
  $('replace-preview').textContent = form.from.value ? `${n}か所見つかりました` : '';
}

function openReplace() {
  const form = $('replace-form');
  const t = target();
  const sel = t.value.slice(t.selectionStart, t.selectionEnd);
  form.from.value = sel.includes('\n') ? '' : sel;
  form.to.value = '';
  form.scope.value = 'episode';
  updateReplacePreview();
  $('replace-dialog').showModal();
  form.from.focus();
}

function runReplace() {
  const form = $('replace-form');
  const { value: from } = form.from;
  const to = form.to.value;
  const n = countMatches(from, form.scope.value);
  if (!n) { toast('置換する文字列が見つかりませんでした'); return; }
  const eps = form.scope.value === 'all' ? project.episodes : [episode()];
  for (const e of eps) {
    let hit = false;
    const d = e.drafts[editSite];
    for (const f of replaceFields()) {
      if (d[f].includes(from)) { d[f] = d[f].split(from).join(to); hit = true; }
    }
    if (hit) touchEpisode(e);
  }
  changed();
  renderEpisodeList();
  showEpisode();
  toast(`「${from}」を「${to}」に${n}か所置換しました`);
}

let imageCaret = [0, 0];
function openImageDialog() {
  if (editSite !== 'narou') return;
  imageCaret = [el.body.selectionStart, el.body.selectionEnd];
  const form = $('image-form');
  form.url.value = '';
  $('image-dialog').showModal();
  form.url.focus();
}

function insertImage(value) {
  const v = value.trim();
  const tag = /^<i\d+\|\d+>$/.test(v) ? v : (hasMiteminUrl(v) ? miteminToTag(v).trim() : null);
  if (!tag || !/^<i\d+\|\d+>$/.test(tag)) {
    toast('みてみんの画像ページURL（https://〜.mitemin.net/i〜/）を入れてください', true);
    return;
  }
  const [s, e] = imageCaret;
  replaceSelection(el.body, tag, s, e);
  toast(`挿絵タグ ${tag} を入れました`);
}

// みてみんの挿絵はなろうのみ
// ---------- 画像の一覧（本文の「画像」メニュー） ----------
// 本文の入力欄は文字しか扱えないので、画像へのリンクは一覧に出す。押すとみてみんの画像ページが開く。

const IMAGE_KIND = { narou: 'なろうの挿絵タグ', mitemin: 'みてみんの URL', alpha: 'アルファポリスの画像タグ' };

function buildImageMenu() {
  const list = $('image-list');
  const images = findImages(el.body.value);
  list.replaceChildren();
  if (!images.length) {
    list.append(Object.assign(document.createElement('div'), {
      className: 'menu-label',
      textContent: '本文に画像はありません（なろうの挿絵タグ <i…|…> や、みてみんの URL を探します）',
    }));
    return;
  }
  images.forEach((img, n) => {
    const item = Object.assign(document.createElement('div'), { className: 'image-item' });
    const source = Object.assign(document.createElement(img.url ? 'a' : 'div'), {
      className: 'image-sub',
      textContent: `${IMAGE_KIND[img.kind]}：${img.text}`,
    });
    if (img.url) {
      source.href = img.url;
      source.target = '_blank';
      source.rel = 'noopener noreferrer';
      source.title = img.url;
    }
    item.append(
      Object.assign(document.createElement('div'), {
        className: 'image-head',
        textContent: `${n + 1}. ${img.kind === 'alpha' ? img.code : `i${img.code}`}${img.user ? `（みてみん ${img.user}）` : ''} ・ ${img.line}行目`,
      }),
      source);
    const actions = Object.assign(document.createElement('div'), { className: 'image-actions' });
    if (img.url) {
      const open = button('みてみんで開く', () => { closeMenus(); openLink(img.url); });
      open.title = img.url;
      actions.append(open);
    }
    actions.append(button('本文のこの位置へ', () => { closeMenus(); jumpToText(el.body, img.index, img.text.length); }));
    if (img.url) actions.append(button('URL をコピー', () => copyText(img.url, 'みてみんの URL')));
    item.append(actions);
    list.append(item);
  });
}

// 「↑」「↓」：入力欄の一番上・一番下へ移る（中のスクロールと、画面のスクロールの両方。カーソルもそこへ）
// 指で触る端末では、キーボードが出ないよう、カーソルは動かさずにスクロールだけにする
function jumpField(key, to) {
  const t = { body: el.body, plot: el.plot, 'free-memo': el.freeMemo }[key];
  if (!t) return;
  const top = to === 'top';
  t.scrollTop = top ? 0 : t.scrollHeight;
  if (!t.closest('.maximized')) t.scrollIntoView({ block: top ? 'start' : 'end', behavior: 'smooth' });
  if (!matchMedia('(pointer: coarse)').matches) {
    const pos = top ? 0 : t.value.length;
    t.focus({ preventScroll: true });
    t.setSelectionRange(pos, pos);
    t.scrollTop = top ? 0 : t.scrollHeight;
  }
}

// 入力欄の中の位置を選んで、見える所までスクロールする
function jumpToText(t, index, length) {
  const pane = t.closest('[data-pane]');
  if (pane) selectTab(pane.dataset.pane);
  t.focus();
  t.setSelectionRange(index, index);
  // 選択した位置までスクロールさせるため、一度その位置まで選び直す
  t.blur();
  t.focus();
  t.setSelectionRange(index, index + length);
}

function onBodyPaste(e) {
  if (editSite !== 'narou') return;
  const text = e.clipboardData?.getData('text/plain');
  if (!text || !hasMiteminUrl(text)) return;
  e.preventDefault();
  replaceSelection(el.body, miteminToTag(text));
  toast('みてみんのURLを挿絵タグに変換しました');
}

function selectTab(name) {
  document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  scheduleFitFields();
}

// ---------- 活動報告・ひな型 ----------

const KIND_LABEL = { x: 'X', narou: '活動報告', afterword: '後書き' };
const KINDS = Object.keys(KIND_LABEL);

function templates() {
  const stored = prefs.get('templates', null);
  if (!stored) return structuredClone(DEFAULT_TEMPLATES);
  // 後から増えた種類の初期ひな型を一度だけ足す
  for (const kind of KINDS) {
    if (prefs.get('seeded:' + kind, false)) continue;
    if (!stored.some((t) => t.kind === kind)) stored.push(...structuredClone(DEFAULT_TEMPLATES.filter((t) => t.kind === kind)));
    prefs.set('seeded:' + kind, true);
    prefs.set('templates', stored);
  }
  return stored;
}

function saveTemplates(list) {
  prefs.set('templates', list);
  sync.markDirty(); // ひな型も自動バックアップに入れる
  renderTemplateSelects();
}

function renderTemplateSelects() {
  for (const kind of KINDS) {
    const sel = $('tpl-' + kind);
    const keep = sel.value;
    sel.replaceChildren();
    const list = templates().filter((t) => t.kind === kind);
    if (!list.length) sel.append(new Option('（ひな型なし）', ''));
    for (const t of list) sel.append(new Option(t.name, t.id));
    if (list.some((t) => t.id === keep)) sel.value = keep;
  }
}

// 活動報告タブ：今のエピソードの活動報告（ひな型の話数・タイトル・URL も今のエピソード）
function renderReportView() {
  $('report-ep-name').textContent = `第${epIndex + 1}話「${episodeName(episode(), project.site)}」`;
  renderTemplateSelects();
  updateCounts();
}

async function applyTemplate(kind) {
  const t = templates().find((x) => x.id === $('tpl-' + kind).value);
  if (!t) { toast('ひな型を選んでください'); return; }
  if (kind === 'afterword') {
    if (el.afterword.value && !(await ask('今の後書きをひな型で置き換えますか？'))) return;
    $('afterword-box').open = true;
    replaceSelection(el.afterword, fillTemplate(t.body, project, epIndex), 0, el.afterword.value.length);
    toast(`ひな型「${t.name}」を差し込みました`);
    return;
  }
  const index = epIndex; // 今のエピソード
  if (kind === 'x') {
    if (el.xText.value && !(await ask('今の投稿文をひな型で置き換えますか？'))) return;
    el.xText.value = fillTemplate(t.body, project, index);
    el.xText.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    if ((el.nrTitle.value || el.nrBody.value) && !(await ask('今の活動報告をひな型で置き換えますか？'))) return;
    el.nrTitle.value = fillTemplate(t.title || '', project, index);
    el.nrBody.value = fillTemplate(t.body, project, index);
    el.nrTitle.dispatchEvent(new Event('input', { bubbles: true }));
    el.nrBody.dispatchEvent(new Event('input', { bubbles: true }));
  }
  toast(`ひな型「${t.name}」を差し込みました`);
}

let editingTemplate = null;
function editTemplate(t) {
  editingTemplate = t;
  const form = $('template-edit-form');
  $('template-edit-heading').textContent = `${KIND_LABEL[t.kind]}のひな型`;
  $('template-edit-title').hidden = t.kind !== 'narou';
  form.name.value = t.name;
  form.title.value = t.title || '';
  form.body.value = t.body;
  $('template-edit-dialog').showModal();
}

// 今の文章をもとに新しいひな型を作る
function templateFromCurrent(kind) {
  const t = {
    x: { kind, name: '', title: '', body: el.xText.value },
    narou: { kind, name: '', title: el.nrTitle.value, body: el.nrBody.value },
    afterword: { kind, name: '', title: '', body: el.afterword.value },
  }[kind];
  editTemplate({ id: null, ...t });
}

function saveEditedTemplate() {
  const form = $('template-edit-form');
  const t = { ...editingTemplate, name: form.name.value.trim() || '無題のひな型', title: form.title.value, body: form.body.value };
  const list = templates();
  if (t.id) list[list.findIndex((x) => x.id === t.id)] = t;
  else list.push({ ...t, id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) });
  saveTemplates(list);
  if ($('templates-dialog').open) renderTemplateList();
  toast(`ひな型「${t.name}」を保存しました`);
}

function renderTemplateList() {
  const list = $('template-list');
  list.replaceChildren();
  const all = templates();
  for (const kind of KINDS) {
    const add = button(`＋ ${KIND_LABEL[kind]}のひな型を追加`, () => editTemplate({ id: null, kind, name: '', title: '', body: '' }));
    const head = li('', '');
    head.append(add);
    list.append(head);
    for (const t of all.filter((x) => x.kind === kind)) {
      const edit = button('編集', () => editTemplate(t));
      const del = button('削除', async () => {
        if (!(await ask(`ひな型「${t.name}」を削除しますか？`))) return;
        saveTemplates(templates().filter((x) => x.id !== t.id));
        renderTemplateList();
      }, 'danger');
      list.append(listItem(`${KIND_LABEL[kind]}：${t.name}`, (t.title ? t.title + ' / ' : '') + t.body.replace(/\n/g, ' ').slice(0, 60), [edit, del]));
    }
  }
}

// ---------- リンク（よく使うサイト。全作品共通） ----------

const DEFAULT_LINKS = [
  { name: '小説家になろう', url: 'https://syosetu.com/' },
  { name: 'アルファポリス', url: 'https://www.alphapolis.co.jp/' },
  { name: 'みてみん', url: 'https://mitemin.net/' },
];

// 活動報告で開くリンク（role つき）。「リンク」の一覧に必ず入っていて、消せない（URL は空でもよい）
const REPORT_LINKS = {
  x: { name: 'X', url: 'https://x.com/home' },
  narou: { name: 'なろう活動報告', url: '' },
};

function links() {
  const saved = prefs.get('links', null);
  const list = (Array.isArray(saved) ? saved : DEFAULT_LINKS).map((l) => ({ ...l }));
  // 同じ用途のリンクは1つだけ。ないものは足す（5.8 の「活動報告のリンク」の設定があれば、その URL を使う）
  const old = prefs.get('reportLinks', {}) || {};
  const seen = new Set();
  const out = list.filter((l) => {
    if (!l.role) return true;
    if (!REPORT_LINKS[l.role] || seen.has(l.role)) return false;
    seen.add(l.role);
    return true;
  });
  for (const [role, d] of Object.entries(REPORT_LINKS)) {
    if (!seen.has(role)) out.push({ name: d.name, url: normalizeUrl(old[role]) || d.url, role });
  }
  return out;
}

function reportLink(role) {
  return links().find((l) => l.role === role)?.url || '';
}

// 活動報告の「X を開く」「なろう活動報告を開く」と見出し：「リンク」に入れた URL を開くだけ
function openReportLink(role) {
  const url = reportLink(role);
  if (url) openLink(url);
  else toast(`「設定」→「リンク」で「${REPORT_LINKS[role].name}」の URL を入れてください`);
}

function renderReportLinks() {
  for (const role of Object.keys(REPORT_LINKS)) {
    const a = $(`report-link-${role}`);
    const url = normalizeUrl(reportLink(role));
    if (url) {
      a.href = url;
      a.title = `${url}（別のウインドウで開く）`;
    } else {
      a.removeAttribute('href');
      a.title = `「設定」→「リンク」で「${REPORT_LINKS[role].name}」の URL を入れると、ここから開けます`;
    }
  }
}

function normalizeUrl(url) {
  const u = (url || '').trim();
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : 'https://' + u;
}

// 別のウインドウで開く（iPad などウインドウを分けられない環境では新しいタブ）
function openLink(url) {
  window.open(normalizeUrl(url), '_blank', 'noopener,noreferrer,width=1200,height=900');
}

function buildLinksMenu() {
  const list = $('links-menu-list');
  list.replaceChildren();
  const all = links();
  if (!all.length) list.append(Object.assign(document.createElement('div'), { className: 'menu-label', textContent: 'リンクがありません' }));
  for (const l of all) {
    const b = l.url
      ? button(l.name, () => { closeMenus(); openLink(l.url); })
      : button(`${l.name}（URL 未設定）`, () => { closeMenus(); openSettings('links'); });
    b.title = l.url || '押すと「設定」→「リンク」を開きます';
    list.append(b);
  }
  list.append(document.createElement('hr'), button('リンクを編集…', () => {
    closeMenus();
    openSettings('links');
  }));
}

let editingLinks = [];
function renderLinkEditor() {
  const list = $('link-list');
  list.replaceChildren();
  editingLinks.forEach((l, i) => {
    const name = Object.assign(document.createElement('input'), { type: 'text', value: l.name, placeholder: l.role ? REPORT_LINKS[l.role].name : 'サイト名', autocomplete: 'off' });
    // type="url" だと「https://」なしの入力で保存できなくなるため text にする（保存時に補う）
    const url = Object.assign(document.createElement('input'), { type: 'text', inputMode: 'url', value: l.url, placeholder: 'https://', autocomplete: 'off', spellcheck: false });
    name.setAttribute('aria-label', 'サイト名');
    url.setAttribute('aria-label', 'URL');
    name.addEventListener('input', () => { l.name = name.value; commitLinks(); });
    url.addEventListener('input', () => { l.url = url.value; commitLinks(); });
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= editingLinks.length) return;
      [editingLinks[i], editingLinks[j]] = [editingLinks[j], editingLinks[i]];
      commitLinks();
      renderLinkEditor();
    };
    const item = document.createElement('li');
    item.append(name, url,
      button('開く', () => { if (l.url.trim()) openLink(l.url); else toast('URL を入れてください'); }, 'tool'),
      button('↑', () => move(-1), 'tool'),
      button('↓', () => move(1), 'tool'),
      // 活動報告で使うリンクは消せない（URL を空にすれば使わない）
      l.role
        ? Object.assign(document.createElement('span'), { className: 'link-role', textContent: '活動報告用', title: '活動報告の画面のボタン・見出しから開くリンクです（削除はできません）' })
        : button('削除', async () => {
          if (!(await ask(`「${l.name || l.url || '（名前なし）'}」をリンクから外しますか？`, { danger: true }))) return;
          editingLinks.splice(i, 1);
          commitLinks();
          renderLinkEditor();
        }, 'tool danger'));
    if (l.role) item.classList.add('report-role');
    list.append(item);
  });
}

// ---------- 設定 ----------

// 投稿サイトのアカウント（全作品共通・端末ごと）：{ narou: { userId, userName, author }, alpha: { ... } }
function accounts() {
  return { narou: {}, alpha: {}, ...(prefs.get('accounts', {}) || {}) };
}

// ---------- この作品と投稿サイトの作品の対応（作品データ。作品ごと・入れなくてもよい） ----------
// Nコード・作品IDと作品URLは、片方を入れると、もう片方が空（または前に自動で入れたもの）なら自動で入れる
const WORK_CODES = {
  ncode: {
    key: 'narouNcode', input: 'work-ncode', pair: 'narouUrl',
    clean: (v) => v.toLowerCase(),
    toPair: (v) => (/^n\d{4}[a-z]{1,3}$/.test(v) ? `https://ncode.syosetu.com/${v}/` : ''),
  },
  narouUrl: {
    key: 'narouUrl', input: 'narou-url', pair: 'narouNcode',
    toPair: (v) => (/(?:ncode|novel18)\.syosetu\.com\/(n\d{4}[a-z]{1,3})(?![a-z])/i.exec(v)?.[1].toLowerCase() || ''),
  },
  alpha: {
    key: 'alphaWorkId', input: 'work-alpha-id', pair: 'alphaUrl',
    // アルファの作品URLにはユーザIDも要る（設定 → 投稿サイトのユーザID）
    toPair: (v) => { const user = accounts().alpha?.userId; return /^\d+$/.test(v) && user ? `https://www.alphapolis.co.jp/novel/${user}/${v}` : ''; },
  },
  alphaUrl: {
    key: 'alphaUrl', input: 'alpha-url', pair: 'alphaWorkId',
    toPair: (v) => /alphapolis\.co\.jp\/novel\/\d+\/(\d+)/.exec(v)?.[1] || '',
  },
};
const WORK_KEY_INPUT = Object.fromEntries(Object.values(WORK_CODES).map((c) => [c.key, c.input]));

function setWorkCode(kind, value) {
  const c = WORK_CODES[kind];
  const v = (c.clean || ((s) => s))(value.trim());
  const before = project[c.key] || '';
  project[c.key] = v;
  const pair = project[c.pair] || '';
  if (!pair || pair === c.toPair(before)) {
    project[c.pair] = c.toPair(v);
    $(WORK_KEY_INPUT[c.pair]).value = project[c.pair];
  }
  renderWorkCodes();
  changed();
}

function renderWorkCodes() {
  const parts = [];
  if (project.narouNcode || project.narouUrl) parts.push(project.narouNcode || 'なろう');
  if (project.alphaWorkId || project.alphaUrl) parts.push(project.alphaWorkId ? `アルファ ${project.alphaWorkId}` : 'アルファ');
  $('work-codes-state').textContent = parts.length ? parts.join('・') : '（任意・未設定）';
  $('work-codes-state').classList.toggle('unset', !parts.length);
  $('report-url-state').textContent = `今の作品URL：なろう ${project.narouUrl || '（未設定）'}／アルファ ${project.alphaUrl || '（未設定）'}`;
}

// 同じ Nコード・作品IDが別の作品にも入っていたら知らせる（1つの投稿作品は1つの作品に対応させるため）
async function warnSameWorkCode(kind) {
  const key = WORK_CODES[kind].key;
  const v = (project[key] || '').toLowerCase();
  if (!v) return;
  const others = (await allProjects()).filter((p) => p.id !== project.id && (p[key] || '').toLowerCase() === v);
  if (!others.length) return;
  const what = kind === 'ncode' ? 'Nコード' : '作品ID';
  toast(`この${what}は「${others.map((p) => p.title || '（無題）').join('」「')}」にも入っています。別の作品なら見直してください`, true);
}

function openWorkCodes() {
  document.body.classList.add('drawer-open');
  $('work-codes').open = true;
  $('work-codes').scrollIntoView({ block: 'nearest' });
  $('work-ncode').focus();
}

function applyPrefs() {
  document.documentElement.dataset.font = uiValue('font', 'serif');
  document.documentElement.style.setProperty('--body-size', uiValue('fontSize', '18') + 'px');
  applyUiPrefs();
  scheduleFitFields();
}

// ---------- 表示（「簡易」「詳細」の2つを登録して切り替える。作品データには入れない） ----------
// prefs 'uiProfiles' = { simple: {…}, detail: {…} }、'uiActive' = 'simple' | 'detail'
// 各表示の中身：'show.foreword' などのチェックは false のときだけ隠す（未設定は表示）。font・fontSize・episodes は値。
const UI_PROFILES = { simple: '簡易', detail: '詳細' };
// 「編集機能」で出し分ける本文の上のボタン（data-max-tool の名前）
const EDIT_TOOLS = ['ruby', 'dots', 'image', 'symbols', 'indent', 'find', 'replace', 'image-list'];
// 章・エピソード（目次）の部品。以前の版の「リスト」は、これらをまとめて隠していた
const NAV_PARTS = ['nav.add-episode', 'nav.add-chapter', 'nav.grouping', 'nav.sort', 'nav.sort-dir', 'nav.search'];
// 「簡易」の初期値（最初に作るときだけ使う。あとは自由に変えられる）
const SIMPLE_PRESET = {
  'show.foreword': false, 'show.afterword': false,
  'copy.ep-title': false, 'copy.foreword': false, 'copy.afterword': false, 'copy.free-memo': false, 'copy.main-to-sub': false,
  'max.title': false, 'max.foreword': false, 'max.afterword': false,
  'editor.links': false,
  'show.report': false, 'novel.workcodes': false,
  'count.novel-title': false, 'count.ep-title': false, 'count.foreword': false, 'count.afterword': false, 'count.plot': false, 'count.free-memo': false,
  episodes: 'list',
};
let uiEditing = null; // 設定画面で編集している表示

function uiProfiles() {
  let all = prefs.get('uiProfiles', null);
  if (!all || typeof all !== 'object') {
    // 以前の版の表示設定は「詳細」に引き継ぐ
    const detail = { ...(prefs.get('ui', {}) || {}), font: prefs.get('font', 'serif'), fontSize: prefs.get('fontSize', '18'), episodes: 'full' };
    all = { simple: { ...detail, ...SIMPLE_PRESET }, detail };
    prefs.set('uiProfiles', all);
  }
  const out = { simple: {}, detail: {}, ...all };
  // 6.0 より前の「目次の活動報告」を隠していた表示は、「活動報告タブ」も隠す
  for (const k of Object.keys(UI_PROFILES)) {
    if (out[k]['show.report'] === undefined && out[k]['novel.report'] === false) out[k] = { ...out[k], 'show.report': false };
    // 7.7.2 より前の「リスト」は、＋話・＋章・並べ替え・検索をまとめて隠していた。見た目を変えないよう、個別の設定にする
    if (out[k].episodes === 'list' && NAV_PARTS.every((p) => out[k][p] === undefined)) {
      out[k] = { ...out[k], ...Object.fromEntries(NAV_PARTS.map((p) => [p, false])) };
    }
  }
  return out;
}

function uiActive() {
  const a = prefs.get('uiActive', 'detail');
  return a in UI_PROFILES ? a : 'detail';
}

function uiPref(key, profile = uiActive()) {
  return uiProfiles()[profile][key] !== false;
}

function uiValue(key, fallback, profile = uiActive()) {
  return uiProfiles()[profile][key] ?? fallback;
}

function setUiPref(key, value, profile = uiEditing || uiActive()) {
  const all = uiProfiles();
  all[profile] = { ...all[profile], [key]: value };
  prefs.set('uiProfiles', all);
  if (profile === uiActive()) applyPrefs();
}

function setUiActive(profile) {
  prefs.set('uiActive', profile);
  applyPrefs();
  renderUiProfileEditor(profile); // 選んだ表示を、そのまま編集できるようにする
  toast(`表示を「${UI_PROFILES[profile]}」にしました`);
}

// 設定画面の「表示」タブ：編集している表示の値を入れる
function renderUiProfileEditor(profile = uiEditing || uiActive()) {
  uiEditing = profile;
  const active = uiActive();
  document.querySelectorAll('[name="ui-active"]').forEach((r) => { r.checked = r.value === active; });
  document.querySelectorAll('[data-ui]').forEach((c) => { c.checked = uiPref(c.dataset.ui, profile); });
  const defaults = { font: 'serif', fontSize: '18', episodes: 'full' };
  document.querySelectorAll('[data-uiv]').forEach((s) => { s.value = String(uiValue(s.dataset.uiv, defaults[s.dataset.uiv], profile)); });
  $('ui-prof-note').textContent = `「${UI_PROFILES[profile]}」の表示項目を設定しています。変更はすぐに画面へ反映されます。`;
}

// 表示・非表示を切り替える部品（キー → 要素）
const UI_TARGETS = {
  'editor.file': () => document.querySelector('.actions details.menu:not(#links-menu)'),
  'editor.links': () => $('links-menu'),
  'novel.synopsis': () => document.querySelector('.nav-item[data-view="synopsis"]'),
  'novel.outline': () => document.querySelector('.nav-item[data-view="outline"]'),
  'novel.world': () => document.querySelector('.nav-item[data-view="world"]'),
  'novel.characters': () => document.querySelector('.nav-item[data-view="characters"]'),
  'novel.project-memo': () => document.querySelector('.nav-item[data-view="project-memo"]'),
  'novel.workcodes': () => $('work-codes'),
  'show.report': () => $('report-tab'),
  'nav.add-episode': () => document.querySelector('.nav-add [data-action="add-episode"]'),
  'nav.add-chapter': () => document.querySelector('.nav-add [data-action="add-chapter"]'),
  'nav.grouping': () => $('ep-grouping'),
  'nav.sort': () => $('ep-sort'),
  'nav.sort-dir': () => $('ep-sort-dir'),
  'nav.search': () => document.querySelector('.ep-search'),
  ...Object.fromEntries(['novel-title', 'ep-title', 'body', 'foreword', 'afterword', 'plot', 'free-memo', 'synopsis', 'project-memo', 'x', 'narou-report-title', 'narou-report-body']
    .map((k) => ['count.' + k, () => $('count-' + k)])),
  ...Object.fromEntries(['ep-title', 'body', 'foreword', 'afterword', 'plot', 'free-memo', 'project-memo', 'x-text', 'narou-report-title', 'narou-report-body']
    .map((k) => ['selall.' + k, () => document.querySelector(`[data-selall="${k}"]`)])),
};

function applyUiPrefs() {
  for (const [key, target] of Object.entries(UI_TARGETS)) target()?.classList.toggle('ui-off', !uiPref(key));
  // 隠した画面を開いていたら、エピソードの画面へ
  const viewKey = { synopsis: 'novel.synopsis', outline: 'novel.outline', world: 'novel.world', characters: 'novel.characters', 'project-memo': 'novel.project-memo' }[view];
  if (viewKey && project && !uiPref(viewKey)) setView('episode');
  if (reportMode && !uiPref('show.report')) setReportMode(false);
  document.body.classList.toggle('ep-list-mode', uiValue('episodes', 'full') === 'list');
  // iPhone の「簡易」表示では、左の一覧を開くボタンを「作品」と呼ぶ（作品の資料とエピソードを選ぶ場所のため）
  const drawerName = isIPhone() && uiActive() === 'simple' ? '作品' : '目次';
  const drawerBtn = document.querySelector('.drawer-toggle');
  drawerBtn.textContent = `☰ ${drawerName}`;
  drawerBtn.setAttribute('aria-label', drawerName);
  const cls = document.body.classList;
  for (const f of ['foreword', 'afterword', 'plot', 'memo']) cls.toggle('hide-' + f, !uiPref('show.' + f));
  cls.toggle('hide-side', !uiPref('show.plot') && !uiPref('show.memo'));
  for (const k of ['novel-title', 'ep-title', 'body', 'foreword', 'afterword', 'plot', 'free-memo', 'synopsis', 'project-memo',
    'plot-from-other', 'free-memo-from-other', 'x-text', 'narou-report-title', 'narou-report-body', 'main-to-sub']) {
    cls.toggle('hide-copy-' + k, !uiPref('copy.' + k));
  }
  for (const k of ['title', 'body', 'foreword', 'afterword', 'plot', 'memo']) cls.toggle('hide-max-' + k, !uiPref('max.' + k));
  document.querySelectorAll('[data-max-tool]').forEach((tool) => {
    tool.classList.toggle('max-tool-off', !uiPref(`max.tool.${tool.dataset.maxTool}`));
    // 編集機能（最大化していないとき）：ルビ〜画像だけ。全て選択・コピーなどは別のグループで設定する
    tool.classList.toggle('edit-tool-off', EDIT_TOOLS.includes(tool.dataset.maxTool) && !uiPref(`tool.${tool.dataset.maxTool}`));
  });
  cls.toggle('hide-nav-ep-menu', !uiPref('nav.ep-menu'));
  cls.toggle('hide-help-labels', !uiPref('other.hints'));
  cls.toggle('hide-status', !uiPref('other.status'));
  // プロット・メモの欄が隠れている状態でそのタブを開いていたら本文へ
  if (cls.contains('hide-side') && document.querySelector('[data-tab="side"][aria-selected="true"]')) selectTab('body');
}

// 左の作品情報メニューは、利用者が決めた順番を環境設定として保存する。
const PROJECT_NAV_DEFAULT = ['synopsis', 'outline', 'world', 'characters', 'project-memo'];
function applyProjectNavOrder() {
  const box = $('project-nav');
  const saved = prefs.get('nav.projectOrder', []);
  const order = [...new Set([...(Array.isArray(saved) ? saved : []), ...PROJECT_NAV_DEFAULT])]
    .filter((key) => PROJECT_NAV_DEFAULT.includes(key));
  for (const key of order) {
    const item = box.querySelector(`[data-view="${key}"]`);
    if (item) box.append(item);
  }
}
function saveProjectNavOrder() {
  prefs.set('nav.projectOrder', [...$('project-nav').querySelectorAll('.nav-item')].map((item) => item.dataset.view));
}
function bindProjectNavOrder() {
  const box = $('project-nav');
  let moving = null;
  box.addEventListener('dragstart', (e) => {
    moving = e.target.closest('.nav-item');
    if (!moving) return;
    moving.classList.add('nav-dragging');
    e.dataTransfer.effectAllowed = 'move';
  });
  box.addEventListener('dragover', (e) => {
    if (!moving) return;
    e.preventDefault();
    const over = e.target.closest('.nav-item');
    if (!over || over === moving) return;
    const after = e.clientY > over.getBoundingClientRect().top + over.offsetHeight / 2;
    box.insertBefore(moving, after ? over.nextSibling : over);
  });
  box.addEventListener('dragend', () => {
    if (!moving) return;
    moving.classList.remove('nav-dragging');
    moving = null;
    saveProjectNavOrder();
  });
}

// ---------- 入力欄の最大化 ----------

const MAX_LABELS = { title: 'エピソードタイトル', body: '本文', foreword: '前書き', afterword: '後書き', plot: 'プロット', memo: 'フリーメモ' };
let maximized = null; // { box, input }

// iPhone だけの設定：最大化したときの入力欄の高さ（キーボードの上の部分に隠れないように）
//   prefs 'iphone.maxHeight' = { mode: 'auto'（見えている範囲いっぱい）| 'half'（画面の縦の半分）| 'px', px }
const isIPhone = () => /iPhone|iPod/.test(navigator.userAgent);
const IPHONE_MAX_DEFAULT = { mode: 'auto', px: 360 };

function iphoneMaxHeight() {
  if (!isIPhone()) return null;
  const s = { ...IPHONE_MAX_DEFAULT, ...prefs.get('iphone.maxHeight', {}) };
  const screenH = window.innerHeight || document.documentElement.clientHeight;
  if (s.mode === 'half') return Math.round(screenH / 2);
  if (s.mode === 'px') return Math.min(screenH, Math.max(120, Number(s.px) || IPHONE_MAX_DEFAULT.px));
  return null;
}

function renderIphoneMaxSettings() {
  $('iphone-max').hidden = !isIPhone();
  const s = { ...IPHONE_MAX_DEFAULT, ...prefs.get('iphone.maxHeight', {}) };
  $('iphone-max-mode').value = s.mode;
  $('iphone-max-px').value = String(s.px);
  $('iphone-max-px-row').hidden = s.mode !== 'px';
}

function saveIphoneMaxSettings() {
  const px = Math.min(2000, Math.max(120, Number($('iphone-max-px').value) || IPHONE_MAX_DEFAULT.px));
  prefs.set('iphone.maxHeight', { mode: $('iphone-max-mode').value, px });
  $('iphone-max-px-row').hidden = $('iphone-max-mode').value !== 'px';
  fitVisualViewport();
}

function fitVisualViewport() {
  const vv = window.visualViewport;
  // 最大化中の iPhone で高さを決めてあれば、キーボードが出ている間だけその高さにする（閉じたら画面いっぱいに戻す）
  const custom = maximized && keyboardOpen ? iphoneMaxHeight() : null;
  document.body.classList.toggle('max-custom-height', !!custom);
  const height = custom || vv?.height || window.innerHeight || document.documentElement.clientHeight;
  const width = vv?.width || window.innerWidth || document.documentElement.clientWidth;
  document.documentElement.style.setProperty('--vv-height', Math.round(height) + 'px');
  document.documentElement.style.setProperty('--vv-width', Math.round(width) + 'px');
  document.documentElement.style.setProperty('--vv-top', Math.round(vv?.offsetTop || 0) + 'px');
  document.documentElement.style.setProperty('--vv-left', Math.round(vv?.offsetLeft || 0) + 'px');
}

// ---------- 画面のキーボードと、入力欄の高さ合わせ ----------
// キーボードが出ているか：見えている範囲（visualViewport）が、入力中に画面より大きく縮んだとき。
//   ・拡大（ピンチ）は scale をかけて除く ・回転は画面の高さも一緒に変わるので差が出ない
//   ・iPad のフローティングキーボード・外付けキーボードは、ほとんど縮まないので「出ていない」として扱う
// 出たり消えたりの途中でちらつかないよう、出たと見なす幅と消えたと見なす幅に差を付け、動きが落ち着いてから決める
let keyboardOpen = false;
let keyboardTimer = null;
function isTextInput(node) {
  return !!node?.matches?.('textarea, input:not([type]), input[type="text"], input[type="search"], input[type="url"], input[type="number"], [contenteditable="true"]');
}
function checkKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const full = window.innerHeight || document.documentElement.clientHeight;
  const covered = full - vv.height * (vv.scale || 1);
  const typing = isTextInput(document.activeElement);
  const open = typing && (keyboardOpen ? covered > 60 : covered > Math.max(120, full * 0.18));
  // 入力中の欄に印を付ける（キーボードの上に見えている高さに収める。:focus はアプリが裏に回ると外れるため使わない）
  document.querySelectorAll('.kb-target').forEach((x) => { if (!open || x !== document.activeElement) x.classList.remove('kb-target'); });
  if (open && document.activeElement?.tagName === 'TEXTAREA') document.activeElement.classList.add('kb-target');
  if (open === keyboardOpen) return;
  keyboardOpen = open;
  document.body.classList.toggle('keyboard-open', open);
  fitVisualViewport();
  scheduleFitFields();
  // 出たときは、入力中の欄がキーボードに隠れないよう見える位置へ
  if (open && !maximized) setTimeout(() => document.activeElement?.scrollIntoView?.({ block: 'nearest' }), 50);
}
function scheduleKeyboardCheck(delay = 120) {
  clearTimeout(keyboardTimer);
  keyboardTimer = setTimeout(checkKeyboard, delay);
}

// 狭い画面の「プロット・メモ」タブ：プロットとフリーメモで、見えている高さを分け合う（境目で決めた比率どおり）。
// 折りたたみ・表示の切り替え・画面の回転・大きさの変更・表示（簡易／詳細）の切り替え・最大化の解除のたびに計算し直す。
// キーボードが出ている間は計算し直さない（入力中に欄の大きさが動かないように）
let fitFrame = 0;
let fitTimer = null;
function scheduleFitFields() {
  // 描画の直前にまとめて1回だけ計算する（描画が止まっているときのために、少し待つ予備も置く）
  cancelAnimationFrame(fitFrame);
  clearTimeout(fitTimer);
  const run = () => { cancelAnimationFrame(fitFrame); clearTimeout(fitTimer); fitSideFields(); };
  fitFrame = requestAnimationFrame(run);
  fitTimer = setTimeout(run, 100);
}
function fitSideFields() {
  const pane = document.querySelector('.pane-side');
  const view = $('view-episode');
  if (!pane || !view) return;
  const narrow = window.matchMedia('(max-width: 899px)').matches;
  if (!narrow || view.hidden || !pane.classList.contains('active')) { pane.style.removeProperty('--side-avail'); pane.classList.remove('side-fit'); return; }
  if (keyboardOpen) return;
  // 狭い画面では上の欄（稿・タイトルなど）で画面の多くが埋まるので、編集エリアの1画面分を分け合う（スクロールすると全体が見える）
  const avail = Math.max(320, Math.floor(view.clientHeight - 8));
  pane.style.setProperty('--side-avail', avail + 'px');
  pane.classList.add('side-fit');
}
function maximizeField(field) {
  if (maximized) restoreMaximized();
  if (isFolded(field)) setFolded(field, false); // 折りたたんだ欄は開いてから最大化する
  let box = document.querySelector(`.mx[data-field="${field}"]`);
  if (!box) return;
  // 前書き・後書きは開いてから中身を最大化する
  if (box.tagName === 'DETAILS') {
    box.open = true;
    box = box.querySelector('.extra-body');
    box.dataset.maxLabel = MAX_LABELS[field];
  }
  // 狭い画面でタブに隠れている欄は、そのタブを開いておく
  const pane = box.closest('[data-pane]');
  if (pane) selectTab(pane.dataset.pane);
  const input = box.querySelector('textarea, input');
  const { selectionStart: s, selectionEnd: e, scrollTop } = input;
  box.classList.add('maximized');
  document.body.classList.add('maximizing');
  $('max-restore').hidden = false;
  maximized = { box, input };
  // Android などの「戻る」で元に戻せるよう、履歴を1つ積む
  history.pushState({ novelEditorMax: field }, '');
  input.focus({ preventScroll: true });
  input.setSelectionRange(s, e);
  input.scrollTop = scrollTop;
  // iPhone / Android はキーボードの表示途中にも表示領域が変わるため、段階的に再計測する
  fitVisualViewport();
  [50, 250, 600].forEach((ms) => setTimeout(() => {
    if (maximized?.input === input) fitVisualViewport();
  }, ms));
}

function restoreMaximized(fromHistory = false) {
  if (!maximized) return;
  const { box, input } = maximized;
  const { selectionStart: s, selectionEnd: e } = input;
  box.classList.remove('maximized');
  document.body.classList.remove('maximizing');
  $('max-restore').hidden = true;
  maximized = null;
  if (!fromHistory && history.state?.novelEditorMax) history.back();
  input.focus({ preventScroll: true });
  input.setSelectionRange(s, e);
  fitVisualViewport();
  scheduleFitFields();
}

function selectSettingsTab(name) {
  if (!document.querySelector(`[data-spanel="${name}"]`)) name = 'display';
  document.querySelectorAll('[data-stab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.stab === name)));
  document.querySelectorAll('[data-spanel]').forEach((p) => { p.hidden = p.dataset.spanel !== name; });
  // 狭い画面ではタブが横にスクロールするので、選んだタブを見える位置に
  document.querySelector(`[data-stab="${name}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  prefs.set('settingsTab', name);
  if (name === 'backup') {
    renderProjectVersions().catch(fail);
    renderSyncState();
    meta.get('preSyncBackup').then((v) => { $('sync-presync-row').hidden = !v; }).catch(() => {});
  }
  if (name === 'cloud') renderCloudActions();
}

function openSettings(tab = prefs.get('settingsTab', 'display')) {
  const form = $('settings-form');
  renderUiProfileEditor(uiActive()); // 開いたときは、今使っている表示を編集する
  form.autoBackupInterval.value = String(sync.intervalMin());
  form.autoBackupKeep.value = String(sync.keepCount());
  form.projectVersionKeep.value = String(autoVersionKeep());
  renderFileDestination();
  renderIphoneMaxSettings();
  $('sync-prefix').value = prefs.get('sync.prefix', '') || '';
  $('sync-prefix').placeholder = `${sync.defaultPrefix()}（この端末の既定）`;
  // 投稿サイトのアカウント（端末ごと）
  const acc = accounts();
  form.querySelectorAll('[name^="acc."]').forEach((input) => {
    const [, site, key] = input.name.split('.');
    input.value = acc[site]?.[key] || '';
  });
  const box = $('provider-settings');
  box.querySelectorAll(':scope > :not(legend)').forEach((n) => n.remove());
  // 利用できるクラウドの接続IDだけ出す（もう一方の設定も消さずに残っている）
  const selectedCloud = activeProvider();
  box.querySelector('legend').textContent = selectedCloud ? `${selectedCloud.label}：ドライブの接続の設定` : 'ドライブの接続の設定';
  if (!selectedCloud) box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '「利用できるクラウド」でGoogle DriveまたはOneDriveを選ぶと、ここに接続IDの設定欄を表示します。' }));
  for (const p of selectedCloud ? [selectedCloud] : []) {
    for (const s of p.settings) {
      const label = document.createElement('label');
      label.textContent = s.label;
      const input = Object.assign(document.createElement('input'), {
        type: 'text', name: s.key, value: prefs.get(s.key, ''), placeholder: s.placeholder || '', autocomplete: 'off', spellcheck: false,
      });
      // 入れ終わった（欄を離れた・Enter）時点で反映する
      input.addEventListener('change', () => { commitProviderSetting(p, s.key, input.value); renderFileDestination(); });
      label.append(input);
      box.append(label);
      if (s.hint) box.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: s.hint }));
    }
  }
  editingLinks = structuredClone(links());
  renderLinkEditor();
  selectSettingsTab(tab);
  $('settings-dialog').showModal();
}

// ---------- 設定はすべて、変えた時点で反映・保存する（設定画面は「閉じる」だけ） ----------

// 「ファイル」メニューの保存先：クラウドを設定していなければ「この端末・その他」だけ
function renderFileDestination() {
  const dest = $('file-destination');
  const hasDrive = !!driveProvider();
  const cloudOpt = dest.querySelector('option[value="cloud"]');
  cloudOpt.textContent = `${cloudDestinationLabel()}だけを使う`;
  dest.querySelector('option[value="ask"]').disabled = !hasDrive;
  cloudOpt.disabled = !hasDrive;
  dest.value = hasDrive ? oldCloud(prefs.get(DEST_KEY, 'ask')) : 'local';
  $('file-destination-hint').textContent = hasDrive ? `クラウド保存先：${cloudDestinationLabel()}です。`
    : `利用できるクラウドがないか、接続IDが未設定です（「クラウド」タブで設定できます）。今は「この端末・その他」を使います。`;
}

// リンク：入力中の行（URL が空のもの）は一覧に入れず、URL が入った行だけを残す
function commitLinks() {
  prefs.set('links', editingLinks
    .map((l) => ({ name: l.name.trim(), url: normalizeUrl(l.url), ...(l.role ? { role: l.role } : {}) }))
    .filter((l) => l.url || l.role)
    .map((l) => ({ ...l, name: l.name || (l.role ? REPORT_LINKS[l.role].name : l.url) })));
  renderReportLinks();
}

function commitAccounts() {
  const acc = { narou: {}, alpha: {} };
  $('settings-form').querySelectorAll('[name^="acc."]').forEach((input) => {
    const [, site, key] = input.name.split('.');
    acc[site][key] = input.value.trim();
  });
  prefs.set('accounts', acc);
}

// クラウド接続（クライアントID・API キー）：変わったらログインし直しになる
function commitProviderSetting(p, key, value) {
  const v = value.trim();
  if (v === prefs.get(key, '')) return;
  prefs.set(key, v);
  p.signOut();
  p.preload();
  renderCloudActions();
  sync.refresh().then(renderSyncState).catch(() => {});
  toast(v ? '接続の設定を変えました（ログインし直してください）' : '接続の設定を消しました');
}

function bindSettingsInputs() {
  const form = $('settings-form');
  form.autoBackupInterval.addEventListener('change', () => {
    prefs.set('autoBackupInterval', Number(form.autoBackupInterval.value) || sync.DEFAULT_INTERVAL_MIN);
    renderSyncState();
  });
  form.autoBackupKeep.addEventListener('change', () => {
    const n = Math.min(2000, Math.max(10, Number(form.autoBackupKeep.value) || sync.DEFAULT_KEEP));
    form.autoBackupKeep.value = String(n);
    prefs.set('autoBackupKeep', n);
    renderSyncState();
  });
  form.projectVersionKeep.addEventListener('change', async () => {
    const n = Math.min(500, Math.max(1, Number(form.projectVersionKeep.value) || DEFAULT_AUTO_VERSION_KEEP));
    form.projectVersionKeep.value = String(n);
    prefs.set('projectVersionKeep', n);
    await trimAutoVersions();
    await renderProjectVersions();
    toast(`自動履歴を作品ごとに最新${n}件まで残します`);
  });
  $('sync-prefix').addEventListener('change', (e) => {
    const v = sync.cleanPrefix(e.target.value.trim());
    e.target.value = v;
    prefs.set('sync.prefix', v);
    renderSyncState();
  });
  // 使うクラウド（Google ドライブ／OneDrive）
  $('cloud-provider').addEventListener('change', (e) => changeCloudProvider(e.target.value).catch(fail));
  $('cloud-login').addEventListener('click', () => loginCloud().catch(fail));
  $('file-destination').addEventListener('change', (e) => { if (driveProvider()) prefs.set(DEST_KEY, e.target.value); });
  form.querySelectorAll('[name^="acc."]').forEach((input) => input.addEventListener('input', commitAccounts));
}

// ---------- イベント ----------

// メニューが、スクロールする枠（目次など）や画面の下からはみ出すなら、上向きに開く
function placeMenu(d) {
  const list = d.querySelector('.menu-list');
  if (!list) return;
  list.classList.remove('up');
  let box = d.parentElement;
  while (box && box !== document.body && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
  const limit = box && box !== document.body ? box.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const bottom = Math.min(limit.bottom, window.innerHeight);
  const top = Math.max(limit.top, 0);
  const r = list.getBoundingClientRect();
  const s = d.getBoundingClientRect();
  if (r.bottom > bottom && s.top - top > bottom - s.bottom) list.classList.add('up');
}

function closeMenus(except) {
  document.querySelectorAll('details.menu[open]').forEach((d) => { if (d !== except) d.open = false; });
}

// Ctrl+S／⌘S：「保存」ボタンと同じ
function quickSave() {
  return saveNow();
}

/**
 * 「保存」ボタン：今の内容を、全端末で共有する自動バックアップに残す（毎回、新しいバックアップを1つ足す）。
 * ・保存先が決まっていない → 案内して「設定」→「自動バックアップ」を開く
 * ・Google ドライブのログイン切れ・フォルダの許可切れ → ログイン（許可）してから続ける
 * ・他の端末のほうが新しい → 保存せずに「どちらの記録を使うか」を聞く
 * ・変更がない → 保存しない（最後に保存した時刻を知らせる）
 * 書いた内容そのものは、これとは別に端末の中へ自動で保存されている。
 */
async function saveNow() {
  if (manualServerSaving) return; // 押し直し・Ctrl+S の連打で二重に保存しない
  manualServerSaving = true;
  const btn = $('sync-save-btn');
  btn?.classList.add('task-running');
  updateStatus();
  try {
  await flush();
  let st = sync.getState();
  if (st === 'off' || st === 'unsupported' || st === 'need-folder') {
    toast('保存先が決まっていません。「自動バックアップ」の保存先とフォルダを選んでください（書いた内容は端末の中に自動で保存されています）', true);
    openSettings('backup');
    return;
  }
  if (st === 'need-login' || st === 'need-permission') {
    const ok = await sync.resume(); // Google ドライブ（ホーム画面のアプリ）では、ここでページごと Google へ移動する
    if (!ok) { toast(st === 'need-login' ? 'ログインできませんでした' : '書き込みが許可されませんでした', true); return; }
    st = sync.getState();
  }
  // 他の端末の更新をまだ確かめていない・「あとで」と答えたまま → 先に確かめる
  if (syncPending || !sync.isChecked()) {
    await runSyncCheck({ manual: !!syncPending });
    if (syncPending || !sync.isChecked()) return;
  }
  const ok = await withBusy('保存中…', () => sync.backupNow({ build: () => buildEpisodeBackup('manual-episode', currentSyncTarget()) }));
  if (ok) toast(`保存が完了しました\n表示中のエピソード → ${sync.folderName()}`);
  else if (sync.isChecked() && sync.getState() === 'on') toast('保存できませんでした：' + (sync.getError() || '保存先を確認してください') + '\nもう一度「編集エピソード保存」を押すとやり直せます', true);
  // 他の端末のほうが新しかったときは、sync.onNewer から確認の画面が出る
  } finally {
    manualServerSaving = false;
    btn?.classList.remove('task-running');
    updateStatus();
  }
}

// ---------- 他のエピソードからプロット・フリーメモをコピー ----------

function updateEpisodeNotesCopyPreview() {
  const source = project?.episodes.find((ep) => ep.id === $('episode-notes-copy-source').value);
  const plot = $('episode-notes-copy-plot');
  const memo = $('episode-notes-copy-memo');
  const preview = $('episode-notes-copy-preview');
  if (!source) {
    plot.disabled = memo.disabled = true;
    preview.textContent = 'コピーできるエピソードがありません。';
    return;
  }
  plot.disabled = !source.plot;
  memo.disabled = !source.freeMemo;
  if (plot.disabled) plot.checked = false;
  if (memo.disabled) memo.checked = false;
  preview.textContent = [
    `プロット：${source.plot ? `${countChars(source.plot).all.toLocaleString()}字` : '（空）'}`,
    `フリーメモ：${source.freeMemo ? `${countChars(source.freeMemo).all.toLocaleString()}字` : '（空）'}`,
    '',
    source.plot ? `【プロット】\n${source.plot.slice(0, 500)}` : '',
    source.freeMemo ? `【フリーメモ】\n${source.freeMemo.slice(0, 500)}` : '',
  ].filter(Boolean).join('\n');
}

function openEpisodeNotesCopy() {
  const current = episode();
  const sources = project.episodes.filter((ep) => ep.id !== current.id && (ep.plot || ep.freeMemo));
  if (!sources.length) {
    toast('プロットまたはフリーメモが入っている、ほかのエピソードがありません', true);
    return;
  }
  const select = $('episode-notes-copy-source');
  select.replaceChildren(...sources.map((ep) => {
    const i = project.episodes.indexOf(ep);
    const has = [ep.plot && 'プロット', ep.freeMemo && 'メモ'].filter(Boolean).join('・');
    return new Option(`${i + 1}. ${episodeName(ep)}（${has}あり）`, ep.id);
  }));
  $('episode-notes-copy-plot').checked = true;
  $('episode-notes-copy-memo').checked = true;
  updateEpisodeNotesCopyPreview();
  $('episode-notes-copy-dialog').showModal();
}

async function copyEpisodeNotes() {
  const source = project.episodes.find((ep) => ep.id === $('episode-notes-copy-source').value);
  const dest = episode();
  const copyPlot = $('episode-notes-copy-plot').checked && !$('episode-notes-copy-plot').disabled;
  const copyMemo = $('episode-notes-copy-memo').checked && !$('episode-notes-copy-memo').disabled;
  if (!source || (!copyPlot && !copyMemo)) {
    toast('コピーする内容を選んでください', true);
    return;
  }
  const overwritten = [copyPlot && dest.plot && 'プロット', copyMemo && dest.freeMemo && 'フリーメモ'].filter(Boolean);
  if (overwritten.length && !(await ask(`現在のエピソードの${overwritten.join('と')}を、\n「${episodeName(source)}」の内容で置き換えますか？`, { ok: '置き換えてコピー' }))) return;
  if (copyPlot) dest.plot = source.plot;
  if (copyMemo) dest.freeMemo = source.freeMemo;
  touchEpisode(dest);
  changed();
  showEpisode();
  toast(`「${episodeName(source)}」から${[copyPlot && 'プロット', copyMemo && 'フリーメモ'].filter(Boolean).join('と')}をコピーしました`);
}

const actions = {
  'toggle-drawer': () => document.body.classList.toggle('drawer-open'),
  'open-work-codes': openWorkCodes,
  library: openLibrary,
  'new-project': createProject,
  settings: () => openSettings(),
  'all-open': () => allOpen(),
  'all-save-as': () => allSaveAs(),
  'backup-pack-create': () => openBackupPackCreate().catch(fail),
  'backup-pack-open': () => openBackupPackFile().catch(fail),
  'sync-save': () => saveNow(),
  'copy-episode-notes': openEpisodeNotesCopy,
  'ep-open': () => epOpen(),
  'ep-save-as': () => epSaveAs(),
  'import-text': importText,
  'export-episode': exportEpisode,
  'export-all': exportAll,
  'add-episode': () => addEpisode(),
  'add-chapter': addChapterFromList,
  'ep-version-up': episodeVersionUp,
  'ep-version-delete': deleteEpisodeVersion,
  'open-report': () => setReportMode(true),
  'max-restore': () => restoreMaximized(),
  'copy-main-to-sub': openSiteCopy,
  'open-import': () => importScreen.open(),
  'toggle-sort-dir': () => setEpisodeSort({ dir: epSort.dir === 'asc' ? 'desc' : 'asc' }),
  'project-version-save': openVersionSave,
  'manage-templates': () => { renderTemplateList(); $('templates-dialog').showModal(); },
  'open-x': () => openReportLink('x'),
  'open-narou-report': () => openReportLink('narou'),
  'auto-indent': runAutoIndent,
  replace: openReplace,
  undo: () => undoRedo('undo'),
  redo: () => undoRedo('redo'),
  'sync-attention': resolveSyncAttention,
};

// 元に戻す／やり直す：最後に入力していた欄に対して、ブラウザ標準の取り消し履歴を使う
let lastEditable = null;
function undoRedo(cmd) {
  const t = lastEditable && document.contains(lastEditable) ? lastEditable : el.body;
  t.focus();
  const before = t.value;
  document.execCommand(cmd);
  if (t.value === before) toast(cmd === 'undo' ? 'これ以上戻せません' : 'やり直す操作がありません');
}

const inserts = { ruby: insertRuby, dots: insertDots, image: openImageDialog };

// フォーム内のキャンセルボタン（type="button" value="cancel"）でダイアログを閉じる
function bindDialog(id, onOk) {
  const dialog = $(id);
  dialog.addEventListener('click', (e) => {
    if (e.target.matches('button[value="cancel"]')) dialog.close('cancel');
  });
  // 決定ボタンで送信された時点で処理する（close イベントは描画のタイミングまで遅れることがあるため）
  if (onOk) {
    dialog.querySelector('form').addEventListener('submit', (e) => {
      if (['ok', 'save'].includes(e.submitter?.value)) Promise.resolve().then(onOk).catch(fail);
    });
  }
}

// 本文とプロットの境目をドラッグして幅を変える（比率は端末に記憶）
const SPLIT_DEFAULT = 2 / 3;
function applySplit(ratio) {
  const r = Math.min(0.85, Math.max(0.25, ratio));
  const panes = document.querySelector('.panes');
  panes.style.setProperty('--split-body', `${r}fr`);
  panes.style.setProperty('--split-plot', `${1 - r}fr`);
  return r;
}

function bindSplitter() {
  const splitter = $('splitter');
  const panes = document.querySelector('.panes');
  applySplit(prefs.get('split', SPLIT_DEFAULT));
  let ratio = null;
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    ratio = prefs.get('split', SPLIT_DEFAULT);
  });
  splitter.addEventListener('pointermove', (e) => {
    if (ratio === null) return;
    const rect = panes.getBoundingClientRect();
    ratio = applySplit((e.clientX - rect.left) / rect.width);
  });
  const end = () => {
    if (ratio === null) return;
    prefs.set('split', ratio);
    ratio = null;
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('dblclick', () => { prefs.set('split', applySplit(SPLIT_DEFAULT)); });
  bindSidebarSplitter();
  bindPlotMemoSplitter();
}

// プロットとフリーメモの境目を上下にドラッグして、高さの比率を変える（端末ごとに記憶）
const PLOT_MEMO_DEFAULT = 0.5;
function applyPlotMemoSplit(value) {
  const ratio = Math.min(.85, Math.max(.15, Number(value) || PLOT_MEMO_DEFAULT));
  const pane = document.querySelector('.pane-side');
  pane.style.setProperty('--plot-share', String(ratio));
  pane.style.setProperty('--memo-share', String(1 - ratio));
  return ratio;
}

function bindPlotMemoSplitter() {
  const splitter = $('plot-memo-splitter');
  const pane = document.querySelector('.pane-side');
  applyPlotMemoSplit(prefs.get('plotMemoSplit', PLOT_MEMO_DEFAULT));
  let ratio = null;
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing-y');
    ratio = prefs.get('plotMemoSplit', PLOT_MEMO_DEFAULT);
  });
  splitter.addEventListener('pointermove', (e) => {
    if (ratio === null) return;
    const rect = pane.getBoundingClientRect();
    ratio = applyPlotMemoSplit((e.clientY - rect.top) / Math.max(1, rect.height));
  });
  const end = () => {
    if (ratio === null) return;
    prefs.set('plotMemoSplit', ratio);
    ratio = null;
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing-y');
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('dblclick', () => prefs.set('plotMemoSplit', applyPlotMemoSplit(PLOT_MEMO_DEFAULT)));
}

// 目次（左）とエディターの境目をドラッグして、目次の幅を変える（端末に記憶）
const SIDEBAR_DEFAULT = 280;
function applySidebarWidth(px) {
  // 狭すぎ・広すぎにならないように（エディターに 360px は残す）
  const max = Math.max(200, Math.min(640, window.innerWidth - 360));
  const w = Math.round(Math.min(max, Math.max(200, px)));
  document.querySelector('.workspace').style.setProperty('--sidebar-w', `${w}px`);
  return w;
}

function bindSidebarSplitter() {
  const splitter = $('sidebar-splitter');
  const workspace = document.querySelector('.workspace');
  applySidebarWidth(prefs.get('sidebarWidth', SIDEBAR_DEFAULT));
  let width = null;
  splitter.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitter.setPointerCapture(e.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    width = prefs.get('sidebarWidth', SIDEBAR_DEFAULT);
  });
  splitter.addEventListener('pointermove', (e) => {
    if (width === null) return;
    width = applySidebarWidth(e.clientX - workspace.getBoundingClientRect().left);
  });
  const end = () => {
    if (width === null) return;
    prefs.set('sidebarWidth', width);
    width = null;
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('dblclick', () => { prefs.set('sidebarWidth', applySidebarWidth(SIDEBAR_DEFAULT)); });
  // 画面の幅が変わったら、はみ出さないように合わせ直す
  window.addEventListener('resize', () => applySidebarWidth(prefs.get('sidebarWidth', SIDEBAR_DEFAULT)));
}

function bindEvents() {
  $('busy-dialog').addEventListener('cancel', (e) => e.preventDefault());
  bindProjectNavOrder();
  for (const [input, apply] of bindings) {
    input.addEventListener('input', () => {
      apply(input.value);
      changed();
      updateCounts();
    });
  }
  el.site.addEventListener('change', () => changeSite(el.site.value));
  el.body.addEventListener('paste', onBodyPaste);
  for (const t of [el.foreword, el.body, el.afterword]) t.addEventListener('focus', () => { editTarget = t; });
  document.addEventListener('focusin', (e) => {
    if (e.target.matches('textarea, input[type="text"], input[type="url"]') && !e.target.closest('dialog')) lastEditable = e.target;
  });
  // 戻す／やり直すボタンを押しても入力欄からフォーカスが外れないようにする
  document.querySelectorAll('.history').forEach((b) => b.addEventListener('pointerdown', (e) => e.preventDefault()));

  $('symbol-list').append(...SYMBOLS.map((s) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: s });
    b.dataset.symbol = s;
    return b;
  }));

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button, .drawer-backdrop');
    const d = b?.dataset || {};
    if (d.action) {
      closeMenus();
      if (!actions[d.action]) {
        toast(`このボタンの処理が見つかりません（${d.action}）。Ctrl+Shift+R で再読み込みしてください`, true);
      } else {
        // その場で呼ぶ：ファイルを選ぶ画面・保存・共有メニューは、Safari では押した直後でないと出せない
        // （1拍おくと出ないか、次に押したときにずれて出る）
        try { Promise.resolve(actions[d.action]()).catch(fail); } catch (err) { fail(err); }
      }
    } else if (d.copy) {
      copyField(d.copy).catch(fail);
    } else if (d.find) {
      openFind(d.find);
    } else if (d.insert) {
      inserts[d.insert]();
    } else if (d.tab) {
      selectTab(d.tab);
    } else if (d.editSite) {
      setEditSite(d.editSite);
    } else if (d.view) {
      setView(d.view);
    } else if (d.ep !== undefined) {
      // 選んだエピソードが今と同じでも、本文の編集画面へ移る（狭い画面ではプロット・メモのタブから本文へ）
      if (reportMode) setReportMode(false);
      selectEpisode(Number(d.ep));
      selectTab('body');
      if (epSearch) jumpToSearchHit(Number(d.ep));
    } else if (d.epAct) {
      episodeAction(d.epAct, Number(d.epIndex), d.epTo);
    } else if (d.jump) {
      jumpField(d.jump, d.to);
    } else if (d.max) {
      maximizeField(d.max);
    } else if (d.toggleChapter) {
      toggleChapter(d.toggleChapter);
    } else if (d.chapterAct) {
      chapterAction(d.chapterAct, d.chapterId);
    } else if (d.symbol) {
      insertSymbol(d.symbol);
      closeMenus();
    } else if (d.tplApply) {
      applyTemplate(d.tplApply).catch(fail);
    } else if (d.tplSave) {
      templateFromCurrent(d.tplSave);
    }
    if (!e.target.closest('details.menu')) closeMenus();
  });
  // 入力補助のボタンを押しても本文の選択範囲が外れないようにする
  document.querySelectorAll('[data-insert], [data-symbol], .editor-tools summary')
    .forEach((b) => b.addEventListener('pointerdown', (e) => e.preventDefault()));

  const rf = $('replace-form');
  for (const name of ['from', 'scope']) rf.elements[name].addEventListener('input', updateReplacePreview);
  bindDialog('find-dialog');
  $('find-form').addEventListener('submit', (e) => { e.preventDefault(); findInField(1); });
  $('find-next').addEventListener('click', () => findInField(1));
  $('find-prev').addEventListener('click', () => findInField(-1));
  $('find-form').query.addEventListener('input', () => { findCursor = -1; $('find-result').textContent = ''; });

  // 目次の章・エピソードの「⋯」メニュー（あとから作る）：開いたら他のメニューを閉じ、下に入りきらなければ上向きに開く
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.open || !d.classList.contains('chapter-menu')) return;
    closeMenus(d);
    placeMenu(d);
  }, true);

  document.querySelectorAll('details.menu').forEach((d) => d.addEventListener('toggle', () => {
    if (!d.open) return;
    closeMenus(d);
    if (d.id === 'links-menu') buildLinksMenu();
    if (d.id === 'image-menu') buildImageMenu();
  }));

  bindDialog('settings-dialog');
  bindSettingsInputs();
  // Google ドライブの画面：押したその場で保存を始める（ログイン画面を出すことがあるため）
  bindDialog('drive-dialog');
  $('drive-form').addEventListener('submit', (e) => {
    e.preventDefault();
    try { driveOk().catch(fail); } catch (err) { fail(err); }
  });
  $('drive-up').addEventListener('click', () => { if (driveUi?.cur) goDriveFolder(driveParent(driveUi.byId.get(driveUi.cur))); });
  $('drive-new-folder').addEventListener('click', () => newDriveFolder().catch(fail));
  // 「この端末・その他…」：押したその場で共有メニュー・保存画面・ファイル選択を出す
  $('drive-local').addEventListener('click', () => finishDrive('local'));
  $('drive-dialog').addEventListener('close', () => { if (driveUi) finishDrive(null); });
  bindDialog('sync-restore-dialog');
  // バックアップの一覧を閉じたら、まだ読んでいない中身は読まない
  $('sync-restore-dialog').addEventListener('close', cancelQueuedBackupReads);
  $('backup-manage-dialog').addEventListener('close', () => { backupManagerGen++; cancelQueuedBackupReads(); });
  bindDialog('backup-pack-dialog');
  $('backup-pack-form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;
    e.preventDefault();
    try { createBackupPack(e.submitter).catch(fail); } catch (err) { fail(err); }
  });
  $('backup-pack-form').addEventListener('change', async (e) => {
    if (e.target.name === 'project') await renderPackEpisodes(e.target.value);
    updatePackForm();
  });
  $('backup-pack-all-episodes').addEventListener('click', () => { $('backup-pack-episodes').querySelectorAll('input').forEach((x) => { x.checked = true; }); updatePackForm(); });
  $('backup-pack-no-episodes').addEventListener('click', () => { $('backup-pack-episodes').querySelectorAll('input').forEach((x) => { x.checked = false; }); updatePackForm(); });
  bindDialog('backup-inspect-dialog');
  $('backup-inspect-form').addEventListener('submit', (e) => {
    if (!['restore', 'restore-new'].includes(e.submitter?.value)) return;
    e.preventDefault();
    restoreInspected(e.submitter.value === 'restore-new', e.submitter).catch(fail);
  });
  bindDialog('sync-target-dialog', saveSyncTargets);
  $('sync-target-all').addEventListener('click', () => $('sync-target-list').querySelectorAll('input').forEach((x) => { x.checked = true; }));
  $('sync-target-none').addEventListener('click', () => $('sync-target-list').querySelectorAll('input').forEach((x) => { x.checked = false; }));
  bindDialog('backup-manage-dialog');
  $('backup-manage-refresh').addEventListener('click', () => loadBackupManager().catch(fail));
  $('backup-manage-open-local').addEventListener('click', () => {
    $('backup-manage-dialog').close();
    openBackupPackFile().catch(fail);
  });
  $('backup-manage-all').addEventListener('click', () => $('backup-file-list').querySelectorAll('input').forEach((x) => { x.checked = true; }));
  $('backup-manage-none').addEventListener('click', () => $('backup-file-list').querySelectorAll('input').forEach((x) => { x.checked = false; }));
  $('backup-file-inspect').addEventListener('click', () => inspectManagedBackup().catch(fail));
  $('backup-files-delete').addEventListener('click', () => deleteManagedBackups().catch(fail));
  bindDialog('image-dialog', () => insertImage($('image-form').url.value));
  bindDialog('template-edit-dialog', saveEditedTemplate);
  bindDialog('replace-dialog', runReplace);
  bindDialog('restore-dialog');
  bindDialog('site-copy-dialog', runSiteCopy);
  bindDialog('episode-notes-copy-dialog', copyEpisodeNotes);
  $('episode-notes-copy-source').addEventListener('change', updateEpisodeNotesCopyPreview);
  $('site-copy-form').addEventListener('change', updateSiteCopy);
  bindDialog('version-save-dialog', async () => {
    const form = $('version-save-form');
    const v = await saveVersion(form.name.value.trim() || '名前なし', form.memo.value.trim());
    toast(`復元ポイント「${v.name}」を作成しました`);
    renderProjectVersions().catch(() => {});
  });
  $('ep-sort').addEventListener('change', (e) => setEpisodeSort({ key: e.target.value }));
  // 目次の検索：入力が止まったら探す。Esc で消す
  let searchTimer = null;
  $('ep-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setEpisodeSearch(e.target.value.trim()), 250);
  });
  $('ep-search').addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && e.target.value) { e.stopPropagation(); e.target.value = ''; setEpisodeSearch(''); }
    if (e.key === 'Enter') { clearTimeout(searchTimer); setEpisodeSearch(e.target.value.trim()); }
  });
  $('ep-grouping').addEventListener('change', (e) => setEpisodeSort({ grouped: e.target.value === 'chapters' }));
  for (const [kind, c] of Object.entries(WORK_CODES)) {
    $(c.input).addEventListener('input', (e) => setWorkCode(kind, e.target.value));
    if (kind === 'ncode' || kind === 'alpha') $(c.input).addEventListener('change', () => warnSameWorkCode(kind).catch(fail));
  }
  // 表示・ボタンの設定はチェックした時点で反映・保存する
  document.querySelectorAll('[data-ui]').forEach((c) => c.addEventListener('change', () => setUiPref(c.dataset.ui, c.checked)));
  document.querySelectorAll('[data-uiv]').forEach((s) => s.addEventListener('change', () => setUiPref(s.dataset.uiv, s.value)));
  document.querySelectorAll('[name="ui-active"]').forEach((r) => r.addEventListener('change', () => { if (r.checked) setUiActive(r.value); }));
  // 全て選択（押してもフォーカスを奪わないよう、押した時点では何もしない）
  document.querySelectorAll('[data-selall]').forEach((b) => {
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => selectAllIn(b.dataset.selall));
  });
  // 本文・プロット・フリーメモの折りたたみ
  document.querySelectorAll('[data-fold]').forEach((b) => b.addEventListener('click', () => setFolded(b.dataset.fold, !isFolded(b.dataset.fold))));
  applyFolds();
  $('iphone-max-mode').addEventListener('change', saveIphoneMaxSettings);
  $('iphone-max-px').addEventListener('change', saveIphoneMaxSettings);
  // 別のタブで同じ作品が保存されたら知らせる
  if (tabChannel) {
    tabChannel.onmessage = (e) => {
      const m = e.data;
      if (m?.type !== 'saved' || m.tab === TAB_ID || !project || m.id !== project.id) return;
      if (!otherTabEditing) toast('この作品は別のタブ（ウインドウ）でも編集されています。内容が食い違わないよう、どちらか一方を閉じてから再読み込みしてください', true);
      otherTabEditing = true;
      updateStatus();
    };
  }
  // スマートフォン・タブレットでキーボードが出ているとき、最大化した欄を見えている範囲に合わせる
  if (window.visualViewport) {
    const vv = window.visualViewport;
    vv.addEventListener('resize', () => { fitVisualViewport(); scheduleKeyboardCheck(); });
    vv.addEventListener('scroll', () => { fitVisualViewport(); scheduleKeyboardCheck(); });
  }
  window.addEventListener('resize', () => { fitVisualViewport(); scheduleFitFields(); });
  window.addEventListener('orientationchange', () => setTimeout(() => { fitVisualViewport(); scheduleKeyboardCheck(0); scheduleFitFields(); }, 300));
  document.addEventListener('focusin', (e) => {
    scheduleKeyboardCheck(350);
    if (!maximized || e.target !== maximized.input) return;
    [0, 100, 350, 700].forEach((ms) => setTimeout(fitVisualViewport, ms));
  });
  // 入力欄から離れたとき：別の入力欄へ移っただけならキーボードは出たままなので、落ち着いてから決める
  document.addEventListener('focusout', () => scheduleKeyboardCheck(350));
  // 画面（編集エリア）の大きさが変わったら、プロット・フリーメモの高さを合わせ直す
  if ('ResizeObserver' in window) new ResizeObserver(scheduleFitFields).observe($('view-episode'));
  fitVisualViewport();
  scheduleFitFields();
  // 最大化中の「戻る」（Android の戻る操作・ブラウザの戻る）は、最大化を解除するだけにする
  window.addEventListener('popstate', () => { if (maximized) restoreMaximized(true); });
  // 最大化ボタンを押しても、入力欄のカーソル位置が変わらないようにする
  document.querySelectorAll('[data-max]').forEach((b) => b.addEventListener('pointerdown', (e) => e.preventDefault()));
  renderSortControls();
  $('ep-version').addEventListener('change', (e) => {
    const id = e.target.value;
    if (id) switchEpisodeVersion(id).catch(fail);
  });
  document.querySelectorAll('[data-stab]').forEach((b) => b.addEventListener('click', () => selectSettingsTab(b.dataset.stab)));
  bindDialog('version-dialog');
  $('version-form').addEventListener('submit', (e) => {
    const v = currentVersion;
    const act = { restore: restoreVersion, copy: copyVersion, delete: deleteVersion }[e.submitter?.value];
    if (v && act) Promise.resolve().then(() => act(v)).catch(fail);
  });
  // 活動報告の見出し（X・なろう活動報告）：「リンク」に入れた URL を開く
  document.querySelectorAll('[data-report-link]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    openReportLink(a.dataset.reportLink);
  }));
  renderReportLinks();
  $('add-link').addEventListener('click', () => {
    editingLinks.push({ name: '', url: '' });
    renderLinkEditor();
    $('link-list').lastElementChild.querySelector('input').focus();
  });
  $('restore-form').addEventListener('submit', (e) => {
    const mode = e.submitter?.value;
    if (mode === 'merge' || mode === 'replace') runRestore(mode).catch(fail);
  });
  bindSplitter();

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      quickSave().catch(fail);
    } else if (e.key === 'Escape') {
      // ダイアログが開いているときは、ダイアログを閉じるだけにする
      if (maximized && !document.querySelector('dialog[open]')) { e.preventDefault(); restoreMaximized(); return; }
      closeMenus();
      document.body.classList.remove('drawer-open');
    }
  });

  // 画面を閉じる・別のアプリに切り替えるとき：端末に保存し、自動バージョンと自動バックアップも残す
  const onLeave = () => {
    saveEnvironment().catch(() => {}); // 環境設定の控え（小説とは別）
    flush().then(() => {
      autoVersion(60_000).catch(() => {});
      sync.flushNow();
    }).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') onLeave();
    else syncResumeIfReady().catch(() => {}); // 戻ってきたとき、許可・ログインが戻っていれば確認する
  });
  window.addEventListener('pagehide', onLeave);
  setInterval(() => autoVersion().catch(() => {}), 60_000);

  // 設定 → 自動バックアップ
  $('sync-mode').addEventListener('change', async (e) => {
    const m = e.target.value;
    if (m === 'off' && sync.mode() !== 'off') {
      if (!(await ask('自動バックアップを止めますか？（これまでのバックアップファイルは消えません）', { ok: '止める' }))) { renderSyncState(); return; }
      await sync.stop();
      syncPending = null;
      toast('自動バックアップを止めました');
      return;
    }
    await sync.setMode(m);
    syncPending = null;
    if (sync.getState() === 'need-folder') toast('「フォルダを選ぶ」を押して、バックアップ先のフォルダを選んでください（新しく作ることもできます）');
    else if (m === 'cloud' && sync.getState() === 'need-login') toast(`「${syncProvider()?.label || 'クラウド'}にログイン」を押してください`);
    await runSyncCheck();
  });
  $('sync-choose').addEventListener('click', () => {
    // クラウド方式でログイン済み：バックアップ先のフォルダを選ぶ（選んだフォルダに直接保存。中にフォルダは作らない）
    if (sync.mode() === 'cloud' && sync.getState() !== 'need-login') {
      const p = syncProvider();
      driveBrowse({ p, mode: 'folder', title: `自動バックアップのフォルダを選ぶ（${p.label}）` }).then(async (folder) => {
        if (!folder) return;
        p.setBackupFolder(folder);
        await sync.setMode('cloud'); // 選び直したので、確認からやり直す
        renderSyncState();
        toast(`自動バックアップを「${folder.name}」に保存します（このフォルダに直接）`);
        await runSyncCheck();
      }).catch(fail);
      return;
    }
    const run = sync.mode() === 'folder' ? sync.chooseFolder() : sync.resume();
    run.then(async (ok) => {
      if (!ok) return;
      toast(`「${sync.folderName()}」への自動バックアップを始めました`);
      await runSyncCheck();
    }).catch(fail);
  });
  $('sync-manage').addEventListener('click', () => openBackupManager().catch(fail));
  $('sync-check').addEventListener('click', () => openSyncRestore('sync').catch(fail));
  $('sync-presync').addEventListener('click', () => exportPreSync().catch(fail));
}

// 旧形式（1作品＝1原稿）のデータを作品＋エピソード形式へ移す
async function migrate() {
  const old = await db.oldWorks();
  if (old.length) {
    for (const w of old) await db.put({ ...fromSingle(w), id: w.id, links: w.links || {} });
    await db.clearOldWorks();
  }
  // データ形式 v3（サイト別原稿・章の所属）へ移す前の作品を、そのままの形で一度だけ退避しておく
  // （移行は読み込むたびにメモリ上で行い、編集して保存したときに初めて新形式で書き込まれる）
  const projects = await db.all();
  const needsV3 = projects.filter((p) => (p.episodes || []).some((e) => !e.drafts));
  if (needsV3.length && !(await meta.get('preV3Backup'))) {
    await meta.set('preV3Backup', { createdAt: new Date().toISOString(), projects: structuredClone(needsV3) });
  }
}


// 思わぬエラーは画面に出す（ボタンが「無反応」に見えないように）
window.addEventListener('error', (e) => toast('エラー：' + (e.message || '不明なエラー'), true));
window.addEventListener('unhandledrejection', (e) => toast('エラー：' + (e.reason?.message || String(e.reason)), true));

// 7.7.4 でクラウドの権限を変えたことの案内（前の版の鍵が残っていたときに一度だけ出す）
const SCOPE_NOTICE = {
  onedrive: 'この版から、OneDrive の権限を「あや綴り用のフォルダだけ」（Files.ReadWrite.AppFolder）にしました。\n\n'
    + '・OneDrive にログインし直してください（「設定」→「クラウド」、または上に出るボタン）。\n'
    + '・使えるのは、OneDrive の「アプリ」（Apps）の中にできる、あや綴りのフォルダの中だけです。フォルダの名前は、Microsoft Entra で登録したアプリの名前になります。\n'
    + '・今までのバックアップのフォルダがその外にあるときは、OneDrive（ブラウザやパソコン）で、フォルダごとその中へ移してください。移せば、選び直さなくてもそのまま使えます。\n'
    + '・フォルダを選ぶ画面の「一番上」は、そのアプリのフォルダになります。',
  gdrive: 'この版から、Google ドライブの権限を「あや綴りで作ったファイル・フォルダだけ」（drive.file）にしました。\n\n'
    + '・Google ドライブにログインし直してください（「設定」→「クラウド」、または上に出るボタン）。\n'
    + '・あや綴りで作ったフォルダ・保存したファイル・自動バックアップは、今までどおり使えます。\n'
    + '・ブラウザの Google ドライブなどで自分で作ったフォルダや、自分で置いたファイルは見えなくなります。そのフォルダを保存先にしていたときは、あや綴りの「＋ 新しいフォルダ」で作り直して選んでください。',
};

async function init() {
  // ブラウザーが設定（localStorage）だけを消していたら、自動保存していた環境を戻す（小説のデータとは別に控えている）
  const restoredEnvAt = await restoreEnvironmentIfLost().catch(() => null);
  if (restoredEnvAt !== null) prefs.set('restoredMessage', `この端末に自動保存していた環境設定を戻しました${restoredEnvAt ? `（${fmtTime(restoredEnvAt)} の状態）` : ''}`);
  $('app-version').textContent = `エディターの版：${APP_VERSION}`;
  applyProjectNavOrder();
  applyPrefs();
  bindEvents();
  selectTab('body');
  $('template-vars').textContent = TEMPLATE_VARS.join(' ');
  renderTemplateSelects();
  activeProvider()?.preload();
  await migrate();

  let p = null;
  const id = prefs.get('currentId');
  if (id) p = await db.get(id);
  if (!p) p = (await allProjects())[0];
  if (!p) { p = newProject(); await db.put(p); }
  showProject(p);

  requestPersistence();

  // 自動バックアップ（同期）：準備して、他の端末の更新を確認する
  const drive = syncProvider();
  // ログインでページを離れる前に、書きかけを保存
  for (const cp of providers) cp.onBeforeRedirect = () => flush();
  // ログイン画面から戻ってきたとき：ログインの鍵を受け取り終わるのを待つ（OneDrive）
  await Promise.all(providers.map((cp) => cp.ready?.().catch(() => {})));
  sync.onChange(renderSyncState);
  // 自動バックアップしようとしたら他の端末のほうが新しかった：画面が見えていれば、その場で確認する
  sync.onNewer(() => { if (document.visibilityState === 'visible') runSyncCheck().catch(fail); });
  // 自動バックアップの結果は、画面の下に短く知らせる（作業は止めない）。手動の保存は、それぞれの画面で知らせる
  sync.onBackupResult((r) => {
    if (r.checking) { setBusyMessage('処理結果を確認しています…'); return; }
    if (!r.auto) return;
    const where = r.where === 'cloud' ? `クラウド（${sync.folderName()}）` : `この端末のフォルダ（${sync.folderName()}）`;
    if (r.ok) toast(`自動バックアップ完了：${r.label || 'バックアップ'}\n保存先：${where}`);
    else toast(`自動バックアップに失敗しました：${r.error || '原因不明'}\n保存先：${where}`, true);
  });
  await sync.init({ provider: drive, makeAutoBackup: () => buildEpisodeBackup('auto-episode') }).catch((e) => console.warn('自動バックアップの準備に失敗', e));
  renderSyncState();
  let login = null;
  for (const cp of providers) {
    const r = cp.takeRedirectResult?.();
    if (r && !login) login = { ...r, label: cp.label };
  }
  const restored = prefs.get('restoredMessage', null);
  const report = prefs.get('restoredReport', null);
  if (login) toast(login.ok ? `${login.label}にログインしました` : login.message, !login.ok);
  else if (restored) toast(restored);
  if (restored) prefs.set('restoredMessage', null);
  if (report) prefs.set('restoredReport', null);
  if (!login && !restored && !report) setTimeout(() => remindBackup().catch(() => {}), 1500);
  // 読み込み・復元の結果を知らせてから、他の端末の更新を確認する（画面が重ならないように）
  if (report) await inform(report, { ok: 'OK' });
  // 7.7.4：クラウドの権限を狭くした。前の版の鍵が残っていた（＝初めてこの版を開いた）ときだけ、一度知らせる
  const narrowed = activeProvider();
  if (narrowed?.scopeChanged) await inform(SCOPE_NOTICE[narrowed.id] || '', { ok: 'OK' });
  runSyncCheck().catch((e) => console.warn('他の端末の更新の確認に失敗', e));

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    // PWA版でも古いキャッシュを長く保持しないよう、起動のたびにサーバー上の版を確認する。
    // 新しい Service Worker が有効になったら一度だけ画面を読み直し、HTML と JS の版を揃える。
    let reloadingForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      location.reload();
    });
    navigator.serviceWorker.register(`sw.js?v=${encodeURIComponent(APP_VERSION)}`, { updateViaCache: 'none' })
      .then((registration) => registration.update())
      .catch((e) => console.warn('Service Worker 登録失敗', e));
  }
}

init().catch(fail);
