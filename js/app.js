import { db, prefs, versions } from './db.js';
import {
  newProject, newEpisode, normalize, fromSingle, serialize, parse, fileName, countChars, episodeName,
} from './format.js';
import { categorizedTable, chapterList, CHARACTER_COLUMNS, WORLD_COLUMNS } from './tables.js';
import { makeBackup, isBackup, parseBackup, restoreBackup, backupFileName, requestPersistence } from './backup.js';
import * as autoBackup from './autobackup.js';
import {
  SITES, RUBY_LIMIT, SYMBOLS, ruby, dots, autoIndent, rubyCaretOffset, convert, convertRuby, countImages,
  miteminToTag, hasMiteminUrl, xLength, fillTemplate, TEMPLATE_VARS, DEFAULT_TEMPLATES,
} from './notation.js';
import { localFile, WORK_TYPES, TEXT_TYPES } from './localfile.js';
import { providers } from './providers/index.js';

const $ = (id) => document.getElementById(id);
const AUTOSAVE_MS = 600;

const el = {
  novelTitle: $('novel-title'),
  site: $('site'),
  synopsis: $('synopsis'),
  epTitle: $('ep-title'),
  foreword: $('foreword'),
  body: $('body'),
  afterword: $('afterword'),
  plot: $('plot'),
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

const episode = () => project.episodes[epIndex];

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
  b.addEventListener('click', () => Promise.resolve().then(onClick).catch(fail));
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
  return !p.title && !p.synopsis && !r.x && !r.narouTitle && !r.narouBody
    && !p.chapters.some((c) => c.plot) && !p.world.items.length && !p.characters.items.length
    && p.episodes.length === 1 && !p.episodes[0].title && !p.episodes[0].body && !p.episodes[0].plot;
}

function totalChars(p) {
  return p.episodes.reduce((n, e) => n + countChars(e.body).all, 0);
}

function updateStatus() {
  const parts = [];
  if (!db.persistent) parts.push('⚠ この環境では端末に保存できません');
  else if (dirty) parts.push('編集中…');
  else if (lastSavedAt) parts.push('端末に自動保存 ' + fmtTime(lastSavedAt));
  parts.push('投稿先: ' + SITES[project.site].short);
  if (autoBackup.getState() === 'on') {
    const last = autoBackup.lastWrittenAt();
    parts.push('自動バックアップ' + (last ? ' ' + fmtTime(last) : ' 有効'));
  }
  if (fileHandle) parts.push('ファイル: ' + fileHandle.name);
  for (const p of providers) if (project.links?.[p.id]) parts.push(p.label + ' 連携');
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
  setCount('afterword', el.afterword.value);
  setCount('plot', el.plot.value);
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
  } catch (e) {
    dirty = true;
    fail(e);
  }
  updateStatus();
}

function changed() {
  project.updatedAt = new Date().toISOString();
  dirty = true;
  autoDirty = true;
  autoBackup.schedule();
  updateStatus();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, AUTOSAVE_MS);
}

// 入力欄 → 作品データ
const bindings = [
  [el.novelTitle, (v) => { project.title = v; }],
  [el.synopsis, (v) => { project.synopsis = v; }],
  [el.epTitle, (v) => { episode().title = v; renderEpisodeList(); }],
  [el.foreword, (v) => { episode().foreword = v; }],
  [el.body, (v) => { episode().body = v; }],
  [el.afterword, (v) => { episode().afterword = v; }],
  [el.plot, (v) => { episode().plot = v; }],
  [el.narouUrl, (v) => { project.narouUrl = v.trim(); }],
  [el.alphaUrl, (v) => { project.alphaUrl = v.trim(); }],
  [el.xText, (v) => { project.reports.x = v; }],
  [el.nrTitle, (v) => { project.reports.narouTitle = v; }],
  [el.nrBody, (v) => { project.reports.narouBody = v; }],
];

// ---------- 画面表示 ----------

