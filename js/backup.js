// 全体バックアップ：端末内のすべての作品・ひな型・設定を1つのファイルにまとめる
import { db, prefs, versions } from './db.js';
import { normalize, newProject, makeId } from './format.js';

export const BACKUP_FORMAT = 'novel-editor-backup';
export const PACK_FORMAT = 'ayatuzuri-backup-pack';
export const PACK_VERSION = 1;

// 端末ごとの設定（自動バックアップの記録・保存先・開いている作品など）は、バックアップに入れず、戻すときも使わない。
// 他の端末のバックアップを読み込んだときに、この端末の設定が書き換わらないように。
// 画面の幅・iPhone の高さなど、端末の画面に合わせたものも入れない。
const DEVICE_PREFS = /^(sync\.|file\.|cloud\.|gdrive\.(folder|known)$|onedrive\.folder$|autoBackup|lastAutoBackupAt$|lastBackupAt$|restoredMessage$|restoredReport$|currentId$|settingsTab$|split$|plotMemoSplit$|sidebarWidth$|iphone\.|fold\.)/;
const sharedPrefs = (entries) => Object.fromEntries(Object.entries(entries || {}).filter(([k]) => !DEVICE_PREFS.test(k)));

// 端末ごとの設定のうち、「環境」として明示的に読み込むときだけ使うもの（ファイルの保存先の選び方・自動バックアップの間隔と件数・画面の幅など）。
// 自動バックアップの状態・保存先フォルダ・プレフィックス・ログイン・開いている作品などは、端末そのものの記録なので入れない。
const PORTABLE_DEVICE_PREFS = /^(file\.destination$|autoBackupInterval$|autoBackupKeep$|split$|plotMemoSplit$|sidebarWidth$|iphone\.)/;
const portableDevicePrefs = (entries) => Object.fromEntries(Object.entries(entries || {}).filter(([k]) => DEVICE_PREFS.test(k) && PORTABLE_DEVICE_PREFS.test(k)));

// まとめるときに、id ごとに合わせる一覧（同じ id は読み込んだ側）
const LISTS_BY_ID = ['templates', 'importPresets'];

function mergeList(remote, mine, keyOf) {
  const keys = new Set(remote.map(keyOf));
  return [...remote, ...mine.filter((x) => !keys.has(keyOf(x)))];
}

/**
 * 読み込んだバックアップの設定を、この端末の設定にまとめる（この端末の設定は消さない）
 *   ひな型・TXTインポートの条件 … id ごとにまとめる（同じものは読み込んだ側）
 *   リンク                       … URL ごとにまとめる
 *   投稿サイトのアカウント       … この端末で空の欄だけ埋める
 *   そのほか（書き出しの列の選び方など） … この端末にまだない設定だけ入れる
 */
export function mergeSharedPrefs(remotePrefs) {
  for (const [key, value] of Object.entries(sharedPrefs(remotePrefs))) {
    if (value === null || value === undefined) continue;
    const mine = prefs.get(key, null);
    if (LISTS_BY_ID.includes(key) && Array.isArray(value)) {
      prefs.set(key, mergeList(value, Array.isArray(mine) ? mine : [], (x) => x?.id));
    } else if (key === 'links' && Array.isArray(value)) {
      prefs.set(key, mine === null ? value : mergeList(value, Array.isArray(mine) ? mine : [], (x) => x?.url));
    } else if (key === 'accounts' && typeof value === 'object') {
      const merged = { ...(mine || {}) };
      for (const [site, acc] of Object.entries(value)) {
        merged[site] = { ...(merged[site] || {}) };
        for (const [k, v] of Object.entries(acc || {})) if (v && !merged[site][k]) merged[site][k] = v;
      }
      prefs.set(key, merged);
    } else if (mine === null) {
      prefs.set(key, value);
    }
  }
}

export async function makeBackup({ device = null } = {}) {
  const projects = await db.all();
  const allVersions = await versions.all();
  return {
    text: JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      ...(device ? { device } : {}),
      projects,
      versions: allVersions,
      prefs: sharedPrefs(prefs.entries()),
      devicePrefs: portableDevicePrefs(prefs.entries()), // 「環境」を読み込むときだけ使う
    }, null, 1),
    count: projects.length,
    versionCount: allVersions.length,
  };
}

