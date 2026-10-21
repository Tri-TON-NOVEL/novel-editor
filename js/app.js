import { db, prefs, versions, meta } from './db.js';
import {
  newProject, newEpisode, normalize, fromSingle, serialize, parse, fileName, countChars,
  draftOf, DRAFT_FIELDS, SITE_KEYS,
} from './format.js';
import * as format from './format.js';
import { categorizedTable, chapterList, CHARACTER_COLUMNS, WORLD_COLUMNS } from './tables.js';
import { makeBackup, isBackup, parseBackup, restoreBackup, backupFileName, requestPersistence } from './backup.js';
import * as autoBackup from './autobackup.js';
import { initImport } from './importui.js';
import { ask, askText, choose } from './dialogs.js';
import {
  SITES, RUBY_LIMIT, SYMBOLS, ruby, dots, autoIndent, rubyCaretOffset, convert, convertText, countImages,
  miteminToTag, hasMiteminUrl, xLength, fillTemplate, TEMPLATE_VARS, DEFAULT_TEMPLATES, findImages,
} from './notation.js';
import { localFile, WORK_TYPES, TEXT_TYPES } from './localfile.js';
import { providers } from './providers/index.js';

const $ = (id) => document.getElementById(id);
const AUTOSAVE_MS = 600;
// 更新したら上げる（設定の「表示」タブに出るので、どの版が動いているか確認できる）
const APP_VERSION = '2026.10.22-3.12';

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
  chapter: $('ep-chapter'),
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
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isError ? 5000 : 2500);
}

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
  else if (dirty) parts.push('保存中…');
  else if (lastSavedAt) parts.push('保存済み ' + fmtTime(lastSavedAt));
  parts.push('メイン: ' + SITES[project.site].short);
  if (autoBackup.getState() === 'on') {
    const last = autoBackup.lastWrittenAt();
    parts.push('自動バックアップ' + (last ? ' ' + fmtTime(last) : ' 有効'));
  }
  if (fileHandle) parts.push('ファイル: ' + fileHandle.name);
  const autoP = cloudAutoProvider();
  for (const p of providers) {
    if (!project.links?.[p.id]) continue;
    if (p !== autoP) { parts.push(p.label + ' 連携'); continue; }
    const s = cloudAuto.state;
    parts.push(s === 'saved' ? `${p.label} 自動保存 ${fmtTime(cloudAuto.at)}`
      : s === 'need-login' ? `⚠ ${p.label} ログイン切れ（自動保存停止中）`
        : s === 'conflict' ? `⚠ ${p.label} ほかの端末で更新（自動保存停止中）`
          : s === 'error' ? `⚠ ${p.label} 自動保存に失敗 ${fmtTime(cloudAuto.at)}`
            : `${p.label} 連携・自動保存`);
  }
  $('status').textContent = parts.join(' ・ ');
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
  cloudDirty = true;
  autoBackup.schedule();
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
  const del = Object.assign(document.createElement('button'), {
    type: 'button', className: 'ep-delete', textContent: '削除', title: `「${episodeName(ep)}」を削除`,
  });
  del.dataset.epDelete = i;
  const item = Object.assign(document.createElement('li'), { className: 'ep-row' + (flat ? ' flat' : '') });
  item.append(b, del);
  return item;
}