function renderEpisodeList() {
  const list = $('episode-list');
  list.replaceChildren();
  project.episodes.forEach((ep, i) => {
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: episodeName(ep) });
    b.dataset.ep = i;
    if (view === 'episode' && i === epIndex) b.classList.add('active');
    const del = Object.assign(document.createElement('button'), {
      type: 'button', className: 'ep-delete', textContent: '削除', title: `「${episodeName(ep)}」を削除`,
    });
    del.dataset.epDelete = i;
    const item = document.createElement('li');
    item.append(b, del);
    list.append(item);
  });
}

function showEpisode() {
  const ep = episode();
  el.epTitle.value = ep.title;
  el.foreword.value = ep.foreword;
  el.body.value = ep.body;
  el.afterword.value = ep.afterword;
  el.plot.value = ep.plot;
  // 前書き・後書きは中身があるときだけ開いておく
  $('foreword-box').open = !!ep.foreword;
  $('afterword-box').open = !!ep.afterword;
  updateCounts();
  renderEpisodeVersions().catch(() => {});
}

// 投稿先に合わせて、使える機能（ボタン・前書き・後書き）を切り替える
function applySite() {
  document.body.dataset.site = project.site;
  $('site-badge').textContent = SITES[project.site].label + 'モード';
  el.body.placeholder = project.site === 'narou'
    ? '本文\n\nみてみんの画像URL（https://〜.mitemin.net/i〜/）を貼り付けると、挿絵タグに自動で変わります'
    : '本文';
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
  prefs.set('ep:' + project.id, epIndex);
  showEpisode();
  setView('episode');
}

