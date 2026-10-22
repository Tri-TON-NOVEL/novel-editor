import { db, prefs, versions, meta } from './db.js';
import {
  newProject, newEpisode, normalize, fromSingle, serialize, parse, fileName, countChars,
  draftOf, DRAFT_FIELDS, SITE_KEYS,
} from './format.js';
import * as format from './format.js';
import { categorizedTable, chapterList, CHARACTER_COLUMNS, WORLD_COLUMNS } from './tables.js';
import {
  makeBackup, isBackup, parseBackup, restoreBackup, backupFileName, requestPersistence,
  makeEpisodeFile, isEpisodeFile, parseEpisodeFile,
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
import { providers } from './providers/index.js';

const $ = (id) => document.getElementById(id);
const AUTOSAVE_MS = 600;
// 更新したら上げる（設定の「表示」タブに出るので、どの版が動いているか確認できる）
const APP_VERSION = '2026.10.22-5.4';

const el = {
  novelTitle: $('novel-title'),
  site: $('site'),
  synopsis: $('synopsis'),
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
  reportEpisode: $('report-episode'),
};

let project = null;     // 編集中の作品
let epIndex = 0;        // 編集中のエピソード
let view = 'episode';   // VIEWS のいずれか
const VIEWS = ['episode', 'synopsis', 'outline', 'world', 'characters', 'report'];
let fileHandle = null;  // 開いている／保存したローカルファイル（Chrome・Edge のみ）
let saveTimer = null;
let dirty = false;
let lastSavedAt = null;
let saveError = null;   // 端末への保存に失敗したときのメッセージ
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
  return !p.title && !p.synopsis && !r.x && !r.narouTitle && !r.narouBody
    && !p.chapters.some((c) => c.plot) && !p.world.items.length && !p.characters.items.length
    && p.episodes.length === 1 && !e.plot && !e.freeMemo
    && SITE_KEYS.every((s) => DRAFT_FIELDS.every((f) => !draftOf(e, s)[f]));
}

function totalChars(p) {
  return p.episodes.reduce((n, e) => n + countChars(draftOf(e, p.site).body).all, 0);
}

function updateStatus() {
  const parts = [];
  if (!db.persistent) parts.push('⚠ この環境では端末に保存できません');
  else if (saveError) parts.push('⚠ 保存に失敗しました');
  else if (otherTabEditing) parts.push('⚠ 別のタブでも編集中');
  else if (dirty) parts.push('端末に保存中…');
  else if (lastSavedAt) parts.push('端末に保存済み ' + fmtTime(lastSavedAt));
  parts.push('メイン: ' + SITES[project.site].short);
  const s = syncStatusShort();
  if (s) parts.push(s);
  $('status').textContent = parts.join(' ・ ');
  renderSaveButton();
}

// 「保存」ボタン：まだ自動バックアップ（全端末で共有）に入っていない変更があれば「保存●」
function renderSaveButton() {
  const b = $('sync-save-btn');
  const unsaved = sync.isDirty();
  b.textContent = unsaved ? '保存●' : '保存';
  b.classList.toggle('unsaved', unsaved);
  const last = prefs.get('lastAutoBackupAt', null);
  b.title = (unsaved ? 'まだ保存していない変更があります。' : '')
    + `今の内容を自動バックアップに保存（Ctrl+S／⌘S）${last ? `　最後の保存 ${fmtTime(last)}` : ''}`;
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
}

// ---------- 自動保存 ----------

async function flush() {
  if (!dirty || !project) return;
  clearTimeout(saveTimer);
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

function changed() {
  project.updatedAt = new Date().toISOString();
  dirty = true;
  autoDirty = true;
  sync.markDirty();
  updateStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, AUTOSAVE_MS);
}

// エピソードの中身を変えたときは、そのエピソードの更新日時も進める
function touchEpisode(ep = episode()) {
  ep.updatedAt = new Date().toISOString();
}

let listTimer = null;
// タイトル・前書き・本文・後書きは編集中サイトの原稿へ、プロット・フリーメモはエピソード共通へ
function editEpisode(field, value) {
  const wasEmpty = !cur().body && !cur().title;
  if (DRAFT_FIELDS.includes(field)) cur()[field] = value;
  else episode()[field] = value;
  touchEpisode();
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
  [el.epTitle, (v) => editEpisode('title', v)],
  [el.foreword, (v) => editEpisode('foreword', v)],
  [el.body, (v) => editEpisode('body', v)],
  [el.afterword, (v) => editEpisode('afterword', v)],
  [el.plot, (v) => editEpisode('plot', v)],
  [el.freeMemo, (v) => editEpisode('freeMemo', v)],
  [el.narouUrl, (v) => { project.narouUrl = v.trim(); }],
  [el.alphaUrl, (v) => { project.alphaUrl = v.trim(); }],
  [el.xText, (v) => { project.reports.x = v; }],
  [el.nrTitle, (v) => { project.reports.narouTitle = v; }],
  [el.nrBody, (v) => { project.reports.narouBody = v; }],
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

function renderEpisodeList() {
  const list = $('episode-list');
  list.replaceChildren();
  if (epSearch) { renderSearchResults(list); return; }
  const sort = EP_SORTS[epSort.key];
  // 「章なし」は章を抜きにして、全エピソードを選択した条件で並べる
  if (!epSort.grouped) {
    for (const i of sortedEpisodeIndexes()) list.append(episodeRow(i, sort, true));
    return;
  }
  const collapsed = collapsedSet();
  for (const g of episodeGroups()) {
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
  // 前書き・後書きは中身があるときだけ開いておく
  $('foreword-box').open = !!d.foreword;
  $('afterword-box').open = !!d.afterword;
  updateCounts();
  renderSiteTabs();
  renderEpisodeVersions().catch(() => {});
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
    b.setAttribute('aria-selected', String(s === editSite));
  });
  const copyBtn = $('copy-main-to-sub');
  copyBtn.replaceChildren(
    Object.assign(document.createElement('span'), { className: 'long', textContent: `${SITES[project.site].short}（メイン）→ ${SITES[subSite()].short}（サブ）にコピー…` }),
    Object.assign(document.createElement('span'), { className: 'short', textContent: `${SITES[subSite()].short}へコピー…` }));
  copyBtn.setAttribute('aria-label', `${SITES[project.site].short}（メイン）から${SITES[subSite()].short}（サブ）へコピー`);
}

function setEditSite(site) {
  if (!SITE_KEYS.includes(site) || site === editSite) return;
  editSite = site;
  applySite();
  showEpisode();
}

function setView(next) {
  view = next;
  for (const v of VIEWS) $('view-' + v).hidden = v !== view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  if (view === 'report') renderReportView();
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
  el.narouUrl.value = project.narouUrl;
  el.alphaUrl.value = project.alphaUrl;
  el.xText.value = project.reports.x;
  el.nrTitle.value = project.reports.narouTitle;
  el.nrBody.value = project.reports.narouBody;
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
    const meta = `${p.episodes.length}話 ・ 本文 ${totalChars(p).toLocaleString()}字 ・ ${fmtTime(p.updatedAt)}`;
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
    + `プロット・設定・登場人物、バージョン${vcount}件がすべて消えます。\n`
    + '（「ファイル」で保存したものや、自動バックアップのファイルは残ります）\n本当に削除しますか？'))) return false;
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

// ---------- 保存先の選択（Google ドライブ／この端末・その他） ----------
// 設定（端末ごと）：'ask' 毎回選ぶ（既定）／'gdrive' Google ドライブを優先／'local' この端末・その他を優先
// Google ドライブを設定していない端末では、選ぶ画面を出さずに「この端末・その他」にする。
const DEST_KEY = 'file.destination';

