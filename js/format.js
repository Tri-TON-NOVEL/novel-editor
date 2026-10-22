// 作品（プロジェクト）のデータ形式とファイル形式
//
// ファイル: { format: 'novel-editor', version: 3, schemaVersion: 3, project }
//
// project = {
//   id（端末ローカル）, workId（作品の識別子。端末をまたいでも同じ）,
//   title, site: 'narou' | 'alpha'（メイン投稿サイト）, narouUrl, alphaUrl, synopsis（あらすじ）,
//   chapters: [{ id, title, plot, order }],                       章（全体プロットの章と同じもの）
//   episodes: [{
//     id, chapterId（null＝未分類）, order,
//     drafts: { narou: { title, foreword, body, afterword }, alpha: { ... } },  サイト別原稿
//     plot, freeMemo,                                              サイト共通
//     createdAt, updatedAt,
//   }],
//   narouNcode, alphaWorkId（投稿サイトの作品との対応。任意）,
//   world:      { categories: [{ id, name }], items: [{ id, categoryId, ...列 }] },  設定
//   characters: { categories: [{ id, name }], items: [{ id, categoryId, ...列,
//                 orgs: [{ id: 設定の項目ID, note: 立場 }]（所属）, identityId（同じ値の行どうしが同一人物） }] },  登場人物
//   reports: { x, narouTitle, narouBody },
//   createdAt, updatedAt, links（端末ローカル）: { [クラウドID]: ファイルID }
// }
// 移行の詳細は docs/01_データ形式v3.md を参照。
export const FORMAT = 'novel-editor';
export const SCHEMA_VERSION = 3;
export const SITE_KEYS = ['narou', 'alpha'];
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
  return { id: makeId(), title: '', plot: '', ...content };
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
    narouUrl: '',
    alphaUrl: '',
    narouNcode: '',   // なろうの Nコード（例 n1234ab）
    alphaWorkId: '',  // アルファポリスの作品ID
    synopsis: '',
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

// 一覧などに出すエピソード名：メインのタイトル、なければもう一方のタイトル
export function episodeName(ep, mainSite = 'narou') {
  const other = SITE_KEYS.find((s) => s !== mainSite);
  return draftOf(ep, mainSite).title || draftOf(ep, other).title || '（無題）';
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

// 足りない項目を補い、旧形式を現行形式へ移す（元のオブジェクトは変更しない）
export function normalize(p) {
  const base = newProject();
  const project = { ...base, ...p, reports: { ...base.reports, ...(p.reports || {}) }, links: { ...(p.links || {}) } };
  if (!SITE_KEYS.includes(project.site)) project.site = 'narou';
  if (!project.workId) project.workId = makeId();

  // 章（並びは配列の順。order は保存時に振り直す）
  const chapterSrc = Array.isArray(p.chapters) && p.chapters.length
    ? [...p.chapters].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : base.chapters;
  project.chapters = chapterSrc.map(({ order, ...c }) => newChapter({ ...c, id: c.id || makeId() }));
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
    if (v >= 2 && o.project) return stripLocal(normalize(o.project));
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