export function isBackup(text) {
  try { return JSON.parse(text)?.format === BACKUP_FORMAT; } catch { return false; }
}

export function parseBackup(text) {
  const o = JSON.parse(text);
  if (o?.format !== BACKUP_FORMAT || !Array.isArray(o.projects)) throw new Error('バックアップファイルではありません');
  return o;
}

// ---------- 環境（設定・ひな型・リンク・アカウントなど。小説は含まない） ----------

const ENV_LABELS = [
  ['templates', 'ひな型', (v) => (Array.isArray(v) ? `${v.length}件` : '')],
  ['links', 'リンク', (v) => (Array.isArray(v) ? `${v.length}件` : '')],
  ['accounts', '投稿サイトのアカウント', () => ''],
  ['importPresets', 'TXT インポートの条件', (v) => (Array.isArray(v) ? `${v.length}件` : '')],
  ['gdrive.clientId', 'Google ドライブのクライアントID', () => ''],
  ['onedrive.clientId', 'OneDrive のアプリケーション（クライアント）ID', () => ''],
];

/** バックアップに入っている環境の中身（画面で知らせる用）。何もなければ空の配列 */
export function environmentSummary(backup) {
  const p = backup?.prefs || {};
  const lines = [];
  for (const [key, label, count] of ENV_LABELS) if (p[key] !== undefined && p[key] !== null) lines.push(`${label}${count(p[key]) ? `（${count(p[key])}）` : ''}`);
  const others = Object.keys(sharedPrefs(p)).filter((k) => !ENV_LABELS.some(([key]) => key === k)).length
    + Object.keys(backup?.devicePrefs || {}).length;
  if (others) lines.push(`表示・ファイル・自動バックアップの間隔・書き出しの選び方などの設定（${others}項目）`);
  return lines;
}

/**
 * バックアップの環境を、この端末に読み込む（小説は変えない）
 *   'merge'   … この端末の設定を残してまとめる（mergeSharedPrefs と同じ）
 *   'replace' … バックアップの設定で上書きする（端末ごとの設定のうち、表示・ファイル・自動バックアップの間隔なども）
 * 自動バックアップの保存先・プレフィックス・ログインなど、端末そのものの記録は変えない。
 */
export function applyEnvironment(backup, mode) {
  if (mode === 'merge') { mergeSharedPrefs(backup.prefs); return; }
  for (const [key, value] of Object.entries({ ...sharedPrefs(backup.prefs), ...portableDevicePrefs(backup.devicePrefs) })) {
    prefs.set(key, value);
  }
}

/**
 * バックアップから戻す
 * mode 'merge'   … バックアップの作品を追加・上書き（端末にしかない作品は残す）
 * mode 'replace' … 端末の作品をすべて消してから、バックアップの内容にする
 */
export async function restoreBackup(backup, mode) {
  if (mode === 'replace') {
    for (const p of await db.all()) await db.remove(p.id);
    await versions.clear();
  }
  for (const p of backup.projects) {
    if (p && p.id) await db.put(normalize(p));
  }
  for (const v of backup.versions || []) {
    if (v && v.id && v.projectId) await versions.put(v);
  }
  const saved = sharedPrefs(backup.prefs);
  for (const [key, value] of Object.entries(saved)) {
    if (mode === 'merge' && LISTS_BY_ID.includes(key) && Array.isArray(value)) {
      // ひな型・TXTインポートの条件は、端末にあるものとまとめる（同じものはバックアップ側を使う）
      const mine = prefs.get(key, []) || [];
      prefs.set(key, mergeList(value, Array.isArray(mine) ? mine : [], (x) => x?.id));
    } else {
      prefs.set(key, value);
    }
  }
  // 入れ替えるときは、表示・ファイル・自動バックアップの間隔などの端末の設定もバックアップのものにする
  if (mode === 'replace') for (const [key, value] of Object.entries(portableDevicePrefs(backup.devicePrefs))) prefs.set(key, value);
  return backup.projects.length;
}

export function backupFileName() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `あや綴り_全体_${ymd}.json`;
}