function driveProvider() {
  return providers.find((p) => p.isConfigured() && p.save) || null;
}

// 「ファイル」タブの設定が「だけを使う」なら選ぶ画面を出さず、そのまま返す（すぐにそれぞれの画面へ）
async function chooseDestination(kind) {
  const p = driveProvider();
  if (!p) return 'local';
  const pref = prefs.get(DEST_KEY, 'ask');
  if (pref !== 'ask') return pref;
  const last = prefs.get('file.lastDestination', 'local');
  const drive = { value: 'gdrive', label: p.label, primary: last === 'gdrive' };
  const local = { value: 'local', label: 'この端末・その他（iCloud・OneDrive など）', primary: last !== 'gdrive' };
  // 前回使ったほうを右端（目立つボタン）に置く
  const r = await choose(kind === 'open' ? 'どこから開きますか？' : 'どこに保存しますか？', last === 'gdrive' ? [local, drive] : [drive, local]);
  if (r) prefs.set('file.lastDestination', r);
  return r;
}

// ファイルの種類：json（小説エディターのファイル）／txt（プレーンテキスト）
const FILE_KINDS = {
  json: { ext: '.json', mime: 'application/json', types: WORK_TYPES },
  txt: { ext: '.txt', mime: 'text/plain', types: TEXT_TYPES },
};

// ---------- Google ドライブの画面（エディター内のフォルダ選択） ----------
// iPhone・iPad でも、マイドライブのフォルダをたどって選び、その場で新しいフォルダを作れる。
//
// mode: 'save'   … ファイル名を入れて、このフォルダに保存（一覧のファイルを押すと上書き）
//       'open'   … フォルダをたどって、ファイルを選ぶ
//       'folder' … フォルダを選ぶ（「クラウド」タブの保存先フォルダ）
// 戻り値: save → { type: 'gdrive', id, name }／'local'（この端末・その他を選び直した）／null
//         open → { id, name }／'local'／null
//         folder → { id, name }／null
let driveUi = null; // { p, mode, kind, text, workId, resolve, folders, byId, cur }

const hasExt = (name, kind) => name.toLowerCase().endsWith(FILE_KINDS[kind].ext);

function driveBrowse({ p, mode, kind = 'json', title, name = '', text = '', workId = '' }) {
  return new Promise((resolve) => {
    driveUi = { p, mode, kind, text, workId, resolve, folders: null, byId: new Map(), cur: null };
    $('drive-title').textContent = title;
    $('drive-name').value = name;
    $('drive-name-row').hidden = mode !== 'save';
    $('drive-ok').hidden = mode === 'open';
    $('drive-ok').textContent = mode === 'folder' ? 'このフォルダにする' : 'このフォルダに保存';
    $('drive-local').hidden = mode === 'folder';
    $('drive-local').textContent = mode === 'open' ? 'この端末・その他から開く…' : 'この端末・その他に保存…';
    $('drive-hint').textContent = 'マイドライブのフォルダが出ます（共有されたフォルダは出ません）。';
    $('drive-dialog').showModal();
    loadDriveFolders().catch((e) => { finishDrive(null); fail(e); });
  });
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
      button('ログインして続ける', async () => { await ui.p.signIn(); if (driveUi === ui) await loadDriveFolders(); }),
    ]));
    $('drive-ok').disabled = true;
    return;
  }
  list.replaceChildren(li('empty', '読み込み中…'));
  const home = await ui.p.defaultFolderId().catch(() => null);
  const folders = await ui.p.folders();
  if (driveUi !== ui) return;
  ui.folders = folders;
  ui.byId = new Map(folders.map((f) => [f.id, f]));
  const last = prefs.get('gdrive.lastFolder', null);
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
  driveUi.cur = id;
  renderDrive().catch(fail);
}

async function renderDrive() {
  const ui = driveUi;
  if (!ui) return;
  // 場所（パンくず）
  const path = $('drive-path');
  const crumbs = [{ id: null, name: 'マイドライブ' }, ...drivePath(ui.cur)];
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
      const act = ui.mode === 'open'
        ? button('開く', () => finishDrive({ id: f.id, name: f.name }), 'primary')
        : button('上書き', async () => {
          if (!(await ask(`「${f.name}」を、今の内容で上書きしますか？\n（前の内容は Google ドライブの「版を管理」から戻せます）`, { ok: '上書きする' }))) return;
          await runDriveSave(f.name, f.id);
        }, 'danger');
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
  const name = await askText(`新しいフォルダの名前（${ui.cur ? `「${ui.byId.get(ui.cur).name}」の中` : 'マイドライブの直下'}に作ります）`, '小説');
  if (!name || !name.trim() || driveUi !== ui) return;
  // 同じ場所に同じ名前のフォルダがあれば、作らずにそれを開く（同じ名前のフォルダが並ばないように）
  const f = await ui.p.makeFolder(name.trim(), ui.cur);
  if (!ui.byId.has(f.id)) { ui.folders.push(f); ui.byId.set(f.id, f); }
  goDriveFolder(f.id);
  toast(f.existed ? `同じ名前のフォルダ「${f.name}」が既にあるので、それを開きました` : `フォルダ「${f.name}」を作りました`);
}

// 「このフォルダに保存」「このフォルダにする」
async function driveOk() {
  const ui = driveUi;
  if (!ui?.cur) return;
  prefs.set('gdrive.lastFolder', ui.cur);
  if (ui.mode === 'folder') { const f = ui.byId.get(ui.cur); finishDrive({ id: f.id, name: f.name }); return; }
  if (ui.mode === 'save') await runDriveSave($('drive-name').value);
}

async function runDriveSave(name, fileId = null) {
  const ui = driveUi;
  if (!ui || !ui.cur) return;
  let finalName = name.trim() || 'untitled';
  if (!hasExt(finalName, ui.kind)) finalName += FILE_KINDS[ui.kind].ext;
  const id = await ui.p.save(ui.text, finalName, fileId, { workId: ui.workId, mime: FILE_KINDS[ui.kind].mime, folderId: ui.cur });
  prefs.set('gdrive.lastFolder', ui.cur);
  prefs.set('file.lastDestination', 'gdrive');
  finishDrive({ type: 'gdrive', id, name: finalName });
}

// 保存・開くで使う入口（前の版からの名前）
function openDriveSave({ p, title, name, text, workId = '', kind = 'json' }) {
  return driveBrowse({ p, mode: 'save', kind, title, name, text, workId });
}

function pickDriveFile(p, title, kind = 'json') {
  return driveBrowse({ p, mode: 'open', kind, title });
}

/**
 * 保存先を選んで保存する（Google ドライブ／この端末・その他）。設定の「ファイル」タブに従う。
 * 戻り値: { type: 'gdrive', id, name }／{ type: 'local', handle, how, name }／null（やめた）
 */
async function saveTextTo(text, name, { title, force = false, workId = '', kind = 'json' } = {}) {
  const dest = await chooseDestination('save', { force });
  let where = dest;
  if (dest === 'gdrive') {
    const r = await openDriveSave({ p: driveProvider(), title, name, text, workId, kind });
    if (r !== 'local') return r;
    where = 'local';
  }
  if (where !== 'local') return null;
  // iPhone・iPad では共有メニューが出るので、「"ファイル"に保存」を選んでもらう
  if (localFile.saveMethod === 'share') toast('共有メニューが開きます。「"ファイル"に保存」を選ぶと、保存先（iCloud Drive・OneDrive など）を選べます');
  const r = await localFile.saveAs(text, name, FILE_KINDS[kind].types, FILE_KINDS[kind].mime);
  if (!r) return null;
  prefs.set('file.lastDestination', 'local');
  return typeof r === 'string' ? { type: 'local', handle: null, how: r, name } : { type: 'local', handle: r, how: 'picker', name: r.name };
}

