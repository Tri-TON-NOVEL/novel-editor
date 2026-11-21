// 作品（プロジェクト）のデータ形式とファイル形式
//
// ファイル: { format: 'novel-editor', version: 4, schemaVersion: 4, project }
//
// project = {
//   id（端末ローカル）, workId（作品の識別子。端末をまたいでも同じ）,
//   title, site: 'narou' | 'kakuyomu' | 'alpha'（メイン投稿サイト。sites の中の1つ）,
//   sites: ['narou', …]（v4。この作品で使う投稿サイト。外したサイトの原稿は消さずに残す）,
//   narouUrl, alphaUrl, kakuyomuUrl, synopsis（あらすじ）,
//   kakuyomu: { catchphrase, tags: [] }（v4。カクヨムのキャッチコピー・タグ）, shortStory（v4。短編）,
//   memos: [{ id, title, body }]（作品全体のメモ。タブで切り替える。1つ以上）,
//   projectMemo（1つ目のメモの本文の写し。前の版で読んでも1つ目のメモが残るように）,
//   outlineRest（全体プロットの「以降」。どの章にも結び付けない、これから先のプロット：0.97）,
//   chapters: [{ id, title, plot, order, level }],                章（全体プロットの章と同じもの）。
//               level（v4）：1＝大見出し、2＝小見出し（カクヨムだけの作品で使う。ほかの作品ではどちらも「章」として扱う）。並びは1列のまま
//   episodes: [{
//     id, chapterId（null＝未分類。部の id も可）, order,
//     drafts: { narou: { title, foreword, body, afterword }, kakuyomu: { ... }, alpha: { ... } },  サイト別原稿（エディション）
//     plot, freeMemo,                                              サイト共通
//     createdAt, updatedAt,
//   }],
//   narouNcode, alphaWorkId, kakuyomuWorkId（投稿サイトの作品との対応。任意）,
//   world:      { categories: [{ id, name }], items: [{ id, categoryId, ...列 }] },  設定
//   characters: { categories: [{ id, name }], items: [{ id, categoryId, ...列,
//                 orgs: [{ id: 設定の項目ID, note: 立場 }]（所属）, identityId（同じ値の行どうしが同一人物） }] },  登場人物
//   foreshadows: [...]（伏線の発生・回収。形は foreshadow.js の先頭）,
//   reports: { x, narouTitle, narouBody },
//   createdAt, updatedAt, links（端末ローカル）: { [クラウドID]: ファイルID }
// }
// 旧形式は、このファイル内の補完処理で現在の形式へ移行する。
import { normalizeForeshadows } from './foreshadow.js';
import { SITE_KEYS, SITES } from './sites/index.js';
export { SITE_KEYS };

export const FORMAT = 'novel-editor';
export const SCHEMA_VERSION = 4;
// v3 までの作品は、なろう・アルファの2サイトを使っていた
export const LEGACY_SITES = ['narou', 'alpha'];
export const DRAFT_FIELDS = ['title', 'foreword', 'body', 'afterword'];

export function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function emptyDraft() {
  return { title: '', foreword: '', body: '', afterword: '' };
}

export function emptyDrafts() {
  return Object.fromEntries(SITE_KEYS.map((s) => [s, emptyDraft()]));
}

export function newEpisode(content = {}) {
  const now = new Date().toISOString();
  return {
    id: makeId(),
    chapterId: null,
    drafts: emptyDrafts(),
    plot: '',
    freeMemo: '',
    createdAt: now,
    updatedAt: now,
    ...content,
  };
}

export function newChapter(content = {}) {
  return { id: makeId(), title: '', plot: '', level: 2, ...content };
}

function categories(...names) {
  return names.map((name) => ({ id: makeId(), name }));
}

export function newProject(content = {}) {
  const now = new Date().toISOString();
  const first = newChapter({ title: '第一章' });
  return {
    id: makeId(),
    workId: makeId(),
    title: '',
    site: 'narou',
    sites: [...SITE_KEYS],
    sitesV2: true, // 0.97：カクヨムを足す見直しが済んでいる印
    narouUrl: '',
    alphaUrl: '',
    kakuyomuUrl: '',
    narouNcode: '',   // なろうの Nコード（例 n1234ab）
    alphaWorkId: '',  // アルファポリスの作品ID
    kakuyomuWorkId: '', // カクヨムの作品ID
    kakuyomu: { catchphrase: '', tags: [] },
    shortStory: false,
    synopsis: '',
    outlineRest: '', // 0.97：全体プロットの「以降」
    projectMemo: '',
    episodes: [newEpisode({ chapterId: first.id })],
    chapters: [first],
    world: { categories: categories('世界観', '用語', '地名・組織'), items: [] },
    characters: { categories: categories('主要人物', 'サブキャラクター', 'その他'), items: [] },
    reports: { x: '', narouTitle: '', narouBody: '' },
    createdAt: now,
    updatedAt: now,
    links: {},
    ...content,
  };
}