function renderEpisodeList() {
  const list = $('episode-list');
  list.replaceChildren();
  const sort = EP_SORTS[epSort.key];
  // 「章なし」は章を抜きにして、全エピソードを選択した条件で並べる
  if (!epSort.grouped) {
    for (const i of sortedEpisodeIndexes()) list.append(episodeRow(i, sort, true));
    renderChapterSelect();
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
  renderChapterSelect();
}

// エピソード画面の「章」プルダウン
function renderChapterSelect() {
  const sel = el.chapter;
  sel.replaceChildren(...project.chapters.map((c) => new Option(chapterName(c), c.id)), new Option('未分類', ''));
  sel.value = episode()?.chapterId || '';
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

// エピソードを別の章（または未分類）へ移す。移した先の章の最後に並べる
function moveEpisodeToChapter(chapterId) {
  const ep = episode();
  const to = chapterId || null;
  if (ep.chapterId === to) return;
  ep.chapterId = to;
  project.episodes.splice(epIndex, 1);
  project.episodes.push(ep);
  epIndex = project.episodes.length - 1;
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
  if (project?.id !== p.id) {
    cloudDirty = false;
    lastCloudAutoAt = Date.now();
    cloudAuto = { state: '', at: null };
    saveTarget = null;
  }
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
  await cloudAutoSave(60_000).catch(() => {});
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

// ↑↓：同じ章の中で前後と入れ替える
function moveEpisode(delta) {
  if (epSort.key !== 'file') {
    toast('↑↓での並べ替えは、目次の並び順が「ファイル順」のときに使えます');
    return;
  }
  if (epSort.dir === 'desc') delta = -delta; // 降順表示では見た目の上下に合わせる
  const group = episodeGroups().find((g) => g.indexes.includes(epIndex)).indexes;
  const to = group[group.indexOf(epIndex) + delta];
  if (to === undefined) {
    toast(delta < 0 ? 'この章の最初のエピソードです（別の章へは「章」で移せます）' : 'この章の最後のエピソードです（別の章へは「章」で移せます）');
    return;
  }
  const eps = project.episodes;
  [eps[epIndex], eps[to]] = [eps[to], eps[epIndex]];
  changed();
  selectEpisode(to);
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
    + '（「ファイルに保存」やバックアップ、クラウドに保存したものは残ります）\n本当に削除しますか？'))) return false;
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
let saveTarget = null; // 上書き保存の行き先（前回保存・開いた場所）：'local' | 'gdrive'

function driveProvider() {
  return providers.find((p) => p.isConfigured() && p.save) || null;
}

async function chooseDestination(kind, { force = false } = {}) {
  const p = driveProvider();
  if (!p) return 'local';
  const pref = prefs.get(DEST_KEY, 'ask');
  if (!force && pref !== 'ask') return pref;
  const last = prefs.get('file.lastDestination', 'local');
  const drive = { value: 'gdrive', label: p.label, primary: last === 'gdrive' };
  const local = { value: 'local', label: 'この端末・その他（iCloud・OneDrive など）', primary: last !== 'gdrive' };
  // 前回使ったほうを右端（目立つボタン）に置く
  const r = await choose(kind === 'open' ? 'どこから開きますか？' : 'どこに保存しますか？', last === 'gdrive' ? [local, drive] : [drive, local]);
  if (r) prefs.set('file.lastDestination', r);
  return r;
}

// 保存先を優先にしているときでも、もう一方を選べるメニュー項目
function updateFileMenu() {
  const show = !!driveProvider() && prefs.get(DEST_KEY, 'ask') !== 'ask';
  document.querySelectorAll('[data-dest-choose]').forEach((b) => { b.hidden = !show; });
}

// Google ドライブに保存する画面。job: { p, title, name, text, workId, onSaved(id), onLocal() }
let driveSaveJob = null;

function openDriveSave(job) {
  driveSaveJob = job;
  $('drive-save-title').textContent = job.title;
  $('drive-save-name').value = job.name;
  $('drive-save-folder').textContent = `保存先フォルダ：${job.p.folderInfo?.().name ?? job.p.label}`;
  $('drive-save-dialog').showModal();
  renderDriveSaveList();
}

async function renderDriveSaveList() {
  const job = driveSaveJob;
  const list = $('drive-save-list');
  if (!job) return;
  // ログイン画面は、押したとき以外は出せない（iPhone・iPad）。ログインしていなければボタンを出す
  if (job.p.canSaveSilently && !job.p.canSaveSilently()) {
    list.replaceChildren(listItem('ファイルの一覧を見るには、ログインが必要です', '「保存」を押したときにもログインします', [
      button('ログインして一覧を見る', async () => { await job.p.signIn(); renderDriveSaveList(); }),
    ]));
    return;
  }
  list.replaceChildren(li('empty', '読み込み中…'));
  let files;
  try {
    files = await job.p.list();
  } catch (e) {
    list.replaceChildren(li('empty', '一覧を読み込めませんでした：' + e.message));
    return;
  }
  if (driveSaveJob !== job) return;
  list.replaceChildren();
  if (!files.length) { list.append(li('empty', 'まだ保存したファイルはありません')); return; }
  for (const f of files) {
    list.append(listItem(f.name, '更新 ' + fmtTime(f.modifiedTime), [
      button('上書き', async () => {
        if (!(await ask(`「${f.name}」を、今の内容で上書きしますか？\n（前の内容は ${job.p.label} の「版を管理」から戻せます）`, { ok: '上書きする' }))) return;
        await runDriveSave(f.name, f.id);
      }, 'danger'),
    ]));
  }
}

async function runDriveSave(name, fileId = null) {
  const job = driveSaveJob;
  if (!job) return;
  let finalName = name.trim() || job.name;
  if (!/\.json$/i.test(finalName)) finalName += '.json';
  const id = await job.p.save(job.text, finalName, fileId, { workId: job.workId });
  driveSaveJob = null;
  $('drive-save-dialog').close();
  prefs.set('file.lastDestination', 'gdrive');
  await job.onSaved(id, finalName);
}

async function fileOpen({ force = false } = {}) {
  const dest = await chooseDestination('open', { force });
  if (dest === 'gdrive') return cloudOpen(driveProvider());
  if (dest !== 'local') return;
  const r = await localFile.open();
  if (!r) return;
  if (isBackup(r.text)) { openRestoreDialog(r.text, r.name); return; }
  await switchTo(await importContent(parse(r.text, r.name)), r.handle);
  saveTarget = 'local';
  toast(`「${r.name}」を開きました`);
}

// 上書き保存：前回保存・開いた場所へ（画面は出さない）。行き先が分からなければ「名前を付けて保存」
async function fileSave() {
  const p = driveProvider();
  const linked = p && project.links?.[p.id];
  if (linked && (saveTarget === 'gdrive' || (!saveTarget && !fileHandle))) return cloudSave(p);
  if (!fileHandle) return fileSaveAs();
  await flush();
  await localFile.write(fileHandle, serialize(project));
  saveTarget = 'local';
  toast(`「${fileHandle.name}」に保存しました`);
  updateStatus();
}

async function fileSaveAs({ force = false } = {}) {
  // 保存の画面は押した直後に出す（端末内への保存は並行して行う）
  const text = serialize(project);
  flush().catch(fail);
  const dest = await chooseDestination('save', { force });
  if (dest === 'gdrive') {
    const p = driveProvider();
    openDriveSave({
      p,
      title: `${p.label}に保存（この作品）`,
      name: fileName(project.title, '.json'),
      text,
      workId: project.workId,
      onSaved: async (id, name) => {
        project.links = { ...project.links, [p.id]: id };
        await db.put(project);
        saveTarget = 'gdrive';
        lastCloudAutoAt = Date.now();
        setCloudAuto('saved');
        toast(`${p.label}に「${name}」として保存しました`);
      },
      onLocal: () => saveWorkLocal(text),
    });
    return;
  }
  if (dest === 'local') await saveWorkLocal(text);
}

async function saveWorkLocal(text) {
  const r = await localFile.saveAs(text, fileName(project.title, '.json'), WORK_TYPES, 'application/json');
  if (!r) return;
  prefs.set('file.lastDestination', 'local');
  saveTarget = 'local';
  if (r === 'downloaded') {
    toast('ファイルを書き出しました（「ダウンロード」フォルダ）');
  } else if (r === 'shared') {
    toast('ファイルを渡しました（共有メニューで選んだ保存先）');
  } else {
    fileHandle = r;
    toast(`「${r.name}」に保存しました`);
  }
  updateStatus();
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

async function backupAll({ force = false } = {}) {
  await flush();
  const { text, count, versionCount } = await makeBackup();
  const done = () => {
    prefs.set('lastBackupAt', new Date().toISOString());
    toast(`${count}作品（バージョン${versionCount}件）と、ひな型・設定をバックアップしました`);
  };
  const local = async () => {
    // iPhone・iPad では共有メニューが出るので、「"ファイル"に保存」を選んでもらう
    if (localFile.saveMethod === 'share') toast('共有メニューが開きます。「"ファイル"に保存」を選ぶと、保存先（iCloud Drive など）を選べます');
    const r = await localFile.saveAs(text, backupFileName(), WORK_TYPES, 'application/json');
    if (!r) return;
    prefs.set('file.lastDestination', 'local');
    done();
  };
  const dest = await chooseDestination('save', { force });
  if (dest === 'gdrive') {
    const p = driveProvider();
    openDriveSave({ p, title: `${p.label}にバックアップ（すべての作品）`, name: backupFileName(), text, workId: '', onSaved: done, onLocal: local });
    return;
  }
  if (dest === 'local') await local();
}

let pendingBackup = null;
function openRestoreDialog(text, name = '') {
  pendingBackup = parseBackup(text);
  const when = pendingBackup.createdAt ? new Date(pendingBackup.createdAt).toLocaleString('ja-JP') : '不明';
  const titles = pendingBackup.projects.map((p) => p.title || '（無題）');
  $('restore-info').textContent =
    `${name ? `「${name}」\n` : ''}作成日時：${when}\n作品：${titles.length}件（${titles.slice(0, 5).join('、')}${titles.length > 5 ? ' ほか' : ''}）\nひな型・設定も戻します。`;
  $('restore-dialog').showModal();
}

async function restoreFromFile() {
  const dest = await chooseDestination('open');
  if (dest === 'gdrive') return cloudOpen(driveProvider());
  if (dest !== 'local') return;
  const r = await localFile.open();
  if (!r) return;
  openRestoreDialog(r.text, r.name);
}

async function runRestore(mode) {
  if (!pendingBackup) return;
  if (mode === 'replace' && !(await ask('【最終確認】この端末の作品をすべて消して、バックアップの内容に入れ替えます。よろしいですか？'))) return;
  await flush();
  const n = await restoreBackup(pendingBackup, mode);
  pendingBackup = null;
  prefs.set('restoredMessage', `${n}作品をバックアップから復元しました`);
  location.reload();
}

async function remindBackup() {
  const projects = await db.all();
  if (!projects.some((p) => !isEmptyProject(normalize(p)))) return;
  const last = prefs.get('lastBackupAt', null);
  const days = last ? Math.floor((Date.now() - new Date(last)) / 86400000) : null;
  if (days === null || days >= BACKUP_REMIND_DAYS) {
    toast(days === null
      ? 'まだ全体のバックアップがありません。「ファイル」→「すべてをバックアップ」で保存しておくと安心です'
      : `最後のバックアップから${days}日たっています。「ファイル」→「すべてをバックアップ」をおすすめします`);
  }
}

// 書き出しは、いま編集している側（なろう用／アルファ用）の原稿
async function exportEpisode() {
  const d = cur();
  if (!d.body) { toast('本文は空です'); return; }
  const name = fileName(`${project.title || '無題'}_${d.title || epIndex + 1}`, '.txt');
  const r = await localFile.saveAs(convert(editSite, d.body), name, TEXT_TYPES, 'text/plain');
  if (r) toast(`「${d.title || '（無題）'}」を書き出しました（${SITES[editSite].short}用）`);
}

async function exportAll() {
  const text = project.episodes
    .map((e) => draftOf(e, editSite))
    .map((d) => `${d.title}\n\n${convert(editSite, d.body)}`)
    .join('\n\n――――――――――\n\n');
  const head = project.title ? project.title + '\n\n' : '';
  const r = await localFile.saveAs(head + text, fileName(`${project.title || '無題'}_${SITES[editSite].short}`, '.txt'), TEXT_TYPES, 'text/plain');
  if (r) toast(`全${project.episodes.length}話を書き出しました（${SITES[editSite].short}用）`);
}

// ---------- クラウド ----------

async function cloudSave(p) {
  await flush();
  const wasDirty = cloudDirty;
  cloudDirty = false;
  let id;
  try {
    id = await p.save(serialize(project), fileName(project.title, '.json'), project.links?.[p.id], { workId: project.workId });
  } catch (e) {
    cloudDirty = cloudDirty || wasDirty;
    throw e;
  }
  project.links = { ...project.links, [p.id]: id };
  await db.put(project);
  saveTarget = 'gdrive';
  lastCloudAutoAt = Date.now();
  setCloudAuto('saved');
  toast(`${p.label}に保存しました${p.autoSave && prefs.get('cloud.autoSave', true) ? '（以後は自動でも保存します）' : ''}`);
}

// ---------- クラウドへの自動保存 ----------
// 連携している作品（一度クラウドに保存した、またはクラウドから開いた作品）だけ。
// 変更があるときだけ、書いている間は10分ごと、画面を閉じる・別のアプリや作品に切り替えるときにも（前回から1分以上たっていれば）。
// ログイン画面は出さない（iPhone・iPad ではボタンを押したとき以外は出せない）。ログインが切れたら、上に再ログインのボタンを出す。
// ほかの端末でドライブ側が更新されていたら、上書きせずに知らせる。
const CLOUD_AUTO_MS = 10 * 60_000;
let cloudDirty = false;
let lastCloudAutoAt = Date.now();
let cloudAutoRunning = false;
// state: '' | 'saved' | 'need-login'（ログイン切れ） | 'conflict'（ほかで更新） | 'unknown'（この端末で保存した記録なし） | 'error'
let cloudAuto = { state: '', at: null };

function cloudAutoProvider() {
  if (!project || !prefs.get('cloud.autoSave', true)) return null;
  return providers.find((p) => p.autoSave && project.links?.[p.id] && p.isConfigured()) || null;
}

function setCloudAuto(state, message = '') {
  cloudAuto = { state, at: Date.now(), message };
  renderCloudAttention();
  if (project) updateStatus();
}

async function cloudAutoSave(minInterval = CLOUD_AUTO_MS) {
  const p = cloudAutoProvider();
  if (!p || !cloudDirty || cloudAutoRunning || Date.now() - lastCloudAutoAt < minInterval) return;
  if (cloudAuto.state === 'conflict') return; // どちらを残すか決めるまで、自動では上書きしない
  cloudAutoRunning = true;
  cloudDirty = false; // 保存中に書いた分は、また true になる
  try {
    await flush();
    const r = await p.autoSave(serialize(project), fileName(project.title, '.json'), project.links[p.id], { workId: project.workId });
    if (r === 'saved') lastCloudAutoAt = Date.now();
    else cloudDirty = true;
    setCloudAuto(r);
  } catch (e) {
    cloudDirty = true;
    lastCloudAutoAt = Date.now(); // 通信の失敗などは、次の間隔でもう一度
    setCloudAuto('error', e.message);
  } finally {
    cloudAutoRunning = false;
  }
}

// 上の「⚠」ボタン：自動保存を続けるために、押してもらう必要があるとき
function renderCloudAttention() {
  const b = $('cloud-attention');
  const p = cloudAutoProvider();
  const text = !p ? ''
    : cloudAuto.state === 'need-login' ? `⚠ ${p.label}に再ログイン`
      : cloudAuto.state === 'conflict' ? `⚠ ${p.label}：ほかの端末で更新`
        : cloudAuto.state === 'unknown' ? `${p.label}に保存して自動保存を始める`
          : '';
  b.textContent = text;
  b.hidden = !text;
}

async function resolveCloudAttention() {
  const p = cloudAutoProvider();
  if (!p) return;
  if (cloudAuto.state === 'need-login') {
    await p.signIn();
    setCloudAuto('');
    await cloudAutoSave(0);
    if (cloudAuto.state === 'saved' || !cloudDirty) toast(`${p.label}にログインしました。自動保存を続けます`);
    return;
  }
  if (cloudAuto.state === 'conflict') {
    const ok = await ask(`${p.label}のファイルが、ほかの端末（または別のタブ）で更新されています。\n` +
      'この端末の内容で上書き保存しますか？\n\n' +
      `・上書きしても、前の内容は${p.label}の「版を管理」から戻せます。\n` +
      `・${p.label}側の内容を使うときは「キャンセル」を押し、「ファイル」→「${p.label}から開く…」で開いてください（自動保存は止まったままです）。`,
    { ok: '上書き保存', danger: true });
    if (!ok) return;
  }
  await cloudSave(p);
}

async function cloudOpen(p) {
  await flush();
  const dialog = $('cloud-dialog');
  const list = $('cloud-list');
  $('cloud-dialog-title').textContent = p.label + 'から開く';
  list.replaceChildren(li('empty', '読み込み中…'));
  dialog.showModal();
  let files;
  try {
    files = await p.list();
  } catch (e) {
    dialog.close();
    throw e;
  }
  list.replaceChildren();
  if (!files.length) { list.append(li('empty', `${p.label}に保存した作品はまだありません`)); return; }
  for (const f of files) {
    const open = button('開く', async () => {
      dialog.close();
      const text = await p.load(f.id);
      // 全体バックアップのファイルなら、復元の画面へ
      if (isBackup(text)) { openRestoreDialog(text, f.name); return; }
      const content = parse(text, f.name);
      await switchTo(await importContent(content, { [p.id]: f.id }));
      saveTarget = 'gdrive';
      prefs.set('file.lastDestination', 'gdrive');
      toast(`${p.label}から「${content.title || '無題'}」を開きました`);
    });
    list.append(listItem(f.name.replace(/\.json$/i, ''), '更新 ' + fmtTime(f.modifiedTime), [open]));
  }
}

// 設定の「クラウド」タブ：保存・開く・ログインのボタン
function renderCloudActions() {
  const box = $('cloud-action-list');
  box.replaceChildren();
  updateFileMenu();
  for (const p of providers) {
    const section = Object.assign(document.createElement('div'), { className: 'cloud-provider' });
    section.append(Object.assign(document.createElement('strong'), { textContent: p.label }));
    const row = Object.assign(document.createElement('div'), { className: 'button-row' });
    if (!p.isConfigured()) {
      section.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '下の「クラウド接続の設定」にクライアントIDを入れて「保存」を押すと使えるようになります。' }));
    } else {
      row.append(
        button(`${p.label}に保存`, () => cloudSave(p)),
        button(`${p.label}から開く…`, () => { $('settings-dialog').close(); return cloudOpen(p); }),
        p.isSignedIn()
          ? button('ログアウト', () => { p.signOut(); renderCloudActions(); toast(p.label + 'からログアウトしました'); })
          : button('ログイン', async () => { await p.signIn(); renderCloudActions(); toast(p.label + 'にログインしました'); }));
      section.append(row);
      if (project.links?.[p.id]) section.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: 'この作品は保存先と連携しています（Ctrl+S／⌘S でも保存できます）。' }));
      if (p.save) {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', '保存・開くときの保存先');
        for (const [v, t] of [['ask', '毎回どちらか選ぶ'], ['gdrive', `${p.label}を優先`], ['local', 'この端末・その他（iCloud・OneDrive など）を優先']]) sel.append(new Option(t, v));
        sel.value = prefs.get(DEST_KEY, 'ask');
        sel.addEventListener('change', () => {
          prefs.set(DEST_KEY, sel.value);
          updateFileMenu();
          toast('保存・開くときの保存先を「' + sel.selectedOptions[0].textContent + '」にしました');
        });
        const wrap = Object.assign(document.createElement('label'), { className: 'dest-select' });
        wrap.append('保存・開くときの保存先（この端末）', sel);
        section.append(wrap, Object.assign(document.createElement('p'), {
          className: 'hint',
          textContent: '「ファイル」の開く・保存・名前を付けて保存と「すべてをバックアップ」で使います。優先にしたときも、「ファイル」→「保存先を選んで…」でもう一方を使えます。上書き保存は、前回保存・開いた場所へそのまま保存します。',
        }));
      }
      if (p.autoSave) {
        const check =Object.assign(document.createElement('input'), { type: 'checkbox', checked: prefs.get('cloud.autoSave', true) });
        check.addEventListener('change', () => {
          prefs.set('cloud.autoSave', check.checked);
          renderCloudAttention();
          updateStatus();
          toast(check.checked ? `${p.label}への自動保存をオンにしました` : `${p.label}への自動保存をオフにしました`);
        });
        const label = Object.assign(document.createElement('label'), { className: 'inline' });
        label.append(check, ` 連携している作品を${p.label}にも自動で保存する（この端末）`);
        section.append(label, Object.assign(document.createElement('p'), {
          className: 'hint',
          textContent: '変更があるときだけ、書いている間は10分ごと、ホーム画面に戻る・別のアプリや作品に切り替えるときにも保存します。' +
            'ログインは約1時間で切れるので、切れたら上に出る「再ログイン」を押してください。ほかの端末で更新されていたら、上書きせずに知らせます。',
        }));
      }
      if (p.folderInfo) section.append(renderCloudFolder(p));
    }
    box.append(section);
  }
}