// ---------- 選択式バックアップパック ----------
// 必要な環境・作品・作品資料・エピソードを、項目数にかかわらず一つの JSON にまとめる。
// 旧 novel-editor-backup は parseAnyBackup() で同じ確認画面へ変換する。

const clone = (value) => structuredClone(value);
const safePart = (value, max = 36) => String(value || '')
  .replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, max);

function environmentPayload() {
  return {
    prefs: sharedPrefs(prefs.entries()),
    devicePrefs: portableDevicePrefs(prefs.entries()),
  };
}

function projectMaterials(p) {
  const n = normalize(p);
  return {
    title: n.title,
    site: n.site,
    narouUrl: n.narouUrl,
    alphaUrl: n.alphaUrl,
    narouNcode: n.narouNcode,
    alphaWorkId: n.alphaWorkId,
    synopsis: n.synopsis,
    projectMemo: n.projectMemo || '',
    chapters: clone(n.chapters),
    world: clone(n.world),
    characters: clone(n.characters),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

const versionTime = (v) => v.updatedAt || v.createdAt || '';
function episodeVersions(allVersions, projectId, episodeId) {
  return allVersions.filter((v) => v.projectId === projectId && v.episodeId === episodeId)
    .sort((a, b) => String(versionTime(a)).localeCompare(String(versionTime(b))));
}

function projectIdentity(p) {
  return { workId: p.workId, title: p.title || '無題', createdAt: p.createdAt, updatedAt: p.updatedAt };
}

function episodeItem(p, ep, allVersions) {
  const index = p.episodes.findIndex((e) => e.id === ep.id);
  const chapter = p.chapters.find((c) => c.id === ep.chapterId) || null;
  return {
    key: `episode:${p.workId}:${ep.id}`,
    type: 'episode',
    project: projectIdentity(p),
    chapter: chapter ? clone(chapter) : null,
    order: index,
    episode: clone(ep),
    versions: clone(episodeVersions(allVersions, p.id, ep.id)),
  };
}

/**
 * plan:
 *   environment: boolean
 *   scope: 'all' | 'project' | 'custom' | 'targets' | 'none'
 *   projectId, materials, episodeIds
 *   targets: [{ projectId, episodeIds }]
 *   reason: 'manual-pack' | 'manual-episode' | 'auto-episode'
 */
export async function makePack(plan = {}) {
  const projects = (await db.all()).map((p) => normalize(p));
  const allVersions = await versions.all();
  const items = [];
  const addWhole = (p) => items.push({
    key: `project:${p.workId}`, type: 'project', project: clone(p),
    versions: clone(allVersions.filter((v) => v.projectId === p.id)),
  });
  const addMaterials = (p) => items.push({
    key: `materials:${p.workId}`, type: 'materials', project: projectIdentity(p), data: projectMaterials(p),
  });
  const addEpisodes = (p, ids) => {
    const wanted = new Set(ids || []);
    for (const ep of p.episodes) if (wanted.has(ep.id)) items.push(episodeItem(p, ep, allVersions));
  };

  if (plan.scope === 'all') projects.forEach(addWhole);
  if (plan.scope === 'project') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) addWhole(p);
  }
  if (plan.scope === 'custom') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) {
      if (plan.materials) addMaterials(p);
      addEpisodes(p, plan.episodeIds);
    }
  }
  if (plan.scope === 'targets') {
    for (const target of plan.targets || []) {
      const p = projects.find((x) => x.id === target.projectId || x.workId === target.workId);
      if (p) addEpisodes(p, target.episodeIds);
    }
  }

  if (!plan.environment && !items.length) throw new Error('保存する内容が選ばれていません');
  const createdAt = new Date().toISOString();
  const pack = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    appVersion: plan.appVersion || '',
    createdAt,
    reason: plan.reason || 'manual-pack',
    device: plan.device || null,
    environment: plan.environment ? environmentPayload() : null,
    items,
  };
  return { pack, text: JSON.stringify(pack, null, 1), itemCount: items.length };
}

export function isPack(text) {
  try { return JSON.parse(text)?.format === PACK_FORMAT; } catch { return false; }
}