function savedMessage(r, what) {
  if (r.type === 'gdrive') return `${what}を Google ドライブに「${r.name}」として保存しました`;
  if (r.how === 'downloaded') return `${what}を書き出しました（「ダウンロード」フォルダ）`;
  if (r.how === 'shared') return `${what}を渡しました（共有メニューで選んだ保存先）`;
  return `${what}を「${r.name}」に保存しました`;
}

/**
 * 保存先を選んで開く（「どこから開きますか？」。設定の「ファイル」タブに従う）。kind: 'json'／'txt'
 * 戻り値: { text, name, source: 'gdrive'|'local', id?, handle?, file? }／null
 */
async function openFrom(title, { force = false, kind = 'json' } = {}) {
  const dest = await chooseDestination('open', { force });
  let where = dest;
  if (dest === 'gdrive') {
    const p = driveProvider();
    const f = await pickDriveFile(p, title, kind);
    if (f && f !== 'local') return { text: await p.load(f.id), name: f.name, source: 'gdrive', id: f.id };
    if (f !== 'local') return null;
    where = 'local'; // 「この端末・その他から開く」を選び直した
  }
  if (where !== 'local') return null;
  const r = await localFile.open(kind);
  return r ? { ...r, source: 'local' } : null;
}

// ---------- 全体（すべての作品・ひな型・設定を1ファイルに） ----------
// 「ファイル」は、明示的に好きな場所・名前で保存する／開くときだけに使う（上書き保存は「保存」ボタン＝自動バックアップ）

async function allSaveAs({ force = false } = {}) {
  await flush();
  const { text, count } = await makeBackup();
  const r = await saveTextTo(text, backupFileName(), { title: 'Google ドライブに保存（全体：すべての作品）', force });
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
  await switchTo(await importContent(parse(src.text, src.name)));
  toast(`「${src.name}」を作品として開きました`);
}

// ---------- エピソード専用ファイル（今開いているエピソード） ----------

async function epSaveAs({ force = false } = {}) {
  await flush();
  const ep = episode();
  const label = mainDraft(ep).title || `第${epIndex + 1}話`;
  const r = await saveTextTo(makeEpisodeFile(ep, project.title), fileName(`${project.title || '無題'}_${label}`, '.json'), { title: 'Google ドライブに保存（このエピソード）', force });
  if (r) toast(savedMessage(r, `エピソード「${label}」`));
}

async function epOpen({ force = false } = {}) {
  const src = await openFrom('エピソードを開く', { force });
  if (!src) return;
  if (!isEpisodeFile(src.text)) {
    toast(isBackup(src.text) ? '全体のファイルです。「ファイル」→ 全体の「開く」で開いてください' : 'エピソードのファイルではありません', true);
    return;
  }
  const data = parseEpisodeFile(src.text);
  const ep = episode();
  const name = mainDraft(ep).title || `第${epIndex + 1}話`;
  if (!(await ask(`今のエピソード「${name}」を、「${src.name}」の内容で上書きしますか？\n（なろう用・アルファ用の原稿、プロット、フリーメモが入れ替わります。上書き前の内容はエピソードの版に残します）`, { ok: '上書きする' }))) return;
  await saveEpisodeVersion('開く前（自動）', ep);
  applyEpisodeSnapshot(ep, data.episode);
  touchEpisode(ep);
  changed();
  showEpisode();
  renderEpisodeList();
  toast(`「${src.name}」を今のエピソードに開きました`);
}

// ---------- インポート・エクスポート（プレーンテキスト） ----------

// プレーンテキスト → 今のエピソードの本文（開いている側の原稿）
async function importText() {
  const src = await openFrom('プレーンテキストを開く', { kind: 'txt' });
  if (!src) return;
  const text = src.file ? decodeText(await src.file.arrayBuffer()).text : src.text;
  const body = text.replace(/\r\n?/g, '\n');
  const d = cur();
  if (d.body && !(await ask(`今のエピソードの本文（${SITES[editSite].short}用）を、「${src.name}」の内容で上書きしますか？\n（上書き前の内容はエピソードの版に残します）`, { ok: '上書きする' }))) return;
  if (d.body) await saveEpisodeVersion('テキストを読み込む前（自動）');
  d.body = body;
  touchEpisode();
  changed();
  showEpisode();
  renderEpisodeList();
  toast(`「${src.name}」を本文（${SITES[editSite].short}用）に読み込みました（${countChars(body).all.toLocaleString()}字）`);
}

// 書き出しは、いま編集している側（なろう用／アルファ用）の原稿
async function exportEpisode() {
  const d = cur();
  if (!d.body) { toast('本文は空です'); return; }
  const name = fileName(`${project.title || '無題'}_${d.title || epIndex + 1}`, '.txt');
  const r = await saveTextTo(convert(editSite, d.body), name, { title: 'Google ドライブに保存（このエピソードのテキスト）', kind: 'txt' });
  if (r) toast(savedMessage(r, `「${d.title || '（無題）'}」のテキスト（${SITES[editSite].short}用）`));
}

