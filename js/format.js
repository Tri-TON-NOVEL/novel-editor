// 作品（プロジェクト）のデータ形式とファイル形式
//
// project = {
//   id, title, site: 'narou' | 'alpha', memo, narouUrl, alphaUrl,
//   episodes: [{ id, title, foreword, body, afterword, plot }],  ※前書き・後書きはなろうのみ
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

export function newProject(content = {}) {
  const now = new Date().toISOString();
  return {
    id: makeId(),
    title: '',
    site: 'narou',
    memo: '',
    narouUrl: '',
    alphaUrl: '',
    episodes: [newEpisode()],
    reports: { x: '', narouTitle: '', narouBody: '' },
    createdAt: now,
    updatedAt: now,
    links: {},
    ...content,
  };
}

// 足りない項目を補う（古いデータや他の端末のデータを読み込んだとき用）
export function normalize(p) {
  const base = newProject();
  const project = { ...base, ...p, reports: { ...base.reports, ...(p.reports || {}) }, links: { ...(p.links || {}) } };
  project.episodes = (p.episodes && p.episodes.length ? p.episodes : [{}]).map((e) => newEpisode({ ...e, id: e.id || makeId() }));
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

export function episodeLabel(index) {
  return `第${index + 1}話`;
}