// 画面の最前面に出ている確認・設定画面（showModal）より前に、外部の画面（Google Picker など）は出せない。
// その間だけ閉じておき、終わったら同じ状態で開き直す（入力内容やスクロール位置はそのまま）。
async function aboveDialogs(fn) {
  const opened = [...document.querySelectorAll('dialog[open]')].filter((d) => d.matches(':modal'));
  const scrolls = opened.map((d) => [d, ...d.querySelectorAll('*')].filter((n) => n.scrollTop > 0).map((n) => [n, n.scrollTop]));
  opened.forEach((d) => d.close());
  try {
    return await fn();
  } finally {
    opened.forEach((d, i) => {
      if (!d.open) d.showModal();
      for (const [n, top] of scrolls[i]) n.scrollTop = top;
    });
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
    toast(`保存先を「${folder.name}」にしました。すでに保存したファイルは元のフォルダに残り、次に新しく保存するファイルからこのフォルダに入ります`);
  };
  const pick = button('フォルダを選ぶ（Google Picker）…', async () => after(await aboveDialogs(() => p.pickFolder())));
  pick.disabled = !p.canPickFolder();
  if (!p.canPickFolder()) pick.title = '下の設定に Google API キーを入れると使えます';
  row.append(pick, button('新しいフォルダを作って使う…', async () => {
    const name = await askText('新しいフォルダの名前（Google ドライブのマイドライブに作ります）', '小説');
    if (!name || !name.trim()) return;
    after(await p.createFolder(name.trim()));
  }));
  if (!f.isDefault) {
    row.append(button('自動のフォルダに戻す', async () => {
      if (!(await ask('保存先を、自動で作る「小説エディター」フォルダに戻しますか？（保存済みのファイルは移動しません）'))) return;
      p.resetFolder();
      renderCloudActions();
    }));
  }
  wrap.append(row, Object.assign(document.createElement('p'), {
    className: 'hint',
    textContent: '保存先を変えても、すでに保存したファイルは移動しません（この作品が連携済みなら、これまでどおり同じファイルを更新します）。同じフォルダに同じ名前の別の作品があるときは、上書きせずに名前の後ろに番号を付けます。',
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
    name.addEventListener('input', () => { l.name = name.value; });
    url.addEventListener('input', () => { l.url = url.value; });
    const move = (d) => {
      const j = i + d;
      if (j < 0 || j >= editingLinks.length) return;
      [editingLinks[i], editingLinks[j]] = [editingLinks[j], editingLinks[i]];
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

function fitVisualViewport() {
  const vv = window.visualViewport;
  const height = vv?.height || window.innerHeight || document.documentElement.clientHeight;
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
  document.querySelectorAll('[data-stab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.stab === name)));
  document.querySelectorAll('[data-spanel]').forEach((p) => { p.hidden = p.dataset.spanel !== name; });
  prefs.set('settingsTab', name);
  if (name === 'backup') renderProjectVersions().catch(fail);
  if (name === 'cloud') renderCloudActions();
}

function openSettings(tab = prefs.get('settingsTab', 'display')) {
  const form = $('settings-form');
  form.font.value = prefs.get('font', 'serif');
  form.fontSize.value = prefs.get('fontSize', '18');
  form.autoBackupInterval.value = String(autoBackup.intervalMin());
  form.autoBackupKeep.value = String(autoBackup.keepCount());
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
      label.append(Object.assign(document.createElement('input'), {
        type: 'text', name: s.key, value: prefs.get(s.key, ''), placeholder: s.placeholder || '', autocomplete: 'off', spellcheck: false,
      }));
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

function saveSettings() {
  const form = $('settings-form');
  prefs.set('font', form.font.value);
  prefs.set('fontSize', form.fontSize.value);
  prefs.set('autoBackupInterval', Number(form.autoBackupInterval.value) || autoBackup.DEFAULT_INTERVAL_MIN);
  prefs.set('autoBackupKeep', Math.min(2000, Math.max(10, Number(form.autoBackupKeep.value) || autoBackup.DEFAULT_KEEP)));
  const acc = { narou: {}, alpha: {} };
  form.querySelectorAll('[name^="acc."]').forEach((input) => {
    const [, site, key] = input.name.split('.');
    acc[site][key] = input.value.trim();
  });
  prefs.set('accounts', acc);
  renderAutoBackupState(autoBackup.getState());
  prefs.set('links', editingLinks
    .map((l) => ({ name: l.name.trim(), url: normalizeUrl(l.url) }))
    .filter((l) => l.url)
    .map((l) => ({ ...l, name: l.name || l.url })));
  for (const p of providers) {
    for (const s of p.settings) {
      const v = form.elements[s.key].value.trim();
      if (v !== prefs.get(s.key, '')) { prefs.set(s.key, v); p.signOut(); }
    }
    p.preload();
  }
  applyPrefs();
  toast('設定を保存しました');
}

// ---------- イベント ----------

function closeMenus(except) {
  document.querySelectorAll('details.menu[open]').forEach((d) => { if (d !== except) d.open = false; });
}

function quickSave() {
  return fileSave();
}

const actions = {
  'toggle-drawer': () => document.body.classList.toggle('drawer-open'),
  library: openLibrary,
  'new-project': createProject,
  settings: () => openSettings(),
  'file-open': fileOpen,
  'file-save': fileSave,
  'file-save-as': fileSaveAs,
  'export-episode': exportEpisode,
  'export-all': exportAll,
  'add-episode': () => addEpisode(),
  'add-chapter': addChapterFromList,
  'move-up': () => moveEpisode(-1),
  'move-down': () => moveEpisode(1),
  'ep-version-up': episodeVersionUp,
  'export-pre-v3': exportPreV3Backup,
  'max-restore': () => restoreMaximized(),
  'copy-main-to-sub': openSiteCopy,
  'open-import': () => importScreen.open(),
  'toggle-sort-dir': () => setEpisodeSort({ dir: epSort.dir === 'asc' ? 'desc' : 'asc' }),
  'project-version-save': openVersionSave,
  'manage-templates': () => { renderTemplateList(); $('templates-dialog').showModal(); },
  'open-x': openX,
  'auto-indent': runAutoIndent,
  replace: openReplace,
  backup: backupAll,
  restore: restoreFromFile,
  undo: () => undoRedo('undo'),
  redo: () => undoRedo('redo'),
  'cloud-attention': () => resolveCloudAttention(),
  'file-open-choose': () => fileOpen({ force: true }),
  'file-save-choose': () => fileSaveAs({ force: true }),
  'autobackup-resume': () => autoBackup.resume()
    .then((ok) => toast(ok ? '自動バックアップを再開しました' : '書き込みが許可されませんでした', !ok)),
};

// 自動バックアップの状態を画面に出す
function renderAutoBackupState(state) {
  $('autobackup-resume').hidden = state !== 'need-permission';
  const last = autoBackup.lastWrittenAt();
  const lastText = last ? `（最後の保存 ${fmtTime(last)}）` : '';
  const text = !autoBackup.supported
    ? 'このブラウザでは使えません（Windows・Mac の Chrome / Edge で使えます）。iPad では自動バージョンと「すべてをバックアップ」を使ってください。'
    : state === 'on' ? `✅ 「${autoBackup.folderName()}」に${autoBackup.intervalMin()}分ごと・最新${autoBackup.keepCount()}件で自動保存しています${lastText}`
      : state === 'need-permission' ? `⚠ 「${autoBackup.folderName()}」への書き込みの許可が切れています。上の「自動バックアップを再開」を押してください${lastText}`
        : '止まっています。フォルダを選ぶと始まります。';
  $('autobackup-status').textContent = text;
  // 使えないブラウザ（iPhone・iPad など）では、ボタン・保存間隔・説明を出さない
  $('autobackup-buttons').hidden = !autoBackup.supported;
  document.querySelector('#autobackup-settings .autobackup-options').hidden = !autoBackup.supported;
  $('autobackup-hint').hidden = !autoBackup.supported;
  $('autobackup-now').disabled = state !== 'on';
  $('autobackup-stop').disabled = state === 'off';
  if (project) updateStatus();
}

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
    } else if (d.epDelete !== undefined) {
      deleteEpisode(Number(d.epDelete)).catch(fail);
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

  document.querySelectorAll('details.menu').forEach((d) => d.addEventListener('toggle', () => {
    if (!d.open) return;
    closeMenus(d);
    if (d.id === 'links-menu') buildLinksMenu();
    if (d.id === 'image-menu') buildImageMenu();
  }));

  bindDialog('settings-dialog', saveSettings);
  bindDialog('drive-save-dialog');
  // Google ドライブに保存：押したその場で保存を始める（ログイン画面を出すことがあるため）
  $('drive-save-form').addEventListener('submit', (e) => {
    e.preventDefault();
    try { runDriveSave($('drive-save-name').value).catch(fail); } catch (err) { fail(err); }
  });
  $('drive-save-local').addEventListener('click', () => {
    const job = driveSaveJob;
    driveSaveJob = null;
    $('drive-save-dialog').close();
    if (job) { try { Promise.resolve(job.onLocal()).catch(fail); } catch (err) { fail(err); } }
  });
  $('drive-save-dialog').addEventListener('close', () => { driveSaveJob = null; });
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
  $('ep-grouping').addEventListener('change', (e) => setEpisodeSort({ grouped: e.target.value === 'chapters' }));
  el.chapter.addEventListener('change', (e) => moveEpisodeToChapter(e.target.value));
  $('work-ncode').addEventListener('input', (e) => setWorkCode('ncode', e.target.value));
  $('work-alpha-id').addEventListener('input', (e) => setWorkCode('alpha', e.target.value));
  // 表示・ボタンの設定はチェックした時点で反映・保存する
  document.querySelectorAll('[data-ui]').forEach((c) => c.addEventListener('change', () => setUiPref(c.dataset.ui, c.checked)));
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
    autoBackup.flushNow();
    cloudAutoSave(60_000).catch(() => {});
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onLeave(); });
  window.addEventListener('pagehide', onLeave);
  setInterval(() => autoVersion().catch(() => {}), 60_000);
  setInterval(() => cloudAutoSave().catch(() => {}), 60_000);

  $('autobackup-choose').addEventListener('click', () => autoBackup.chooseFolder()
    .then((ok) => { if (ok) toast(`「${autoBackup.folderName()}」への自動バックアップを始めました`); }).catch(fail));
  $('autobackup-now').addEventListener('click', () => autoBackup.runNow()
    .then((ok) => toast(ok ? '自動バックアップのフォルダに保存しました' : '先にフォルダを選んでください')).catch(fail));
  $('autobackup-stop').addEventListener('click', async () => {
    if (!(await ask('自動バックアップを止めますか？（これまでのバックアップファイルは消えません）'))) return;
    autoBackup.stop().then(() => toast('自動バックアップを止めました')).catch(fail);
  });
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

// 退避した v3 移行前のデータを、全体バックアップと同じ形式のファイルとして書き出す
async function exportPreV3Backup() {
  const saved = await meta.get('preV3Backup');
  if (!saved) { toast('移行前のデータはありません'); return; }
  const text = JSON.stringify({ format: 'novel-editor-backup', version: 1, createdAt: saved.createdAt, projects: saved.projects, prefs: {} }, null, 1);
  const r = await localFile.saveAs(text, '小説エディター_v3移行前のデータ.json', WORK_TYPES, 'application/json');
  if (r) toast('移行前のデータを書き出しました');
}

// 思わぬエラーは画面に出す（ボタンが「無反応」に見えないように）
window.addEventListener('error', (e) => toast('エラー：' + (e.message || '不明なエラー'), true));
window.addEventListener('unhandledrejection', (e) => toast('エラー：' + (e.reason?.message || String(e.reason)), true));

async function init() {
  $('app-version').textContent = `エディターの版：${APP_VERSION}`;
  updateFileMenu();
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
  autoBackup.onState(renderAutoBackupState);
  await autoBackup.init().catch((e) => console.warn('自動バックアップの準備に失敗', e));
  const restored = prefs.get('restoredMessage', null);
  if (restored) {
    prefs.set('restoredMessage', null);
    toast(restored);
  } else {
    setTimeout(() => remindBackup().catch(() => {}), 1500);
  }

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service Worker 登録失敗', e));
  }
}

init().catch(fail);