async function exportAll() {
  const text = project.episodes
    .map((e) => draftOf(e, editSite))
    .map((d) => `${d.title}\n\n${convert(editSite, d.body)}`)
    .join('\n\n――――――――――\n\n');
  const head = project.title ? project.title + '\n\n' : '';
  const r = await saveTextTo(head + text, fileName(`${project.title || '無題'}_${SITES[editSite].short}`, '.txt'), { title: 'Google ドライブに保存（全エピソードのテキスト）', kind: 'txt' });
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

function buildCopyPlan() {
  const form = $('site-copy-form');
  const from = project.site;
  const to = subSite();
  const all = form.elements.scope.value === 'all';
  const fields = COPY_FIELDS.map(([f]) => f).filter((f) => form.elements['f-' + f]?.checked && siteSupports(to, f));
  const eps = all ? project.episodes : [episode()];
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
  return { from, to, all, fields, eps, changes, warnings };
}

function openSiteCopy() {
  const from = project.site;
  const to = subSite();
  $('site-copy-title').textContent = `${SITES[from].short}（メイン）→ ${SITES[to].short}（サブ）にコピー`;
  $('site-copy-desc').textContent = `メインの原稿を${SITES[to].label}の書き方に変換して、サブ側へ写します。メイン側は変わりません。`;
  const box = $('site-copy-fields');
  box.querySelectorAll('label').forEach((n) => n.remove());
  for (const [f, label] of COPY_FIELDS) {
    const ok = siteSupports(to, f);
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', name: 'f-' + f, checked: ok, disabled: !ok });
    const l = document.createElement('label');
    l.append(input, ` ${label}${ok ? '' : '（コピー先に欄がないため対象外）'}`);
    box.append(l);
  }
  $('site-copy-form').elements.scope.value = 'episode';
  updateSiteCopy();
  $('site-copy-dialog').showModal();
}

function updateSiteCopy() {
  const plan = buildCopyPlan();
  const label = Object.fromEntries(COPY_FIELDS);
  // 上書きになるもの
  const over = plan.changes.filter((c) => c.before);
  const ow = $('site-copy-overwrite');
  ow.hidden = !over.length;
  if (over.length) {
    const ul = document.createElement('ul');
    for (const c of over.slice(0, 8)) {
      ul.append(Object.assign(document.createElement('li'), {
        textContent: `${plan.all ? episodeName(c.ep) + '：' : ''}${label[c.f]}　今 ${countChars(c.before).all.toLocaleString()}字 → ${countChars(c.text).all.toLocaleString()}字`,
      }));
    }
    if (over.length > 8) ul.append(Object.assign(document.createElement('li'), { textContent: `ほか ${over.length - 8}件` }));
    ow.replaceChildren(Object.assign(document.createElement('strong'), { textContent: `⚠ コピー先（${SITES[plan.to].short}用）にすでに内容があります。上書きされます（${over.length}件）` }), ul);
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
  ok.textContent = !plan.changes.length ? 'コピーする内容がありません' : over.length ? `上書きしてコピー（${plan.changes.length}件）` : `コピーする（${plan.changes.length}件）`;
  ok.classList.toggle('danger-solid', !!over.length);
  ok.classList.toggle('primary', !over.length);
}

async function runSiteCopy() {
  const plan = buildCopyPlan();
  if (!plan.changes.length) return;
  const over = plan.changes.filter((c) => c.before);
  const toName = SITES[plan.to].short;
  if (plan.all && !(await ask(`【作品全体】${new Set(plan.changes.map((c) => c.ep)).size}話の ${toName}用の原稿を書き換えます。よろしいですか？`, { danger: true }))) return;
  // 上書きする前の状態を残す（元に戻せるように）
  if (over.length) {
    if (plan.all) await saveVersion(`${toName}用へのコピー前（自動）`, `${new Date().toLocaleString('ja-JP')} にメインから${toName}用へ全エピソードをコピーする前の状態`);
    else await saveEpisodeVersion(`${toName}用へのコピー前`, plan.eps[0]);
  }
  for (const c of plan.changes) {
    c.ep.drafts[plan.to][c.f] = c.text;
    touchEpisode(c.ep);
  }
  changed();
  editSite = plan.to;
  applySite();
  showEpisode();
  renderEpisodeList();
  toast(`${toName}用の原稿へ ${plan.changes.length}件コピーしました${over.length ? '（上書き前の状態は版に残しました）' : ''}`);
}

// ---------- 版 ----------
// 版は2種類。どちらも versions ストアに入れ、kind で分ける。
//   エピソードの版（kind: 'episode'）… エピソードごとの編集の版。エピソード欄の「版」から上げる・戻す
//   作品全体のバックアップ版（kind なし／'project'）… 設定の「バックアップ」タブ。自動でも残る

const newVersionId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const isEpisodeVersion = (v) => v.kind === 'episode';

// --- エピソードの版 ---

// 版に残すもの：両サイトの原稿と、プロット・フリーメモ（章の所属は残さない）
function episodeSnapshot(ep) {
  return { drafts: structuredClone(ep.drafts), plot: ep.plot, freeMemo: ep.freeMemo };
}

// 版の中身をエピソードへ戻す（旧形式の版 { title, foreword, body, afterword, plot } にも対応）
function applyEpisodeSnapshot(ep, data, site = project.site) {
  if (data.drafts) {
    ep.drafts = { ...ep.drafts, ...structuredClone(data.drafts) };
  } else {
    ep.drafts[site] = { title: data.title ?? '', foreword: data.foreword ?? '', body: data.body ?? '', afterword: data.afterword ?? '' };
  }
  ep.plot = data.plot ?? ep.plot;
  if ('freeMemo' in data) ep.freeMemo = data.freeMemo;
}

async function episodeVersions(episodeId = episode().id) {
  return (await versions.list(project.id)).filter((v) => isEpisodeVersion(v) && v.episodeId === episodeId);
}

async function saveEpisodeVersion(name, ep = episode()) {
  await flush();
  const v = {
    id: newVersionId(),
    kind: 'episode',
    projectId: project.id,
    episodeId: ep.id,
    name,
    memo: '',
    createdAt: new Date().toISOString(),
    chars: countChars(mainDraft(ep).body).all,
    data: episodeSnapshot(ep),
  };
  await versions.put(v);
  return v;
}

async function renderEpisodeVersions() {
  const sel = $('ep-version');
  const list = await episodeVersions();
  sel.replaceChildren(new Option(list.length ? `今の内容（版 ${list.length}件）` : '版はまだありません', ''));
  for (const v of list) sel.append(new Option(`${v.name}　${fmtTime(v.createdAt)}　${v.chars.toLocaleString()}字`, v.id));
  sel.value = '';
}

async function episodeVersionUp() {
  const ep = episode();
  // 「第○版」の続きの番号にする（「○○に戻す前」は数えない）
  const n = Math.max(0, ...(await episodeVersions()).map((x) => Number(/^第(\d+)版$/.exec(x.name)?.[1] || 0))) + 1;
  const v = await saveEpisodeVersion(`第${n}版`, ep);
  await renderEpisodeVersions();
  toast(`「${episodeName(ep)}」を ${v.name} として残しました`);
}

async function removeEpisodeVersions(episodeId) {
  for (const v of await episodeVersions(episodeId)) await versions.remove(v.id);
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

// 自動で残す：書いている間は10分ごと、画面を閉じる・切り替えるときにも（作品ごとに最新30件）
const AUTO_VERSION_MS = 10 * 60_000;
const AUTO_VERSION_KEEP = 30;
let autoDirty = false;
let lastAutoVersionAt = Date.now();

async function autoVersion(minInterval = AUTO_VERSION_MS) {
  if (!autoDirty || !project || Date.now() - lastAutoVersionAt < minInterval) return;
  autoDirty = false;
  lastAutoVersionAt = Date.now();
  const time = new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  await saveVersion(`自動保存 ${time}`, '', true);
  const autos = (await projectVersions()).filter((v) => v.auto);
  for (const old of autos.slice(AUTO_VERSION_KEEP)) await versions.remove(old.id);
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
    list.append(listItem(v.name, meta, [button('開く', () => openVersion(v.id))]));
  }
}

// --- 版の確認画面（共通） ---

let currentVersion = null;
async function openVersion(id) {
  const v = await versions.get(id);
  if (!v) { toast('この版は見つかりませんでした', true); return; }
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
  if (!(await ask(`「${v.name}」の内容に戻しますか？\n今の内容は「${v.name}に戻す前」として自動で残ります。`))) return;
  if (isEpisodeVersion(v)) {
    const index = project.episodes.findIndex((e) => e.id === v.episodeId);
    if (index < 0) { toast('このエピソードは削除されています', true); return; }
    const ep = project.episodes[index];
    await saveEpisodeVersion(`${v.name}に戻す前`, ep);
    applyEpisodeSnapshot(ep, v.data);
    touchEpisode(ep);
    changed();
    selectEpisode(index);
    toast(`「${episodeName(ep)}」を ${v.name} に戻しました`);
    return;
  }
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
  if (!(await ask(`版「${v.name}」を削除しますか？`))) return;
  if (!(await ask(`【最終確認】「${v.name}」は元に戻せません。削除しますか？`))) return;
  await versions.remove(v.id);
  toast(`版「${v.name}」を削除しました`);
  if (isEpisodeVersion(v)) renderEpisodeVersions();
  else renderProjectVersions();
}

// ---------- 全体バックアップ・復元 ----------

const BACKUP_REMIND_DAYS = 7;

let pendingBackup = null;
function openRestoreDialog(text, name = '') {
  pendingBackup = parseBackup(text);
  const when = pendingBackup.createdAt ? new Date(pendingBackup.createdAt).toLocaleString('ja-JP') : '不明';
  const titles = pendingBackup.projects.map((p) => p.title || '（無題）');
  $('restore-info').textContent =
    `${name ? `「${name}」\n` : ''}作成日時：${when}\n作品：${titles.length}件（${titles.slice(0, 5).join('、')}${titles.length > 5 ? ' ほか' : ''}）\nひな型・設定も戻します。`;
  $('restore-dialog').showModal();
}

async function runRestore(mode) {
  if (!pendingBackup) return;
  if (mode === 'replace' && !(await ask('【最終確認】この端末の作品をすべて消して、バックアップの内容に入れ替えます。よろしいですか？'))) return;
  await flush();
  const backup = pendingBackup;
  const before = new Set((await db.all()).map((p) => p.id));
  await restoreBackup(backup, mode);
  pendingBackup = null;
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

function syncProvider() {
  return providers.find((p) => p.backups) || null;
}

function syncStatusShort() {
  const st = sync.getState();
  if (st === 'off' || st === 'unsupported') return '';
  if (st === 'need-folder') return '⚠ 自動バックアップのフォルダが未設定';
  if (st === 'need-permission') return '⚠ 自動バックアップ停止中（許可切れ）';
  if (st === 'need-login') return '⚠ 自動バックアップ停止中（ログインが必要）';
  if (syncPending) return '⚠ 他の端末で更新あり（自動バックアップ停止中）';
  if (sync.getError()) return '⚠ 自動バックアップに失敗';
  if (!sync.isChecked()) return '自動バックアップ：確認中';
  const last = prefs.get('lastAutoBackupAt', null);
  return last ? '保存 ' + fmtTime(last) : '自動バックアップ 有効';
}

function renderSyncState() {
  const st = sync.getState();
  const m = sync.mode();
  const b = $('sync-attention');
  const attention = syncPending ? '⚠ 他の端末の更新を確認'
    : st === 'need-folder' ? '⚠ 自動バックアップのフォルダを選ぶ'
    : st === 'need-permission' ? '⚠ 自動バックアップを再開'
      : st === 'need-login' ? '⚠ Google ドライブにログイン（自動バックアップ）'
        : '';
  b.textContent = attention;
  b.hidden = !attention;

  const sel = $('sync-mode');
  sel.value = m;
  sel.querySelector('option[value="folder"]').disabled = !sync.folderSupported && m !== 'folder';
  sel.querySelector('option[value="gdrive"]').disabled = !syncProvider()?.isConfigured() && m !== 'gdrive';
  $('sync-mode-hint').textContent = m === 'gdrive'
    ? '自分で作ったフォルダ（名前は自由）を選ぶと、そのフォルダに直接保存します。選ぶ画面で新しいフォルダも作れます。端末どうしで同期するときは、すべての端末で同じフォルダを選んでください。ログインは約1時間で切れます。切れたら上に出るボタンを押してください。'
    : m === 'folder'
      ? '自分で作ったフォルダを選ぶと、そのフォルダに直接保存します。OneDrive・iCloud Drive・Google ドライブ（パソコン版）の同期フォルダも選べます。iPhone・iPad（Google ドライブ方式）と同期するときは、パソコン版 Google ドライブの中の、iPhone・iPad と同じフォルダを選んでください。'
      : sync.folderSupported
        ? 'iPhone・iPad と同期するときは「Google ドライブ」がおすすめです（「クラウド」タブでクライアントIDを入れると選べます）。'
        : 'この端末では「Google ドライブ」を選べます（「クラウド」タブでクライアントIDを入れると選べます）。';

  // バックアップ先のフォルダ（フォルダ方式：端末のフォルダ／Google ドライブ方式：ドライブのフォルダ）
  const backupInfo = m === 'gdrive' ? syncProvider()?.backupFolderInfo?.() : null;
  $('sync-folder-line').textContent = m === 'folder' ? `バックアップ先：${sync.folderName() || '（まだ選んでいません）'}`
    : m === 'gdrive' ? `バックアップ先：${backupInfo ? `Google ドライブの「${backupInfo.name}」` : '（まだ選んでいません）'}` : '';
  $('sync-folder-line').hidden = !$('sync-folder-line').textContent;
  $('sync-choose').textContent = m === 'folder' ? (sync.folderName() ? 'フォルダを選び直す…' : 'フォルダを選ぶ…')
    : st === 'need-login' ? 'Google ドライブにログイン' : (backupInfo ? 'フォルダを選び直す・作る…' : 'フォルダを選ぶ・作る…');
  $('sync-folder-row').hidden = !(m === 'folder' || m === 'gdrive');

  const last = sync.lastBackup();
  const lastText = last ? `\n最後に同期したバックアップ：${last.name}（${fmtTime(last.at)}）` : '';
  const err = sync.getError() ? `\n⚠ 前回の保存に失敗しました：${sync.getError()}` : '';
  const text = st === 'off' ? '止まっています。保存先を選ぶと始まります。'
    : st === 'need-folder' ? '⚠ バックアップ先のフォルダを選んでください（「フォルダを選ぶ」）。選ぶまでは保存しません。'
    : st === 'unsupported' ? (m === 'folder' ? 'このブラウザではフォルダを使えません。「Google ドライブ」を選んでください。' : 'Google ドライブを使うには、「クラウド」タブでクライアントIDを入れてください。')
      : st === 'need-permission' ? `⚠ 「${sync.folderName()}」への書き込みの許可が切れています。上の「自動バックアップを再開」を押してください。`
        : st === 'need-login' ? '⚠ Google ドライブへのログインが必要です。上のボタン（または下の「Google ドライブにログイン」）を押してください。'
          : syncPending ? '⚠ 他の端末で新しいバックアップが保存されています。上の「他の端末の更新を確認」を押してください（それまで自動バックアップは止まります）。'
            : `✅ 「${sync.folderName()}」に、${sync.intervalMin()}分ごと（変更があるときだけ）・閉じるときに保存しています。この端末の分は最新${sync.keepCount()}件まで残します。`;
  $('sync-status').textContent = text + lastText + err;
  const on = st === 'on';
  for (const id of ['sync-now', 'sync-check', 'sync-restore']) $(id).disabled = !on;
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
    r = await sync.findNewer({ ignoreSeen: manual });
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
async function mergeFrom(entry, { explicit = false, newest = '' } = {}) {
  await flush();
  const opts = explicit ? { explicit: true, onOlder: (list) => askReplaceNewer(entry.name, list) } : {};
  const res = await sync.loadAndMerge(entry, askSyncConflict, opts);
  if (res && explicit && newest && newest !== entry.name) prefs.set('sync.seen', newest);
  afterMerge(res, entry.name);
}

/**
 * バックアップから小説を1つ読み込む（「読み込む」「ファイルから選ぶ」のあと。どの OS・端末でも同じ）
 *   バックアップの中の小説を選び（今開いている小説と同じものがあれば、それが最初に選ばれている）、
 *   「上書き」… 今開いている小説を、選んだ小説の内容（タイトルから全部）で置き換える。置き換える前の内容は、作品のバックアップ版に残す
 *   「新小説」… 選んだ小説を、新しい小説として追加して開く
 *   「キャンセル」… 何もしない
 * newest：そのときいちばん新しいバックアップの名前。古いものをあえて選んだときは、次の起動で最新を勧めない
 * 戻り値：読み込んだら true（キャンセルは false）
 */
async function loadBackupAs(text, name, { newest = '' } = {}) {
  const backup = parseBackup(text);
  const novels = (backup.projects || []).filter((p) => p?.id).map((p) => normalize(p));
  if (!novels.length) { toast('このバックアップには小説が入っていません', true); return false; }
  const time = (p) => Date.parse(p.updatedAt || 0) || 0;
  novels.sort((a, b) => time(b) - time(a));
  const same = novels.find((p) => p.id === project.id);
  const label = (p) => `${p.title || '無題'}（${p.episodes.length}話・${fmtTime(p.updatedAt)} 更新）`;
  const cur = project.title || '無題';
  const r = await choose(`「${name}」から、小説を読み込みます。\n\n`
    + `・上書き：いま開いている小説「${cur}」を、選んだ小説の内容（タイトルから全部）で置き換えます。置き換える前の内容は「作品のバックアップ版」に残します。\n`
    + '・新小説：選んだ小説を、新しい小説として追加して開きます（いま開いている小説はそのまま残ります）。',
  [{ value: 'overwrite', label: '上書き', danger: true }, { value: 'new', label: '新小説', primary: true }],
  { select: { label: 'バックアップの中の小説', options: novels.map((p) => ({ value: p.id, label: label(p) })), value: (same || novels[0]).id } });
  if (!r) return false;
  const src = novels.find((p) => p.id === r.value);
  if (!src) { toast('読み込む小説を選んでください', true); return false; }
  await flush();
  const now = new Date().toISOString();
  if (r.choice === 'overwrite') {
    await saveVersion(`「${name}」で上書きする前（自動）`, '', true);
    const p = normalize({ ...structuredClone(src), id: project.id, workId: project.workId, links: project.links || {}, updatedAt: now });
    await db.put(p);
    showProject(p);
    syncPending = null;
    sync.markLoaded(name);
    if (newest && newest !== name) prefs.set('sync.seen', newest);
    await inform(`いま開いている小説を、「${name}」の「${src.title || '無題'}」の内容で上書きしました。\n（上書きする前の内容は、「設定」→「自動バックアップ」の「この作品のバックアップ版」に残しています）`);
  } else {
    const p = normalize({ ...structuredClone(src), id: format.makeId(), workId: format.makeId(), links: {}, updatedAt: now });
    await switchTo(p);
    syncPending = null;
    sync.markLoaded(name);
    if (newest && newest !== name) prefs.set('sync.seen', newest);
    await inform(`「${name}」の「${src.title || '無題'}」を、新しい小説として追加して開きました。\n（前に開いていた「${cur}」はそのまま残っています。「作品一覧」から開けます）`);
  }
  return true;
}

// 一覧に出ないバックアップ（ほかの場所に置いたものなど）を、ファイルを選んで読み込む
async function syncFromFile(mode) {
  const src = await openFrom('バックアップのファイルを選ぶ');
  if (!src) return false;
  if (!isBackup(src.text)) { toast('全体（バックアップ）のファイルではありません', true); return false; }
  if (mode === 'restore') { openRestoreDialog(src.text, src.name); return true; }
  const newest = (await sync.listAll().catch(() => []))[0]?.name;
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
    decide();
    dialog.close();
    syncPending = null;
    sync.markChecked(notice.entry);
    const ok = await sync.backupNow({ force: true });
    toast(ok ? 'この端末の記録を保存しました（これが最新になります）' : '保存できませんでした：' + (sync.getError() || ''), !ok);
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
    files = await sync.listAll();
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
      const act = isSync
        ? button('読み込む', async () => {
          // 一覧の画面は開いたまま、その上で「上書き／新小説／キャンセル」を聞く（キャンセルなら一覧に戻る）
          const text = await sync.read(f);
          if (!(await loadBackupAs(text, f.name, { newest: files[0].name }))) return;
          decide();
          dialog.close();
        }, f === files[0] ? 'primary' : '')
        : button('選ぶ', async () => {
          const text = await sync.read(f);
          $('sync-restore-dialog').close();
          openRestoreDialog(text, f.name);
        });
      list.append(listItem(f.name, tags.join('・'), [act]));
    }
  };
  filter.onchange = render;
  render();
}

async function exportPreSync() {
  const saved = await meta.get('preSyncBackup');
  if (!saved) { toast('同期の前の状態はありません'); return; }
  const d = new Date(saved.createdAt);
  const p = (n) => String(n).padStart(2, '0');
  const r = await localFile.saveAs(saved.text, `小説エディター_同期の前_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.json`, WORK_TYPES, 'application/json');
  if (r) toast('同期の前の状態を書き出しました（「ファイル」→ 全体の「開く」で戻せます）');
}

// ---------- クラウド（設定の「クラウド」タブ） ----------

function renderCloudActions() {
  const box = $('cloud-action-list');
  box.replaceChildren();
  for (const p of providers) {
    const section = Object.assign(document.createElement('div'), { className: 'cloud-provider' });
    section.append(Object.assign(document.createElement('strong'), { textContent: p.label }));
    if (!p.isConfigured()) {
      section.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '下の「クラウド接続の設定」にクライアントIDを入れると使えるようになります（入れ終わって欄を離れたときに反映されます）。' }));
      box.append(section);
      continue;
    }
    const row = Object.assign(document.createElement('div'), { className: 'button-row' });
    row.append(p.isSignedIn()
      ? button('ログアウト', () => { p.signOut(); renderCloudActions(); sync.refresh(); toast(p.label + 'からログアウトしました'); })
      : button('ログイン', async () => { await p.signIn(); renderCloudActions(); await syncResumeIfReady(); toast(p.label + 'にログインしました'); }));
    section.append(row);
    section.append(Object.assign(document.createElement('p'), {
      className: 'hint',
      textContent: '「ファイル」メニューで Google ドライブを使うか、この端末・その他を使うか（両方か）は、「ファイル」タブで選べます。',
    }));
    if (p.folderInfo) section.append(renderCloudFolder(p));
    section.append(Object.assign(document.createElement('p'), {
      className: 'hint',
      textContent: '自動バックアップ（同期）に Google ドライブを使うときは、「自動バックアップ」タブで保存先を「Google ドライブ」にしてください。バックアップ先のフォルダも、そのタブで選びます（下の保存先フォルダとは別）。',
    }));
    box.append(section);
  }
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
  // エディター内の画面で、マイドライブのフォルダを選ぶ・作る（iPhone・iPad でも使える）
  const choose = button('フォルダを選ぶ・作る…', async () => {
    const folder = await driveBrowse({ p, mode: 'folder', title: '保存先のフォルダを選ぶ' });
    if (!folder) return;
    p.setFolder(folder);
    after(folder);
  });
  row.append(choose);
  if (!f.isDefault) {
    row.append(button('「小説エディター」に戻す', async () => {
      if (!(await ask('保存先を、マイドライブの「小説エディター」フォルダに戻しますか？（保存済みのファイルは移動しません）'))) return;
      p.resetFolder();
      renderCloudActions();
      renderSyncState();
    }));
  }
  wrap.append(row, Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: '「ファイル」で Google ドライブに保存・開くとき、最初に開くフォルダです（端末ごとの設定）。自動バックアップの場所は「自動バックアップ」タブで決めます。'
      + '保存先を変えても、すでに保存したファイルは移動しません。同じフォルダに同じ名前のファイルがあるときは、上書きせずに名前の後ろに番号を付けます。',
  }));
  return wrap;
}