// サイト別原稿を取り出す（なければ空）
export function draftOf(ep, site) {
  return ep.drafts?.[site] || emptyDraft();
}

// 一覧などに出すエピソード名：メインのタイトル、なければほかのサイトのタイトル
export function episodeName(ep, mainSite = 'narou') {
  for (const s of [mainSite, ...SITE_KEYS.filter((k) => k !== mainSite)]) {
    const t = draftOf(ep, s).title;
    if (t) return t;
  }
  return '（無題）';
}

// 作品で使う投稿サイト（重なり・知らないサイトを除く。記録がなければ3サイトすべて：0.97）。メインは必ず入れる
export function normalizeSites(sites, main) {
  const list = Array.isArray(sites) ? SITE_KEYS.filter((s) => sites.includes(s)) : [...SITE_KEYS];
  if (!list.length) list.push(...(SITES[main] ? [main] : SITE_KEYS));
  if (SITES[main] && !list.includes(main)) list.push(main);
  return SITE_KEYS.filter((s) => list.includes(s));
}

// 作品資料（バックアップの「作品資料」）に入れる、作品全体の情報の項目
export const PROJECT_INFO_KEYS = ['title', 'site', 'sites', 'sitesV2', 'narouUrl', 'alphaUrl', 'kakuyomuUrl', 'narouNcode', 'alphaWorkId', 'kakuyomuWorkId', 'kakuyomu', 'shortStory', 'synopsis'];

// ---------- 以前の版（v3）のバックアップを読み込むとき（0.97） ----------
// v3 のバックアップには、カクヨムの原稿・作品情報、部（章の level）がない。
// そのまま入れ替えると、この端末で書いたカクヨムの原稿などが消えるので、バックアップにないものは この端末のものを残す。
export const V4_PROJECT_KEYS = ['sites', 'sitesV2', 'kakuyomuUrl', 'kakuyomuWorkId', 'kakuyomu', 'shortStory'];

// 以前の版の作品 raw を、この端末の同じ作品 local に入れるときの中身（カクヨムの原稿・作品情報・部は local のまま）
export function mergeLegacyProject(raw, local) {
  const fixed = keepLocalProjectInfo(structuredClone(raw), local);
  fixed.episodes = (raw.episodes || []).map((e) => keepLocalDrafts(structuredClone(e), (local.episodes || []).find((x) => x.id === e.id), missingSites(e)));
  return stripLocal(normalize(fixed));
}

// バックアップのエピソードにないサイト（drafts にそのサイトの欄がない＝以前の版のバックアップ）
export function missingSites(ep) {
  return ep?.drafts && typeof ep.drafts === 'object' ? SITE_KEYS.filter((s) => !(s in ep.drafts)) : [];
}

// バックアップのエピソード src に、この端末のエピソード local の、そのサイトの原稿と稿の番号を入れる（src を変える）
export function keepLocalDrafts(src, local, sites) {
  if (!local || !sites.length) return src;
  src.drafts = { ...src.drafts };
  for (const s of sites) {
    if (local.drafts?.[s]) src.drafts[s] = structuredClone(local.drafts[s]);
    if (local.editionIds?.[s]) src.editionIds = { ...(src.editionIds || {}), [s]: local.editionIds[s] };
  }
  return src;
}

// バックアップの作品 raw（normalize の前）にない v4 の項目は、この端末の作品 local から入れる
export function keepLocalProjectInfo(raw, local) {
  if (!local) return raw;
  const out = { ...raw };
  for (const k of V4_PROJECT_KEYS) if (!(k in raw) && k in local) out[k] = structuredClone(local[k]);
  if (Array.isArray(out.chapters)) out.chapters = keepChapterLevels(out.chapters, local.chapters);
  return out;
}

// level のない章（v3）は、この端末の同じ章の level（大見出し・章）にする
export function keepChapterLevels(chapters, localChapters) {
  const levels = new Map((localChapters || []).map((c) => [c.id, c.level]));
  return chapters.map((c) => (c && !('level' in c) && levels.has(c.id) ? { ...c, level: levels.get(c.id) } : c));
}

// カクヨムの作品情報（キャッチコピー・タグ）
export function normalizeKakuyomuInfo(k) {
  const o = k && typeof k === 'object' ? k : {};
  return { ...o, catchphrase: String(o.catchphrase ?? ''), tags: Array.isArray(o.tags) ? o.tags.map((t) => String(t)).filter(Boolean) : [] };
}