function showProject(p, handle = null) {
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
  epIndex = Math.min(prefs.get('ep:' + project.id, 0), project.episodes.length - 1);
  lastSavedAt = project.updatedAt;
  dirty = false;
  autoDirty = false;
  lastAutoVersionAt = Date.now();
  prefs.set('currentId', project.id);
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

function addEpisode() {
  project.episodes.push(newEpisode());
  changed();
  selectEpisode(project.episodes.length - 1);
  el.epTitle.focus();
}

function moveEpisode(delta) {
  const to = epIndex + delta;
  if (to < 0 || to >= project.episodes.length) return;
  const eps = project.episodes;
  [eps[epIndex], eps[to]] = [eps[to], eps[epIndex]];
  changed();
  selectEpisode(to);
}

// 間違って消さないよう、2回確認する
function deleteEpisode(index = epIndex) {
  const ep = project.episodes[index];
  const name = `「${episodeName(ep)}」`;
  const size = countChars(ep.body).all;
  const last = project.episodes.length === 1;
  if (!confirm(last ? `${name}の内容を消しますか？` : `${name}を削除しますか？`)) return;
  if (!confirm(`【最終確認】本当に${name}を削除しますか？\n本文 ${size.toLocaleString()}字が消え、元に戻せません。`)) return;
  if (last) project.episodes[0] = newEpisode();
  else project.episodes.splice(index, 1);
  removeEpisodeVersions(ep.id).catch(() => {});
  changed();
  const next = index < epIndex ? epIndex - 1 : Math.min(epIndex, project.episodes.length - 1);
  if (view === 'episode') selectEpisode(next);
  else { epIndex = next; renderEpisodeList(); }
  toast(`${name}を削除しました`);
}

function changeSite(site) {
  const prev = project.site;
  project.site = site;
  changed();
  applySite();
  const target = SITES[site].label;
  const fields = ['foreword', 'body', 'afterword'];
  const needs = project.episodes.some((e) => fields.some((f) => convertRuby(site, e[f]) !== e[f]));
  if (needs && confirm(`ルビ・傍点を${target}の書き方に変換しますか？\n（「キャンセル」なら原稿はそのままで、コピー時だけ変換されます）`)) {
    for (const e of project.episodes) for (const f of fields) e[f] = convertRuby(site, e[f]);
    showEpisode();
    toast(`${target}モードにして、ルビ・傍点を変換しました`);
  } else if (prev !== site) {
    const hidden = site === 'alpha' && project.episodes.some((e) => e.foreword || e.afterword);
    toast(`${target}モードにしました` + (hidden ? '（前書き・後書きは非表示。内容は残っています）' : ''));
  }
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
  if (!confirm(`作品「${name}」をこの端末から削除しますか？`)) return false;
  if (!confirm(`【2回目の確認】\n「${name}」の ${n.episodes.length}話・本文 ${totalChars(n).toLocaleString()}字、`
    + `プロット・設定・登場人物、バージョン${vcount}件がすべて消えます。\n`
    + '（「ファイルに保存」やバックアップ、クラウドに保存したものは残ります）\n本当に削除しますか？')) return false;
  const word = n.title || '削除';
  const typed = prompt(`【最終確認】削除するには、${n.title ? '作品名' : '「削除」'}を正確に入力してください。\n${word}`);
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
  const same = projects.find((p) => p.createdAt === content.createdAt && p.title === content.title)
    || projects.find((p) => Object.entries(links).some(([k, v]) => p.links?.[k] === v));
  if (same) {
    const localNewer = content.updatedAt && same.updatedAt > content.updatedAt;
    if (localNewer && serialize(same) !== serialize({ ...same, ...content })
      && !confirm('この端末の内容の方が新しいようです。\n読み込んだ内容で上書きしますか？\n（「キャンセル」で端末の内容を開きます）')) {
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

async function fileOpen() {
  const r = await localFile.open();
  if (!r) return;
  if (isBackup(r.text)) { openRestoreDialog(r.text, r.name); return; }
  await switchTo(await importContent(parse(r.text, r.name)), r.handle);
  toast(`「${r.name}」を開きました`);
}

async function fileSave() {
  if (!fileHandle) return fileSaveAs();
  await flush();
  await localFile.write(fileHandle, serialize(project));
  toast(`「${fileHandle.name}」に保存しました`);
  updateStatus();
}

async function fileSaveAs() {
  await flush();
  const r = await localFile.saveAs(serialize(project), fileName(project.title, '.json'), WORK_TYPES, 'application/json');
  if (!r) return;
  if (r === 'downloaded') {
    toast('ファイルを書き出しました（ダウンロード／「ファイル」アプリ）');
  } else {
    fileHandle = r;
    toast(`「${r.name}」に保存しました`);
  }
  updateStatus();
}

// ---------- 版 ----------
// 版は2種類。どちらも versions ストアに入れ、kind で分ける。
//   エピソードの版（kind: 'episode'）… エピソードごとの編集の版。エピソード欄の「版」から上げる・戻す
//   作品全体のバックアップ版（kind なし／'project'）… 設定の「バックアップ」タブ。自動でも残る

const newVersionId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
const isEpisodeVersion = (v) => v.kind === 'episode';

// --- エピソードの版 ---

const EP_FIELDS = ['title', 'foreword', 'body', 'afterword', 'plot'];

async function episodeVersions(episodeId = episode().id) {
  return (await versions.list(project.id)).filter((v) => isEpisodeVersion(v) && v.episodeId === episodeId);
}

async function saveEpisodeVersion(name, ep = episode()) {
  await flush();
  const data = Object.fromEntries(EP_FIELDS.map((f) => [f, ep[f]]));
  const v = {
    id: newVersionId(),
    kind: 'episode',
    projectId: project.id,
    episodeId: ep.id,
    name,
    memo: '',
    createdAt: new Date().toISOString(),
    chars: countChars(ep.body).all,
    data,
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
  const now = isEpisodeVersion(v) ? countChars(ep?.body || '').all : totalChars(project);
  const diff = v.chars - now;
  row('保存日時', new Date(v.createdAt).toLocaleString('ja-JP'));
  if (isEpisodeVersion(v)) {
    row('エピソード', v.data.title || '（無題）');
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
  if (!confirm(`「${v.name}」の内容に戻しますか？\n今の内容は「${v.name}に戻す前」として自動で残ります。`)) return;
  if (isEpisodeVersion(v)) {
    const index = project.episodes.findIndex((e) => e.id === v.episodeId);
    if (index < 0) { toast('このエピソードは削除されています', true); return; }
    const ep = project.episodes[index];
    await saveEpisodeVersion(`${v.name}に戻す前`, ep);
    Object.assign(ep, v.data);
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
  if (!confirm(`版「${v.name}」を削除しますか？`)) return;
  if (!confirm(`【最終確認】「${v.name}」は元に戻せません。削除しますか？`)) return;
  await versions.remove(v.id);
  toast(`版「${v.name}」を削除しました`);
  if (isEpisodeVersion(v)) renderEpisodeVersions();
  else renderProjectVersions();
}

// ---------- 全体バックアップ・復元 ----------

const BACKUP_REMIND_DAYS = 7;

async function backupAll() {
  await flush();
  const { text, count, versionCount } = await makeBackup();
  const r = await localFile.saveAs(text, backupFileName(), WORK_TYPES, 'application/json');
  if (!r) return;
  prefs.set('lastBackupAt', new Date().toISOString());
  toast(`${count}作品（バージョン${versionCount}件）と、ひな型・設定をバックアップしました`);
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
  const r = await localFile.open();
  if (!r) return;
  openRestoreDialog(r.text, r.name);
}

async function runRestore(mode) {
  if (!pendingBackup) return;
  if (mode === 'replace' && !confirm('【最終確認】この端末の作品をすべて消して、バックアップの内容に入れ替えます。よろしいですか？')) return;
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

async function exportEpisode() {
  const ep = episode();
  if (!ep.body) { toast('本文は空です'); return; }
  const name = fileName(`${project.title || '無題'}_${ep.title || epIndex + 1}`, '.txt');
  const r = await localFile.saveAs(convert(project.site, ep.body), name, TEXT_TYPES, 'text/plain');
  if (r) toast(`「${episodeName(ep)}」を書き出しました（${SITES[project.site].short}用）`);
}

async function exportAll() {
  const text = project.episodes
    .map((e) => `${e.title}\n\n${convert(project.site, e.body)}`)
    .join('\n\n――――――――――\n\n');
  const head = project.title ? project.title + '\n\n' : '';
  const r = await localFile.saveAs(head + text, fileName(project.title, '.txt'), TEXT_TYPES, 'text/plain');
  if (r) toast(`全${project.episodes.length}話を書き出しました（${SITES[project.site].short}用）`);
}

// ---------- クラウド ----------

async function cloudSave(p) {
  await flush();
  const id = await p.save(serialize(project), fileName(project.title, '.json'), project.links?.[p.id]);
  project.links = { ...project.links, [p.id]: id };
  await db.put(project);
  toast(`${p.label}に保存しました`);
  updateStatus();
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
      const content = parse(await p.load(f.id), f.name);
      await switchTo(await importContent(content, { [p.id]: f.id }));
      toast(`${p.label}から「${content.title || '無題'}」を開きました`);
    });
    list.append(listItem(f.name.replace(/\.json$/i, ''), '更新 ' + fmtTime(f.modifiedTime), [open]));
  }
}

// 設定の「クラウド」タブ：保存・開く・ログインのボタン
function renderCloudActions() {
  const box = $('cloud-action-list');
  box.replaceChildren();
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
    }
    box.append(section);
  }
}

// ---------- コピー・編集補助 ----------

const copySources = {
  'novel-title': () => ['小説タイトル', project.title],
  synopsis: () => ['あらすじ', project.synopsis],
  'ep-title': () => ['エピソードタイトル', episode().title],
  foreword: () => ['前書き', convert(project.site, episode().foreword)],
  body: () => ['本文', convert(project.site, episode().body)],
  afterword: () => ['後書き', convert(project.site, episode().afterword)],
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
const outline = chapterList($('chapters'), () => project.chapters, sectionOpts);
const worldTable = categorizedTable($('world-tables'), () => project.world, { ...sectionOpts, columns: WORLD_COLUMNS, itemLabel: '項目' });
const characterTable = categorizedTable($('character-tables'), () => project.characters, { ...sectionOpts, columns: CHARACTER_COLUMNS, itemLabel: '人物' });

async function copyField(key) {
  const [label, text] = copySources[key]();
  if (!text) { toast(label + 'は空です'); return; }
  const ok = await writeClipboard(text);
  if (!ok) { toast('コピーできませんでした', true); return; }
  let msg = `${label}をコピーしました（${countChars(text).all.toLocaleString()}字）`;
  if (key === 'body') {
    msg = `${label}を${SITES[project.site].short}用にコピーしました（${countChars(text).all.toLocaleString()}字）`;
    const images = countImages(episode().body);
    if (project.site === 'alpha' && images) msg += `　※挿絵${images}か所は【挿絵】の位置に手で入れてください`;
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
  if (project.site === 'narou' && [...sel].length > RUBY_LIMIT) {
    toast(`なろうのルビは${RUBY_LIMIT}文字までです（選択 ${[...sel].length}文字）`, true);
    return;
  }
  replaceSelection(t, ruby(project.site, sel, ''), s, e);
  const caret = s + (sel ? rubyCaretOffset(project.site, sel) : 1);
  t.setSelectionRange(caret, caret);
}

function insertDots() {
  const t = target();
  const { selectionStart: s, selectionEnd: e } = t;
  if (s === e) { toast('傍点を付ける文字を選択してから押してください'); return; }
  replaceSelection(t, dots(project.site, t.value.slice(s, e)), s, e);
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

function runAutoIndent() {
  const t = el.body;
  const next = autoIndent(t.value);
  if (next === t.value) { toast('字下げが必要な段落はありません'); return; }
  if (!confirm('段落の先頭を一字下げますか？\n（「 などで始まる行、すでに字下げしてある行は除きます）')) return;
  const lines = next.split('\n').filter((l, i) => l !== t.value.split('\n')[i]).length;
  replaceSelection(t, next, 0, t.value.length);
  t.setSelectionRange(0, 0);
  t.scrollTop = 0;
  toast(`${lines}か所を字下げしました（元に戻す：Ctrl+Z）`);
}

// ---------- 一括置換 ----------

function replaceFields() {
  return project.site === 'narou' ? ['foreword', 'body', 'afterword'] : ['body'];
}

function countMatches(from, scope) {
  if (!from) return 0;
  const eps = scope === 'all' ? project.episodes : [episode()];
  return eps.reduce((n, e) => n + replaceFields().reduce((m, f) => m + e[f].split(from).length - 1, 0), 0);
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
  for (const e of eps) for (const f of replaceFields()) e[f] = e[f].split(from).join(to);
  changed();
  showEpisode();
  toast(`「${from}」を「${to}」に${n}か所置換しました`);
}

let imageCaret = [0, 0];
function openImageDialog() {
  if (project.site !== 'narou') return;
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
function onBodyPaste(e) {
  if (project.site !== 'narou') return;
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

function applyTemplate(kind) {
  const t = templates().find((x) => x.id === $('tpl-' + kind).value);
  if (!t) { toast('ひな型を選んでください'); return; }
  if (kind === 'afterword') {
    if (el.afterword.value && !confirm('今の後書きをひな型で置き換えますか？')) return;
    $('afterword-box').open = true;
    replaceSelection(el.afterword, fillTemplate(t.body, project, epIndex), 0, el.afterword.value.length);
    toast(`ひな型「${t.name}」を差し込みました`);
    return;
  }
  const index = Number(el.reportEpisode.value) || 0;
  if (kind === 'x') {
    if (el.xText.value && !confirm('今の投稿文をひな型で置き換えますか？')) return;
    el.xText.value = fillTemplate(t.body, project, index);
    el.xText.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    if ((el.nrTitle.value || el.nrBody.value) && !confirm('今の活動報告をひな型で置き換えますか？')) return;
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
      const del = button('削除', () => {
        if (!confirm(`ひな型「${t.name}」を削除しますか？`)) return;
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
      button('削除', () => {
        if (!confirm(`「${l.name || l.url || '（名前なし）'}」をリンクから外しますか？`)) return;
        editingLinks.splice(i, 1);
        renderLinkEditor();
      }, 'tool danger'));
    list.append(item);
  });
}

// ---------- 設定 ----------

function applyPrefs() {
  document.documentElement.dataset.font = prefs.get('font', 'serif');
  document.documentElement.style.setProperty('--body-size', prefs.get('fontSize', '18') + 'px');
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
  selectSettingsTab(tab);
  $('settings-dialog').showModal();
}

function saveSettings() {
  const form = $('settings-form');
  prefs.set('font', form.font.value);
  prefs.set('fontSize', form.fontSize.value);
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
  const p = providers.find((x) => project.links?.[x.id] && x.isConfigured());
  if (p) return cloudSave(p);
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
  'add-episode': addEpisode,
  'move-up': () => moveEpisode(-1),
  'move-down': () => moveEpisode(1),
  'ep-version-up': episodeVersionUp,
  'project-version-save': openVersionSave,
  'manage-templates': () => { renderTemplateList(); $('templates-dialog').showModal(); },
  'open-x': openX,
  'auto-indent': runAutoIndent,
  replace: openReplace,
  backup: backupAll,
  restore: restoreFromFile,
  undo: () => undoRedo('undo'),
  redo: () => undoRedo('redo'),
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
    : state === 'on' ? `✅ 「${autoBackup.folderName()}」に自動で保存しています${lastText}`
      : state === 'need-permission' ? `⚠ 「${autoBackup.folderName()}」への書き込みの許可が切れています。上の「自動バックアップを再開」を押してください${lastText}`
        : '止まっています。フォルダを選ぶと始まります。';
  $('autobackup-status').textContent = text;
  $('autobackup-buttons').hidden = !autoBackup.supported;
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
      Promise.resolve().then(actions[d.action]).catch(fail);
    } else if (d.copy) {
      copyField(d.copy).catch(fail);
    } else if (d.insert) {
      inserts[d.insert]();
    } else if (d.tab) {
      selectTab(d.tab);
    } else if (d.view) {
      setView(d.view);
    } else if (d.ep !== undefined) {
      selectEpisode(Number(d.ep));
    } else if (d.epDelete !== undefined) {
      deleteEpisode(Number(d.epDelete));
    } else if (d.symbol) {
      insertSymbol(d.symbol);
      closeMenus();
    } else if (d.tplApply) {
      applyTemplate(d.tplApply);
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
  }));

  bindDialog('settings-dialog', saveSettings);
  bindDialog('image-dialog', () => insertImage($('image-form').url.value));
  bindDialog('template-edit-dialog', saveEditedTemplate);
  bindDialog('replace-dialog', runReplace);
  bindDialog('restore-dialog');
  bindDialog('version-save-dialog', async () => {
    const form = $('version-save-form');
    const v = await saveVersion(form.name.value.trim() || '名前なし', form.memo.value.trim());
    toast(`作品全体を「${v.name}」として保存しました`);
    renderProjectVersions().catch(() => {});
  });
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
      closeMenus();
      document.body.classList.remove('drawer-open');
    }
  });

  // 画面を閉じる・別のアプリに切り替えるとき：端末に保存し、自動バージョンと自動バックアップも残す
  const onLeave = () => {
    flush().then(() => autoVersion(60_000)).catch(() => {});
    autoBackup.flushNow();
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') onLeave(); });
  window.addEventListener('pagehide', onLeave);
  setInterval(() => autoVersion().catch(() => {}), 60_000);

  $('autobackup-choose').addEventListener('click', () => autoBackup.chooseFolder()
    .then((ok) => { if (ok) toast(`「${autoBackup.folderName()}」への自動バックアップを始めました`); }).catch(fail));
  $('autobackup-now').addEventListener('click', () => autoBackup.runNow()
    .then((ok) => toast(ok ? '自動バックアップのフォルダに保存しました' : '先にフォルダを選んでください')).catch(fail));
  $('autobackup-stop').addEventListener('click', () => {
    if (!confirm('自動バックアップを止めますか？（これまでのバックアップファイルは消えません）')) return;
    autoBackup.stop().then(() => toast('自動バックアップを止めました')).catch(fail);
  });
}

// 旧形式（1作品＝1原稿）のデータを作品＋エピソード形式へ移す
async function migrate() {
  const old = await db.oldWorks();
  if (!old.length) return;
  for (const w of old) await db.put({ ...fromSingle(w), id: w.id, links: w.links || {} });
  await db.clearOldWorks();
}

async function init() {
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