// ---------- コピー・編集補助 ----------

const copySources = {
  'novel-title': () => ['小説タイトル', project.title],
  synopsis: () => ['あらすじ', project.synopsis],
  'ep-title': () => ['エピソードタイトル', cur().title],
  foreword: () => ['前書き', convert(editSite, cur().foreword)],
  body: () => ['本文', convert(editSite, cur().body)],
  afterword: () => ['後書き', convert(editSite, cur().afterword)],
  'free-memo': () => ['フリーメモ', episode().freeMemo],
  plot: () => ['プロット', episode().plot],
  'x-text': () => ['X の投稿文', project.reports.x],
  'narou-report-title': () => ['活動報告のタイトル', project.reports.narouTitle],
  'narou-report-body': () => ['活動報告の本文', project.reports.narouBody],
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
});
const worldTable = categorizedTable($('world-tables'), () => project.world, { ...sectionOpts, columns: WORLD_COLUMNS, itemLabel: '項目' });
const characterTable = categorizedTable($('character-tables'), () => project.characters, { ...sectionOpts, columns: CHARACTER_COLUMNS, itemLabel: '人物' });

// TXT インポート（確定するまで作品は変更しない）
const importScreen = initImport({
  db, versions, meta, prefs, toast, fail,
  getProject: () => project,
  flush: () => flush(),
  switchTo: (p) => switchTo(p),
  closeSettings: () => $('settings-dialog').close(),
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

function renderReportView() {
  const sel = el.reportEpisode;
  const keep = sel.value === '' ? project.episodes.length - 1 : Number(sel.value);
  sel.replaceChildren();
  project.episodes.forEach((e, i) => sel.append(new Option(episodeName(e), String(i))));
  sel.value = String(Math.min(keep, project.episodes.length - 1));
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
  const index = Number(el.reportEpisode.value) || 0;
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

function openX() {
  const text = project.reports.x;
  if (!text) { toast('投稿文が空です'); return; }
  window.open('https://x.com/intent/post?text=' + encodeURIComponent(text), '_blank', 'noopener');
}

// ---------- リンク（よく使うサイト。全作品共通） ----------

const DEFAULT_LINKS = [
  { name: '小説家になろう', url: 'https://syosetu.com/' },
  { name: 'アルファポリス', url: 'https://www.alphapolis.co.jp/' },
  { name: 'みてみん', url: 'https://mitemin.net/' },
];

function links() {
  return prefs.get('links', null) || DEFAULT_LINKS;
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
    const b = button(l.name, () => { closeMenus(); openLink(l.url); });
    b.title = l.url;
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
    const name = Object.assign(document.createElement('input'), { type: 'text', value: l.name, placeholder: 'サイト名', autocomplete: 'off' });
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
      button('削除', async () => {
        if (!(await ask(`「${l.name || l.url || '（名前なし）'}」をリンクから外しますか？`, { danger: true }))) return;
        editingLinks.splice(i, 1);
        commitLinks();
        renderLinkEditor();
      }, 'tool danger'));
    list.append(item);
  });
}