function normalizeTable(t, fallback) {
  if (!t || !Array.isArray(t.categories) || !t.categories.length) return fallback;
  const cats = t.categories.map((c) => ({ ...c, id: c.id || makeId(), name: c.name ?? '' }));
  const ids = new Set(cats.map((c) => c.id));
  const items = (t.items || []).map((i) => {
    const item = { ...i, id: i.id || makeId(), categoryId: ids.has(i.categoryId) ? i.categoryId : cats[0].id };
    // 登場人物の所属・同一人物（ないときは項目を作らない。古い版で読んでも、そのまま残る）
    if ('orgs' in i) item.orgs = Array.isArray(i.orgs) ? i.orgs.filter((r) => r?.id).map((r) => ({ id: String(r.id), note: String(r.note ?? '') })) : [];
    if ('identityId' in i) item.identityId = typeof i.identityId === 'string' ? i.identityId : '';
    return item;
  });
  return { categories: cats, items };
}

// エピソード1件を現行形式にする（旧形式の title/foreword/body/afterword は site 側の原稿へ移す）
function migrateEpisode(e, site, project, chapterIds) {
  const { title, foreword, body, afterword, order, ...rest } = e;
  let drafts;
  if (e.drafts && typeof e.drafts === 'object') {
    drafts = Object.fromEntries(SITE_KEYS.map((s) => [s, { ...emptyDraft(), ...(e.drafts[s] || {}) }]));
    // 未知のサイトの原稿も捨てずに残す
    for (const [k, v] of Object.entries(e.drafts)) if (!(k in drafts)) drafts[k] = v;
  } else {
    drafts = emptyDrafts();
    drafts[site] = {
      title: String(title ?? ''),
      foreword: String(foreword ?? ''),
      body: String(body ?? ''),
      afterword: String(afterword ?? ''),
    };
  }
  return newEpisode({
    ...rest,
    id: e.id || makeId(),
    chapterId: chapterIds.has(e.chapterId) ? e.chapterId : null,
    drafts,
    plot: String(e.plot ?? ''),
    freeMemo: String(e.freeMemo ?? ''),
    createdAt: e.createdAt || project.createdAt,
    updatedAt: e.updatedAt || project.updatedAt,
  });
}

export const DEFAULT_MEMO_TITLE = 'メモ';
export function newMemo(content = {}) {
  return { id: makeId(), title: DEFAULT_MEMO_TITLE, body: '', ...content };
}
// メモの並びを整える（1つもなければ、前の版の projectMemo を1つ目にする）
// id がないときは決まった id にする（読むたびに変わると、変わっていないのに自動バックアップの印が変わるため）
export function normalizeMemos(memos, legacyBody = '') {
  const list = Array.isArray(memos)
    ? memos.filter((m) => m && typeof m === 'object').map((m, i) => ({ ...m, id: String(m.id || 'memo-' + (i + 1)), title: String(m.title ?? ''), body: String(m.body ?? '') }))
    : [];
  return list.length ? list : [newMemo({ id: 'memo-1', body: String(legacyBody ?? '') })];
}

