// 作品（プロジェクト）のデータ形式とファイル形式
//
// project = {
//   id, title, site: 'narou' | 'alpha', narouUrl, alphaUrl, synopsis（あらすじ）,
//   episodes: [{ id, title, foreword, body, afterword, plot }],  ※前書き・後書きはなろうのみ
//   chapters: [{ id, title, plot }],                              全体プロット（章ごと）
//   world:      { categories: [{ id, name }], items: [{ id, categoryId, ...列 }] },  設定
//   characters: { categories: [{ id, name }], items: [{ id, categoryId, ...列 }] },  登場人物
//   reports: { x, narouTitle, narouBody },
//   createdAt, updatedAt, links: { [クラウドID]: ファイルID }
// }
export const FORMAT = 'novel-editor';

export function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function newEpisode(content = {}) {
  return { id: makeId(), title: '', foreword: '', body: '', afterword: '', plot: '', ...content };
}

export function newChapter(content = {}) {
  return { id: makeId(), title: '', plot: '', ...content };
}

function categories(...names) {
  return names.map((name) => ({ id: makeId(), name }));
}

export function newProject(content = {}) {
  const now = new Date().toISOString();
  return {
    id: makeId(),
    title: '',
    site: 'narou',
    narouUrl: '',
    alphaUrl: '',
    synopsis: '',
    episodes: [newEpisode()],
    chapters: [newChapter({ title: '第一章' })],
    world: { categories: categories('世界観', '用語', '地名・組織'), items: [] },
    characters: { categories: categories('主要人物', 'サブキャラクター', 'その他'), items: [] },
    reports: { x: '', narouTitle: '', narouBody: '' },
    createdAt: now,
    updatedAt: now,
    links: {},
    ...content,
  };
}

function normalizeTable(t, fallback) {
  if (!t || !Array.isArray(t.categories) || !t.categories.length) return fallback;
  const cats = t.categories.map((c) => ({ id: c.id || makeId(), name: c.name ?? '' }));
  const ids = new Set(cats.map((c) => c.id));
  const items = (t.items || []).map((i) => ({ ...i, id: i.id || makeId(), categoryId: ids.has(i.categoryId) ? i.categoryId : cats[0].id }));
  return { categories: cats, items };
}

// 足りない項目を補う（古いデータや他の端末のデータを読み込んだとき用）
export function normalize(p) {
  const base = newProject();
  const project = { ...base, ...p, reports: { ...base.reports, ...(p.reports || {}) }, links: { ...(p.links || {}) } };
  project.episodes = (p.episodes && p.episodes.length ? p.episodes : [{}]).map((e) => newEpisode({ ...e, id: e.id || makeId() }));
  project.chapters = (p.chapters && p.chapters.length ? p.chapters : base.chapters).map((c) => newChapter({ ...c, id: c.id || makeId() }));
  project.world = normalizeTable(p.world, base.world);
  project.characters = normalizeTable(p.characters, base.characters);
  // 旧「作品メモ」は全体プロットの章として引き継ぐ
  if (p.memo) {
    if (!p.chapters) project.chapters = [newChapter({ title: '作品メモ', plot: p.memo })];
    else project.chapters.push(newChapter({ title: '作品メモ', plot: p.memo }));
  }
  delete project.memo;
  if (!['narou', 'alpha'].includes(project.site)) project.site = 'narou';
  return project;
}

// 旧形式（タイトル・本文・プロットだけ）から変換
export function fromSingle({ title = '', body = '', plot = '', updatedAt, createdAt }) {
  const now = new Date().toISOString();
  return newProject({
    title,
    episodes: [newEpisode({ body, plot })],
    createdAt: createdAt || updatedAt || now,
    updatedAt: updatedAt || now,
  });
}

function stripLocal(p) {
  const { id, links, ...rest } = p;
  return rest;
}

export function serialize(project) {
  return JSON.stringify({ format: FORMAT, version: 2, project: stripLocal(project) }, null, 2);
}

// 戻り値: プロジェクトの中身（id・links なし）
export function parse(text, fileName = '') {
  let o = null;
  try { o = JSON.parse(text); } catch { /* JSON ではない */ }
  if (o && o.format === FORMAT) {
    if (o.version >= 2 && o.project) return stripLocal(normalize(o.project));
    return stripLocal(fromSingle(o));
  }
  return stripLocal(fromSingle({ title: fileName.replace(/\.[^.]+$/, ''), body: text }));
}

export function fileName(title, ext) {
  const base = (title || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 80);
  return (base || '無題') + ext;
}

export function countChars(text) {
  return {
    all: [...text].length,
    noSpace: [...text.replace(/\s/g, '')].length,
  };
}

// エピソードの表示名（タイトルに「第○話」を含めて書く前提なので、番号は付けない）
export function episodeName(ep) {
  return ep.title || '（無題）';
}