// ---------- 設定 ----------

// 投稿サイトのアカウント（全作品共通・端末ごと）：{ narou: { userId, userName, author }, alpha: { ... } }
function accounts() {
  return { narou: {}, alpha: {}, ...(prefs.get('accounts', {}) || {}) };
}

// この作品の Nコード・作品ID（作品データ）。Nコードを入れたら、なろうの作品URL が空なら作る
function setWorkCode(kind, value) {
  const v = value.trim();
  if (kind === 'ncode') {
    project.narouNcode = v.toLowerCase();
    if (/^n\d{4}[a-z]{1,3}$/.test(project.narouNcode) && !project.narouUrl) {
      project.narouUrl = `https://ncode.syosetu.com/${project.narouNcode}/`;
      el.narouUrl.value = project.narouUrl;
    }
  } else {
    project.alphaWorkId = v;
  }
  changed();
}

function applyPrefs() {
  document.documentElement.dataset.font = prefs.get('font', 'serif');
  document.documentElement.style.setProperty('--body-size', prefs.get('fontSize', '18') + 'px');
  applyUiPrefs();
}

// ---------- 入力欄・ボタンの表示（端末ごとの設定。作品データには入れない） ----------
// 'show.foreword' などのキー。値が false のときだけ隠す（未設定は表示）