// 足りない項目を補い、旧形式を現行形式へ移す（元のオブジェクトは変更しない）
export function normalize(p) {
  const base = newProject();
  const project = { ...base, ...p, reports: { ...base.reports, ...(p.reports || {}) }, links: { ...(p.links || {}) } };
  if (!SITE_KEYS.includes(project.site)) project.site = 'narou';
  // v4：使う投稿サイト。v3 までのデータ（記録なし）は3サイトすべて（0.97）
  project.sites = normalizeSites(p.sites, project.site);
  // 0.96 で なろう・アルファの2サイトにしたデータは、一度だけカクヨムを足す（0.97）
  if (!p.sitesV2 && project.sites.length === 2 && LEGACY_SITES.every((s) => project.sites.includes(s))) project.sites = [...SITE_KEYS];
  project.sitesV2 = true;
  project.kakuyomu = normalizeKakuyomuInfo(p.kakuyomu);
  project.shortStory = !!p.shortStory;
  project.outlineRest = String(p.outlineRest ?? ''); // 0.97：全体プロットの「以降」（前の版のデータにはない）
  for (const k of ['kakuyomuUrl', 'kakuyomuWorkId']) project[k] = String(p[k] ?? '');
  if (!project.workId) project.workId = makeId();
  // 作品のメモ（複数）。前の版のデータ（projectMemo だけ）は、1つ目のメモにする
  project.memos = normalizeMemos(p.memos, p.projectMemo);
  project.projectMemo = project.memos[0].body;

  // 章（並びは配列の順。order は保存時に振り直す）
  const chapterSrc = Array.isArray(p.chapters) && p.chapters.length
    ? [...p.chapters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : base.chapters;
  // level（v4）：1＝大見出し、2＝小見出し（ふつうの章）。記録のない章（v3 まで）は2
  project.chapters = chapterSrc.map(({ order, ...c }) => newChapter({ ...c, id: c.id || makeId(), level: c.level === 1 ? 1 : 2 }));
  // 旧「作品メモ」は章として引き継ぐ
  if (p.memo) project.chapters.push(newChapter({ title: '作品メモ', plot: p.memo }));
  delete project.memo;

  const chapterIds = new Set(project.chapters.map((c) => c.id));
  const episodeSrc = Array.isArray(p.episodes) && p.episodes.length
    ? [...p.episodes].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [{}];
  project.episodes = episodeSrc.map((e) => migrateEpisode(e, project.site, project, chapterIds));

  project.world = normalizeTable(p.world, base.world);
  project.characters = normalizeTable(p.characters, base.characters);
  project.foreshadows = normalizeForeshadows(p.foreshadows);
  return project;
}

// 旧形式（タイトル・本文・プロットだけ）から変換
export function fromSingle({ title = '', body = '', plot = '', updatedAt, createdAt }) {
  const now = new Date().toISOString();
  const drafts = emptyDrafts();
  drafts.narou.body = body;
  return newProject({
    title,
    episodes: [newEpisode({ drafts, plot })],
    createdAt: createdAt || updatedAt || now,
    updatedAt: updatedAt || now,
  });
}

function stripLocal(p) {
  const { id, links, ...rest } = p;
  return rest;
}

export function serialize(project) {
  const p = stripLocal(project);
  // 並び順は配列の順。読む側のために order も書いておく
  p.chapters = project.chapters.map((c, i) => ({ ...c, order: i }));
  p.episodes = project.episodes.map((e, i) => ({ ...e, order: i }));
  return JSON.stringify({ format: FORMAT, version: SCHEMA_VERSION, schemaVersion: SCHEMA_VERSION, project: p }, null, 2);
}

export class FileFormatError extends Error {}

// 戻り値: プロジェクトの中身（id・links なし）
// .json なのに読めない・別形式のときはエラーにする（壊れた内容で上書きしないため）
export function parse(text, fileName = '') {
  const isJsonName = /\.json$/i.test(fileName);
  let o = null;
  try {
    o = JSON.parse(text);
  } catch (e) {
    if (isJsonName) throw new FileFormatError(`「${fileName}」を JSON として読めませんでした（${e.message}）。ファイルが壊れていないか確認してください`);
  }
  if (o && o.format === FORMAT) {
    const v = o.schemaVersion ?? o.version ?? 1;
    if (v > SCHEMA_VERSION) {
      throw new FileFormatError(`「${fileName}」は新しい版のエディター（データ形式 v${v}）で作られています。エディターを更新してから開いてください`);
    }
    if (v >= 2 && o.project) {
      const content = stripLocal(normalize(o.project));
      // 以前の版（v3 まで）のファイル：同じ作品に入れるとき、この端末のカクヨムの原稿などを残すため、元の中身も持たせる（0.97）
      if (v < 4) Object.defineProperty(content, 'legacyRaw', { value: o.project, enumerable: false });
      return content;
    }
    return stripLocal(fromSingle(o));
  }
  if (o !== null && isJsonName) throw new FileFormatError(`「${fileName}」はこのエディターの作品ファイルではありません`);
  return stripLocal(fromSingle({ title: fileName.replace(/\.[^.]+$/, ''), body: text }));
}

export function fileName(title, ext) {
  const base = (title || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80);
  return (base || '無題') + ext;
}

export function countChars(text) {
  const t = text || '';
  return {
    all: [...t].length,
    noSpace: [...t.replace(/\s/g, '')].length,
  };
}

// 取り込んだファイルの順（fileIds：話の ID）に目次順を並べ替えたもの（0.97。目次順は3サイト共通）。
// 並べ替えるのは章の中だけ。ファイルにない話は今の位置のまま、ファイルにある話が占めている場所を、章ごとにファイルの順で埋め直す。
// { ids, changed（位置が変わる話の数） }
export function episodeOrderFromFile(p, fileIds) {
  const before = p.episodes.map((e) => e.id);
  const chapters = new Set((p.chapters || []).map((c) => c.id));
  const chapterOf = new Map(p.episodes.map((e) => [e.id, chapters.has(e.chapterId) ? e.chapterId : null]));
  const inFile = new Set();
  const queues = new Map();
  for (const id of fileIds) {
    if (!chapterOf.has(id) || inFile.has(id)) continue;
    inFile.add(id);
    const c = chapterOf.get(id);
    if (!queues.has(c)) queues.set(c, []);
    queues.get(c).push(id);
  }
  const ids = before.map((id) => (inFile.has(id) ? queues.get(chapterOf.get(id)).shift() : id));
  return { ids, changed: ids.filter((id, i) => id !== before[i]).length };
}