export function parsePack(text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw new Error(`JSONとして読めませんでした（${e.message}）`); }
  if (o?.format !== PACK_FORMAT || !Array.isArray(o.items)) throw new Error('あや綴りのバックアップパックではありません');
  if ((o.version || 0) > PACK_VERSION) throw new Error(`新しい形式（v${o.version}）です。あや綴りを更新してください`);
  return o;
}

function legacyToPack(backup) {
  const allVersions = backup.versions || [];
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    legacy: true,
    appVersion: '',
    createdAt: backup.createdAt,
    reason: 'legacy-full',
    device: backup.device || null,
    environment: { prefs: backup.prefs || {}, devicePrefs: backup.devicePrefs || {} },
    items: backup.projects.map((p) => ({
      key: `project:${p.workId || p.id}`,
      type: 'project',
      project: clone(p),
      versions: clone(allVersions.filter((v) => v.projectId === p.id)),
    })),
  };
}

export function parseAnyBackup(text) {
  if (isPack(text)) return parsePack(text);
  if (isBackup(text)) return legacyToPack(parseBackup(text));
  throw new Error('あや綴りのバックアップファイルではありません');
}

export function packFileName(pack, { title = '', episodeId = '', workId = '', prefix = '' } = {}) {
  const stamp = String(pack.createdAt || new Date().toISOString()).replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const device = safePart(prefix || pack.device?.prefix || 'device', 28);
  const kind = pack.reason === 'manual-episode' ? 'EPISODE' : pack.reason === 'auto-episode' ? 'AUTO' : 'PACK';
  const parts = ['あや綴り', kind];
  if (workId) parts.push(safePart(workId, 8));
  if (episodeId) parts.push(safePart(episodeId, 8));
  if (title) parts.push(safePart(title, 32));
  parts.push(device, stamp);
  return parts.filter(Boolean).join('__') + '.json';
}

export function packSummary(pack) {
  const projects = new Map();
  let episodes = 0;
  for (const item of pack.items || []) {
    const p = item.type === 'project' ? item.project : item.project;
    const workId = p?.workId || p?.id || item.key;
    const title = p?.title || '無題';
    if (!projects.has(workId)) projects.set(workId, { title, whole: false, materials: false, episodes: 0, editions: 0 });
    const row = projects.get(workId);
    if (item.type === 'project') {
      row.whole = true;
      row.episodes = item.project?.episodes?.length || 0;
      row.editions += (item.versions || []).filter((v) => v.kind === 'episode').length;
    } else if (item.type === 'materials') row.materials = true;
    else if (item.type === 'episode') {
      row.episodes++;
      row.editions += (item.versions || []).filter((v) => v.kind === 'episode').length;
      episodes++;
    }
  }
  return { environment: !!pack.environment, projects: [...projects.values()], episodes, itemCount: (pack.items || []).length };
}

function newVersionId() { return makeId(); }
function remapVersions(list, projectId, idMap = null) {
  const map = idMap || new Map((list || []).map((v) => [v.id, newVersionId()]));
  return {
    map,
    values: (list || []).map((v) => ({ ...clone(v), id: map.get(v.id) || v.id, projectId })),
  };
}

function remapEditionIds(project, map) {
  for (const ep of project.episodes || []) {
    if (!ep.editionIds) continue;
    ep.editionIds = Object.fromEntries(Object.entries(ep.editionIds).map(([site, id]) => [site, map.get(id) || id]));
  }
}