function uiPref(key) {
  return prefs.get('ui', {})[key] !== false;
}

function setUiPref(key, on) {
  prefs.set('ui', { ...prefs.get('ui', {}), [key]: on });
  applyUiPrefs();
}

function applyUiPrefs() {
  const cls = document.body.classList;
  for (const f of ['foreword', 'afterword', 'plot', 'memo']) cls.toggle('hide-' + f, !uiPref('show.' + f));
  cls.toggle('hide-side', !uiPref('show.plot') && !uiPref('show.memo'));
  for (const k of ['ep-title', 'body', 'foreword', 'afterword', 'plot', 'free-memo', 'main-to-sub']) cls.toggle('hide-copy-' + k, !uiPref('copy.' + k));
  for (const k of ['title', 'body', 'foreword', 'afterword', 'plot', 'memo']) cls.toggle('hide-max-' + k, !uiPref('max.' + k));
  cls.toggle('hide-max-tools', !uiPref('max.tools'));
  // プロット・メモの欄が隠れている状態でそのタブを開いていたら本文へ
  if (cls.contains('hide-side') && document.querySelector('[data-tab="side"][aria-selected="true"]')) selectTab('body');
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
  // 最大化中の iPhone で高さを決めてあれば、その高さにする
  const custom = maximized ? iphoneMaxHeight() : null;
  document.body.classList.toggle('max-custom-height', !!custom);
  const height = custom || vv?.height || window.innerHeight || document.documentElement.clientHeight;
  const width = vv?.width || window.innerWidth || document.documentElement.clientWidth;
  document.documentElement.style.setProperty('--vv-height', Math.round(height) + 'px');
  document.documentElement.style.setProperty('--vv-width', Math.round(width) + 'px');
  document.documentElement.style.setProperty('--vv-top', Math.round(vv?.offsetTop || 0) + 'px');
  document.documentElement.style.setProperty('--vv-left', Math.round(vv?.offsetLeft || 0) + 'px');
}

function maximizeField(field) {
  if (maximized) restoreMaximized();
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
}

function selectSettingsTab(name) {
  if (!document.querySelector(`[data-spanel="${name}"]`)) name = 'display'; // なくなったタブ（「ボタン」は「表示」に統合）
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
  form.font.value = prefs.get('font', 'serif');
  form.fontSize.value = prefs.get('fontSize', '18');
  form.autoBackupInterval.value = String(sync.intervalMin());
  form.autoBackupKeep.value = String(sync.keepCount());
  renderFileDestination();
  renderIphoneMaxSettings();
  $('sync-prefix').value = prefs.get('sync.prefix', '') || '';
  $('sync-prefix').placeholder = `${sync.defaultPrefix()}（この端末の既定）`;
  // 投稿サイトのアカウント（端末ごと）と、この作品の Nコード・作品ID
  const acc = accounts();
  form.querySelectorAll('[name^="acc."]').forEach((input) => {
    const [, site, key] = input.name.split('.');
    input.value = acc[site]?.[key] || '';
  });
  $('work-ncode').value = project.narouNcode || '';
  $('work-alpha-id').value = project.alphaWorkId || '';
  const box = $('provider-settings');
  box.querySelectorAll(':scope > :not(legend)').forEach((n) => n.remove());
  for (const p of providers) {
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
  document.querySelectorAll('[data-ui]').forEach((c) => { c.checked = uiPref(c.dataset.ui); });
  selectSettingsTab(tab);
  $('settings-dialog').showModal();
}

// ---------- 設定はすべて、変えた時点で反映・保存する（設定画面は「閉じる」だけ） ----------

// 「ファイル」メニューの保存先：Google ドライブを設定していなければ「この端末・その他」だけ
function renderFileDestination() {
  const dest = $('file-destination');
  const hasDrive = !!driveProvider();
  dest.querySelector('option[value="ask"]').disabled = !hasDrive;
  dest.querySelector('option[value="gdrive"]').disabled = !hasDrive;
  dest.value = hasDrive ? prefs.get(DEST_KEY, 'ask') : 'local';
  $('file-destination-hint').textContent = hasDrive ? ''
    : 'Google ドライブはまだ使えません（「クラウド」タブでクライアントIDを入れると選べます）。今は「この端末・その他」を使います。';
}

// リンク：入力中の行（URL が空のもの）は一覧に入れず、URL が入った行だけを残す
function commitLinks() {
  prefs.set('links', editingLinks
    .map((l) => ({ name: l.name.trim(), url: normalizeUrl(l.url) }))
    .filter((l) => l.url)
    .map((l) => ({ ...l, name: l.name || l.url })));
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
  form.font.addEventListener('change', () => { prefs.set('font', form.font.value); applyPrefs(); });
  form.fontSize.addEventListener('change', () => { prefs.set('fontSize', form.fontSize.value); applyPrefs(); });
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
  $('sync-prefix').addEventListener('change', (e) => {
    const v = sync.cleanPrefix(e.target.value.trim());
    e.target.value = v;
    prefs.set('sync.prefix', v);
    renderSyncState();
  });
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
  if (!sync.isDirty()) {
    const last = prefs.get('lastAutoBackupAt', null);
    toast(`変更はありません${last ? `（最後の保存 ${fmtTime(last)}）` : ''}`);
    return;
  }
  const ok = await sync.backupNow();
  if (ok) toast(`保存しました（${sync.folderName()}）`);
  else if (sync.isChecked() && sync.getState() === 'on') toast('保存できませんでした：' + (sync.getError() || '保存先を確認してください'), true);
  // 他の端末のほうが新しかったときは、sync.onNewer から確認の画面が出る
}

const actions = {
  'toggle-drawer': () => document.body.classList.toggle('drawer-open'),
  library: openLibrary,
  'new-project': createProject,
  settings: () => openSettings(),
  'all-open': () => allOpen(),
  'all-save-as': () => allSaveAs(),
  'sync-save': () => saveNow(),
  'ep-open': () => epOpen(),
  'ep-save-as': () => epSaveAs(),
  'import-text': importText,
  'export-episode': exportEpisode,
  'export-all': exportAll,
  'add-episode': () => addEpisode(),
  'add-chapter': addChapterFromList,
  'ep-version-up': episodeVersionUp,
  'max-restore': () => restoreMaximized(),
  'copy-main-to-sub': openSiteCopy,
  'open-import': () => importScreen.open(),
  'toggle-sort-dir': () => setEpisodeSort({ dir: epSort.dir === 'asc' ? 'desc' : 'asc' }),
  'project-version-save': openVersionSave,
  'manage-templates': () => { renderTemplateList(); $('templates-dialog').showModal(); },
  'open-x': openX,
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
    } else if (d.insert) {
      inserts[d.insert]();
    } else if (d.tab) {
      selectTab(d.tab);
    } else if (d.editSite) {
      setEditSite(d.editSite);
    } else if (d.view) {
      setView(d.view);
    } else if (d.ep !== undefined) {
      selectEpisode(Number(d.ep));
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
  bindDialog('image-dialog', () => insertImage($('image-form').url.value));
  bindDialog('template-edit-dialog', saveEditedTemplate);
  bindDialog('replace-dialog', runReplace);
  bindDialog('restore-dialog');
  bindDialog('site-copy-dialog', runSiteCopy);
  $('site-copy-form').addEventListener('change', updateSiteCopy);
  bindDialog('version-save-dialog', async () => {
    const form = $('version-save-form');
    const v = await saveVersion(form.name.value.trim() || '名前なし', form.memo.value.trim());
    toast(`作品全体を「${v.name}」として保存しました`);
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
  $('work-ncode').addEventListener('input', (e) => setWorkCode('ncode', e.target.value));
  $('work-alpha-id').addEventListener('input', (e) => setWorkCode('alpha', e.target.value));
  // 表示・ボタンの設定はチェックした時点で反映・保存する
  document.querySelectorAll('[data-ui]').forEach((c) => c.addEventListener('change', () => setUiPref(c.dataset.ui, c.checked)));
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
    vv.addEventListener('resize', fitVisualViewport);
    vv.addEventListener('scroll', fitVisualViewport);
  }
  window.addEventListener('resize', fitVisualViewport);
  document.addEventListener('focusin', (e) => {
    if (!maximized || e.target !== maximized.input) return;
    [0, 100, 350, 700].forEach((ms) => setTimeout(fitVisualViewport, ms));
  });
  fitVisualViewport();
  // 最大化中の「戻る」（Android の戻る操作・ブラウザの戻る）は、最大化を解除するだけにする
  window.addEventListener('popstate', () => { if (maximized) restoreMaximized(true); });
  // 最大化ボタンを押しても、入力欄のカーソル位置が変わらないようにする
  document.querySelectorAll('[data-max]').forEach((b) => b.addEventListener('pointerdown', (e) => e.preventDefault()));
  renderSortControls();
  $('ep-version').addEventListener('change', (e) => {
    const id = e.target.value;
    e.target.value = '';
    if (id) openVersion(id).catch(fail);
  });
  document.querySelectorAll('[data-stab]').forEach((b) => b.addEventListener('click', () => selectSettingsTab(b.dataset.stab)));
  bindDialog('version-dialog');
  $('version-form').addEventListener('submit', (e) => {
    const v = currentVersion;
    const act = { restore: restoreVersion, copy: copyVersion, delete: deleteVersion }[e.submitter?.value];
    if (v && act) Promise.resolve().then(() => act(v)).catch(fail);
  });
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
    flush().then(() => autoVersion(60_000)).catch(() => {});
    sync.flushNow();
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
    else if (m === 'gdrive' && sync.getState() === 'need-login') toast('「Google ドライブにログイン」を押してください');
    await runSyncCheck();
  });
  $('sync-choose').addEventListener('click', () => {
    // Google ドライブ方式でログイン済み：バックアップ先のフォルダを選ぶ（選んだフォルダに直接保存。中にフォルダは作らない）
    if (sync.mode() === 'gdrive' && sync.getState() !== 'need-login') {
      const p = syncProvider();
      driveBrowse({ p, mode: 'folder', title: '自動バックアップのフォルダを選ぶ' }).then(async (folder) => {
        if (!folder) return;
        p.setBackupFolder(folder);
        await sync.setMode('gdrive'); // 選び直したので、確認からやり直す
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
  $('sync-now').addEventListener('click', async () => {
    try {
      if (!sync.isChecked()) await runSyncCheck({ manual: true });
      if (syncPending) return;
      const ok = await sync.backupNow({ force: true });
      toast(ok ? '自動バックアップの保存先に保存しました' : '保存できませんでした：' + (sync.getError() || '保存先を確認してください'), !ok);
    } catch (err) { fail(err); }
  });
  $('sync-check').addEventListener('click', () => openSyncRestore('sync').catch(fail));
  $('sync-restore').addEventListener('click', () => openSyncRestore().catch(fail));
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

async function init() {
  $('app-version').textContent = `エディターの版：${APP_VERSION}`;
  applyPrefs();
  bindEvents();
  selectTab('body');
  $('template-vars').textContent = TEMPLATE_VARS.join(' ');
  renderTemplateSelects();
  providers.forEach((p) => p.preload());
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
  if (drive) drive.onBeforeRedirect = () => flush(); // Google のログインでページを離れる前に、書きかけを保存
  sync.onChange(renderSyncState);
  // 自動バックアップしようとしたら他の端末のほうが新しかった：画面が見えていれば、その場で確認する
  sync.onNewer(() => { if (document.visibilityState === 'visible') runSyncCheck().catch(fail); });
  await sync.init({ provider: drive }).catch((e) => console.warn('自動バックアップの準備に失敗', e));
  renderSyncState();
  const login = drive?.takeRedirectResult();
  const restored = prefs.get('restoredMessage', null);
  const report = prefs.get('restoredReport', null);
  if (login) toast(login.ok ? 'Google ドライブにログインしました' : login.message, !login.ok);
  else if (restored) toast(restored);
  if (restored) prefs.set('restoredMessage', null);
  if (report) prefs.set('restoredReport', null);
  if (!login && !restored && !report) setTimeout(() => remindBackup().catch(() => {}), 1500);
  // 読み込み・復元の結果を知らせてから、他の端末の更新を確認する（画面が重ならないように）
  if (report) await inform(report, { ok: 'OK' });
  runSyncCheck().catch((e) => console.warn('他の端末の更新の確認に失敗', e));

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker 登録失敗', e));
  }
}

init().catch(fail);