/** 選択したパック項目を端末へ復元する。asNew=true は既存作品を変更せず、別作品として追加する。 */
export async function restorePack(pack, { selected = null, asNew = false, environmentMode = 'merge' } = {}) {
  const keys = selected ? new Set(selected) : null;
  const use = (key) => !keys || keys.has(key);
  if (pack.environment && use('environment')) applyEnvironment(pack.environment, environmentMode);
  const locals = await db.all();
  const byWork = new Map(locals.map((p) => [p.workId, normalize(p)]));
  const created = new Map();
  const result = { addedList: [], updatedList: [], keptList: [] };

  const targetFor = async (remote, title) => {
    const workId = remote.workId || remote.id || makeId();
    if (!asNew && byWork.has(workId)) return byWork.get(workId);
    if (created.has(workId)) return created.get(workId);
    const p = newProject({ title: asNew ? `${title || '無題'}（バックアップ）` : (title || '無題'), workId: asNew ? makeId() : workId });
    created.set(workId, p);
    result.addedList.push({ id: p.id, title: p.title });
    return p;
  };

  for (const item of pack.items || []) {
    if (!use(item.key)) continue;
    if (item.type === 'project') {
      const src = normalize(item.project);
      const existing = !asNew ? byWork.get(src.workId) : null;
      const localId = existing?.id || makeId();
      const links = existing?.links || {};
      const restored = normalize({ ...clone(src), id: localId, links, workId: asNew ? makeId() : src.workId });
      let versionValues = item.versions || [];
      if (asNew || !existing) {
        const remapped = remapVersions(versionValues, localId);
        versionValues = remapped.values;
        remapEditionIds(restored, remapped.map);
      } else {
        versionValues = versionValues.map((v) => ({ ...clone(v), projectId: localId }));
      }
      await db.put(restored);
      if (existing) await versions.removeProject(localId);
      for (const v of versionValues) await versions.put(v);
      if (existing) result.updatedList.push({ id: localId, title: restored.title || '無題' });
      else if (!result.addedList.some((x) => x.id === localId)) result.addedList.push({ id: localId, title: restored.title || '無題' });
      byWork.set(restored.workId, restored);
      continue;
    }

    const remote = item.project || {};
    const target = await targetFor(remote, remote.title);
    const existedBefore = locals.some((p) => p.id === target.id);
    if (item.type === 'materials') {
      Object.assign(target, clone(item.data), { id: target.id, workId: target.workId, links: target.links || {}, episodes: target.episodes });
    } else if (item.type === 'episode') {
      if (item.chapter && !target.chapters.some((c) => c.id === item.chapter.id)) target.chapters.push(clone(item.chapter));
      const srcEp = clone(item.episode);
      const index = target.episodes.findIndex((e) => e.id === srcEp.id);
      if (index >= 0) {
        for (const v of await versions.list(target.id)) if (v.episodeId === srcEp.id) await versions.remove(v.id);
        target.episodes[index] = srcEp;
      } else if (target.episodes.length === 1 && !target.episodes[0].plot && !target.episodes[0].freeMemo
        && Object.values(target.episodes[0].drafts || {}).every((d) => !d.title && !d.body && !d.foreword && !d.afterword)) {
        target.episodes[0] = srcEp;
      } else target.episodes.splice(Math.min(item.order ?? target.episodes.length, target.episodes.length), 0, srcEp);
      const remapped = remapVersions(item.versions || [], target.id, asNew ? null : new Map((item.versions || []).map((v) => [v.id, v.id])));
      if (asNew) remapEditionIds({ episodes: [srcEp] }, remapped.map);
      for (const v of remapped.values) await versions.put(v);
    }
    target.updatedAt = new Date().toISOString();
    await db.put(normalize(target));
    byWork.set(target.workId, normalize(target));
    if (existedBefore && !result.updatedList.some((x) => x.id === target.id)) result.updatedList.push({ id: target.id, title: target.title || '無題' });
  }
  return result;
}

// ---------- エピソード専用ファイル ----------
// 1話分（なろう用・アルファ用の両方の原稿、プロット、フリーメモ）を1ファイルにする
export const EPISODE_FORMAT = 'novel-editor-episode';

export function makeEpisodeFile(ep, workTitle = '') {
  return JSON.stringify({
    format: EPISODE_FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    workTitle,
    episode: { drafts: ep.drafts, plot: ep.plot ?? '', freeMemo: ep.freeMemo ?? '' },
  }, null, 1);
}

export function isEpisodeFile(text) {
  try { return JSON.parse(text)?.format === EPISODE_FORMAT; } catch { return false; }
}

export function parseEpisodeFile(text) {
  const o = JSON.parse(text);
  if (o?.format !== EPISODE_FORMAT || !o.episode?.drafts) throw new Error('エピソードのファイルではありません');
  return o;
}

// ブラウザに「保存データを勝手に消さないで」と頼む（対応ブラウザのみ）
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && await navigator.storage.persisted()) return true;
    return await navigator.storage?.persist?.() ?? false;
  } catch {
    return false;
  }
}
