// 全体バックアップ：端末内のすべての作品・ひな型・設定を1つのファイルにまとめる
import { db, meta, prefs, versions } from './db.js';
import { normalize, newProject, makeId, draftOf, SCHEMA_VERSION } from './format.js';

// ファイルの形式。形を変えたら、その形式の VERSION を上げる。
// 中に入る作品データの形式は、format.js の SCHEMA_VERSION（どのファイルにも schemaVersion として記録する）。
// 読み込むときは両方を確かめ、この端末のアプリより新しければ読み込まない（古い形のまま誤って読まないように）。
export const BACKUP_FORMAT = 'novel-editor-backup';
export const BACKUP_VERSION = 1;
export const PACK_FORMAT = 'ayatuzuri-backup-pack';
export const PACK_VERSION = 1;

export class TooNewFormatError extends Error {
  constructor(what, detail) {
    super(`この${what}は、新しい版のあや綴りで保存されています（${detail}）。あや綴りを最新版に更新してから読み込んでください`);
    this.name = 'TooNewFormatError';
  }
}

// 形式の版（version）と作品データの版（schemaVersion。記録のない古いファイルは 3 として扱う）を確かめる
function checkNotTooNew(o, what, maxVersion) {
  const v = Number(o?.version ?? 1);
  if (v > maxVersion) throw new TooNewFormatError(what, `形式 v${v}`);
  const s = Number(o?.schemaVersion ?? 3);
  if (s > SCHEMA_VERSION) throw new TooNewFormatError(what, `作品データ v${s}`);
}

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
const LISTS_BY_ID = ['templates', 'importPresets', 'importFormats'];

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
      version: BACKUP_VERSION,
      schemaVersion: SCHEMA_VERSION,
      createdAt: new Date().toISOString(),
      ...(device ? { device } : {}),
      projects,
      versions: allVersions,
      prefs: withoutClientIds(sharedPrefs(prefs.entries())), // クライアントIDは入れない
      devicePrefs: portableDevicePrefs(prefs.entries()), // 「環境」を読み込むときだけ使う
    }), // 字下げはしない（大きい作品では字下げだけで何割も増え、iPhone のメモリを圧迫するため。読み込みには関係しない）
    count: projects.length,
    versionCount: allVersions.length,
  };
}

// makeBackup と同じ中身を、Blob にして作る（読み込む前に残す「同期の前の状態」用）。
// 稿・履歴は少しずつ読んでは書き出すので、端末の全データを一つの文字列にしない（iPhone で、復元中に落ちていた）
export async function makeBackupBlob({ device = null } = {}) {
  const w = blobWriter();
  w.push(JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    ...(device ? { device } : {}),
  }).slice(0, -1));
  const projects = await db.all();
  const count = projects.length;
  w.push(',"projects":[');
  projects.forEach((p, i) => { w.push((i ? ',' : '') + JSON.stringify(p)); projects[i] = null; });
  w.push('],"versions":[');
  let versionCount = 0;
  for (let after = null; ;) {
    const page = await versions.page(after, 50);
    for (const v of page) w.push((versionCount++ ? ',' : '') + JSON.stringify(v));
    if (page.length < 50) break;
    after = page.at(-1).id;
  }
  w.push(`],"prefs":${JSON.stringify(withoutClientIds(sharedPrefs(prefs.entries())))}`);
  w.push(`,"devicePrefs":${JSON.stringify(portableDevicePrefs(prefs.entries()))}}`);
  return { blob: w.finish(), count, versionCount };
}

// 読み込む前の端末全体の状態を「同期の前の状態」として残す（設定 → バックアップ の「同期の前の状態を書き出す」）。
// 残せなくても読み込みは止めない（作品ごとの復元ポイント「バックアップ読み込み前（自動）」は別に残している）
export async function savePreSyncState(from = '') {
  try {
    const { blob } = await makeBackupBlob();
    await meta.set('preSyncBackup', { createdAt: new Date().toISOString(), from, text: blob });
  } catch (e) {
    console.warn('同期の前の状態を残せませんでした', e);
  }
}

// 小さな文字列を 1MB ほどずつ Blob にまとめていく（文字列のほうはすぐ手放せる）
function blobWriter() {
  const chunks = [];
  let parts = [];
  let size = 0;
  const flush = () => { if (parts.length) chunks.push(new Blob(parts)); parts = []; size = 0; };
  return {
    push(s) { parts.push(s); size += s.length; if (size > 1 << 20) flush(); },
    finish() { flush(); return new Blob(chunks, { type: 'application/json' }); },
  };
}

// ファイルの種類（先頭の "format"）。大きいファイルを丸ごと JSON として読まずに見分ける（iPhone で、読み込みのたびに何度も丸ごと読んで落ちていた）。
// あや綴りのファイルは "format" を先頭に書いている。先頭になければ、丸ごと読んで確かめる
export function fileFormat(text) {
  const m = /^\uFEFF?\s*\{\s*"format"\s*:\s*"([^"\\]*)"/.exec(String(text).slice(0, 200));
  if (m) return m[1];
  try { return JSON.parse(text)?.format ?? null; } catch { return null; }
}

export function isBackup(text) {
  return fileFormat(text) === BACKUP_FORMAT;
}

export function parseBackup(text) {
  const o = JSON.parse(text);
  if (o?.format !== BACKUP_FORMAT || !Array.isArray(o.projects)) throw new Error('バックアップファイルではありません');
  checkNotTooNew(o, '全体バックアップ', BACKUP_VERSION);
  return o;
}

// ---------- 環境（設定・ひな型・リンク・アカウントなど。小説は含まない） ----------

const ENV_LABELS = [
  ['templates', 'ひな型', (v) => (Array.isArray(v) ? `${v.length}件` : '')],
  ['links', 'リンク', (v) => (Array.isArray(v) ? `${v.length}件` : '')],
  ['accounts', '投稿サイトのアカウント', () => ''],
  ['importPresets', 'TXT インポートの条件', (v) => (Array.isArray(v) ? `${v.length}件` : '')],
  ['importFormats', 'TXT インポートの書式', (v) => (Array.isArray(v) ? `${v.length}件` : '')],
  ['gdrive.clientId', 'Google ドライブのクライアントID', () => ''],
  ['onedrive.clientId', 'OneDrive のアプリケーション（クライアント）ID', () => ''],
];
const CLOUD_LABELS = {
  'cloud.provider': (v) => `使うクラウド（${{ gdrive: 'Google ドライブ', onedrive: 'OneDrive', none: 'なし' }[v] || v}）`,
  'gdrive.folder': (v) => `Google ドライブの保存先フォルダ${v?.name ? `（${v.name}）` : ''}`,
  'gdrive.backupFolder': (v) => `Google ドライブの自動バックアップ先${v?.name ? `（${v.name}）` : ''}`,
  'onedrive.folder': (v) => `OneDrive の保存先フォルダ${v?.name ? `（${v.name}）` : ''}`,
  'onedrive.backupFolder': (v) => `OneDrive の自動バックアップ先${v?.name ? `（${v.name}）` : ''}`,
  'sync.mode': (v) => `自動バックアップの方式（${{ off: '使わない', folder: 'フォルダ', cloud: 'クラウド', gdrive: 'クラウド' }[v] || v}）`,
};

/** バックアップに入っている環境の中身（画面で知らせる用）。何もなければ空の配列 */
export function environmentSummary(backup) {
  const p = backup?.prefs || {};
  const lines = [];
  for (const [key, label, count] of ENV_LABELS) if (p[key] !== undefined && p[key] !== null) lines.push(`${label}${count(p[key]) ? `（${count(p[key])}）` : ''}`);
  for (const [key, value] of Object.entries(backup?.cloud || {})) if (CLOUD_LABELS[key] && value !== null && value !== undefined) lines.push(CLOUD_LABELS[key](value));
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
  // クライアントIDが入っていない（空の）ときは、この端末のクライアントIDを消さない
  const remote = Object.fromEntries(Object.entries(backup.prefs || {}).filter(([k, v]) => !CLIENT_ID_PREFS.includes(k) || (typeof v === 'string' && v.trim())));
  const before = { provider: prefs.get('cloud.provider', null), ids: CLIENT_ID_PREFS.map((k) => prefs.get(k, '')) };
  if (mode === 'merge') mergeSharedPrefs(remote);
  else {
    for (const [key, value] of Object.entries({ ...sharedPrefs(remote), ...portableDevicePrefs(backup.devicePrefs) })) prefs.set(key, value);
  }
  // 表示（折りたたみ）とクラウド・フォルダの設定。まとめるときは、この端末でまだ決めていないものだけ
  const extra = {
    ...Object.fromEntries(Object.entries(backup.devicePrefs || {}).filter(([k]) => DISPLAY_DEVICE_PREFS.test(k))),
    ...Object.fromEntries(Object.entries(backup.cloud || {}).filter(([k]) => CLOUD_PREFS.test(k))),
  };
  const cloudChanged = [];
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined) continue;
    const mine = prefs.get(key, null);
    if (mode === 'merge' && mine !== null) continue;
    if (JSON.stringify(mine) === JSON.stringify(value)) continue;
    prefs.set(key, value);
    if (CLOUD_PREFS.test(key)) cloudChanged.push(key);
  }
  const idsChanged = CLIENT_ID_PREFS.some((k, i) => prefs.get(k, '') !== before.ids[i]);
  // クラウドを切り替えた・フォルダやクライアントIDが変わった → つなぎ直し・フォルダの選び直しが要ることがある
  return { cloudChanged, idsChanged, providerChanged: prefs.get('cloud.provider', null) !== before.provider };
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
    // 前の版のファイルに入っている空のクライアントIDで、この端末のクライアントIDを消さない（applyEnvironment と同じ）
    if (CLIENT_ID_PREFS.includes(key) && !(typeof value === 'string' && value.trim())) continue;
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

// 全体バックアップ（旧形式。作品すべて＋環境）。名前は [対象]_[範囲]_[日時]
export function backupFileName(label = '', at = new Date()) {
  return `環境＋小説全作品${label ? '_' + label : ''}_${fileStamp(at)}.json`;
}

// ファイル名に使う日時（この端末の時刻）：20261030-073000
export function fileStamp(at = new Date()) {
  const d = new Date(at);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ---------- 選択式バックアップパック ----------
// 必要な環境・作品・作品資料・エピソードを、項目数にかかわらず一つの JSON にまとめる。
// 旧 novel-editor-backup は parseAnyBackup() で同じ確認画面へ変換する。

const clone = (value) => structuredClone(value);
const safePart = (value, max = 36) => String(value || '')
  .replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, max);

// クラウド・保存先フォルダの設定（どのクラウドを使うか・選んだフォルダ・自動バックアップの方式）。
// 環境として読み込むときだけ使う。ログインの鍵（novel-editor-session:）はここにも、どのバックアップにも入らない
const CLOUD_PREFS = /^(cloud\.provider|gdrive\.(folder|backupFolder)|onedrive\.(folder|backupFolder)|sync\.mode)$/;
// 表示の設定のうち、端末の記録として外していたもの（折りたたみの状態）
const DISPLAY_DEVICE_PREFS = /^fold\./;
// OAuth のクライアントID。7.7.4 からはどのバックアップにも入れない（前の版で入れたファイルは、今までどおり読める）
export const CLIENT_ID_PREFS = ['gdrive.clientId', 'onedrive.clientId'];
const withoutClientIds = (entries) => Object.fromEntries(Object.entries(entries || {}).filter(([k]) => !CLIENT_ID_PREFS.includes(k)));

function environmentPayload() {
  const all = prefs.entries();
  const pick = (re) => Object.fromEntries(Object.entries(all).filter(([k]) => re.test(k)));
  return {
    prefs: withoutClientIds(sharedPrefs(all)),
    devicePrefs: { ...portableDevicePrefs(all), ...pick(DISPLAY_DEVICE_PREFS) },
    cloud: pick(CLOUD_PREFS),
    clientIdIncluded: false,
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
  // 稿・履歴は、入れる作品の分だけ読む（自動バックアップのような1話分のパックでも、端末の全作品の稿を読み込んでいた。iPhone のメモリを節約するため）
  const versionsOf = async (p) => versions.list(p.id);
  const items = [];
  // 作品全体は大きい（稿・変更履歴・復元ポイントを全部含む）ので、写しを作らずにそのまま入れる。
  // db.all()・versions.list() はどちらも読み出したばかりの別の物なので、ここで書き換えられる心配はない（iPhone のメモリを節約するため）
  const addWhole = async (p) => items.push({
    key: `project:${p.workId}`, type: 'project', project: p,
    versions: await versionsOf(p),
  });
  const addMaterials = (p) => items.push({
    key: `materials:${p.workId}`, type: 'materials', project: projectIdentity(p), data: projectMaterials(p),
  });
  const addEpisodes = async (p, ids) => {
    const wanted = new Set(ids || []);
    if (!p.episodes.some((ep) => wanted.has(ep.id))) return;
    const list = await versionsOf(p);
    for (const ep of p.episodes) if (wanted.has(ep.id)) items.push(episodeItem(p, ep, list));
  };

  if (plan.scope === 'all') for (const p of projects) await addWhole(p);
  if (plan.scope === 'project') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) await addWhole(p);
  }
  // 作品資料だけ／エピソードだけ（エピソードは複数選べる）。'custom' は前の版の画面（資料とエピソードを一緒に選ぶ）
  if (plan.scope === 'materials') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) addMaterials(p);
  }
  if (plan.scope === 'episodes') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) await addEpisodes(p, plan.episodeIds);
  }
  if (plan.scope === 'custom') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) {
      if (plan.materials) addMaterials(p);
      await addEpisodes(p, plan.episodeIds);
    }
  }
  if (plan.scope === 'targets') {
    for (const target of plan.targets || []) {
      const p = projects.find((x) => x.id === target.projectId || x.workId === target.workId);
      if (!p) continue;
      // 作品資料が変わっていれば一緒に入れる（自動バックアップ・編集エピソード保存）
      if (target.materials) addMaterials(p);
      await addEpisodes(p, target.episodeIds);
    }
  }

  if (!plan.environment && !items.length) throw new Error('保存する内容が選ばれていません');
  const createdAt = new Date().toISOString();
  const pack = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    schemaVersion: SCHEMA_VERSION,
    appVersion: plan.appVersion || '',
    createdAt,
    reason: plan.reason || 'manual-pack',
    device: plan.device || null,
    environment: plan.environment ? environmentPayload() : null,
    items,
  };
  // 一覧の表示とファイル名のための管理情報（読み込みには使わない。なくても読める）
  const { works, ...meta } = packMeta(pack);
  // wholeCount：「作品全体」の数（同じ作品を別々に持っていることもあるので、作品の種類の数とは限らない。一覧で先頭だけ読むときに使う）
  pack.meta = { ...meta, scope: items.length ? (plan.scope || meta.scope) : null, wholeCount: items.filter((x) => x.type === 'project').length };
  // 作ったあとに使うのは、ファイル名・一覧の表示・「保存済み」の記録だけ。そのための見出し（本文・稿・履歴を除いたもの）を先に作っておく
  const brief = { ...pack, items: items.map(briefItem) };
  // 保存には blob を使う（全作品のような大きいパックでも、巨大な文字列を一度に作らない。iPhone はメモリが少なく、ここで失敗していた）。
  // 中身は Blob に書き出したそばから手放し、アップロードの間は Blob だけがメモリに残るようにする（iPhone で、アップロード中に落ちていた）
  projects.length = 0;
  const blob = packBlob(pack, { release: true });
  return { pack: brief, blob, itemCount: items.length };
}

// パックの項目の見出し（ファイル名・一覧の表示・「保存済み」の記録に使う分だけ）
function briefItem({ key, type, order, project, episode }) {
  return {
    key, type, order,
    project: project ? { id: project.id, workId: project.workId, title: project.title } : project,
    ...(episode ? { episode: { id: episode.id, title: episode.title } } : {}),
  };
}

// パックを JSON のファイルの中身（Blob）にする。項目・稿ごとに小さな文字列にして並べるので、
// 全体を一つの文字列にしたときの何倍ものメモリを使わずに済む。中身は JSON.stringify(pack) と同じ
// 小さな文字列は 1MB ほどずつ Blob にまとめ、文字列のほうはすぐ手放せるようにする。
// release：書き出した項目・稿をパックから外していく（作ったその場で保存するだけのとき。パックは使えなくなる）
export function packBlob(pack, { release = false } = {}) {
  const { items = [], ...head } = pack;
  const w = blobWriter();
  const push = (s) => w.push(s);
  push(JSON.stringify(head).slice(0, -1));
  push(',"items":[');
  items.forEach((item, i) => {
    if (i) push(',');
    const { versions, ...rest } = item;
    if (!Array.isArray(versions)) push(JSON.stringify(item));
    else {
      push(JSON.stringify(rest).slice(0, -1));
      push(',"versions":[');
      versions.forEach((v, j) => {
        if (j) push(',');
        push(JSON.stringify(v));
        if (release) versions[j] = null;
      });
      push(']}');
    }
    if (release) items[i] = null;
  });
  push(']}');
  return w.finish();
}

// ファイルの先頭だけから、中身（items・projects）より前にある管理情報を読む。読めなければ null。
// バックアップパックは管理情報（meta）を先頭に書いている（0.50 から）。全体バックアップは device などが先頭にある
export function parseBackupHead(text) {
  for (const marker of [',"items":[', ',"projects":[']) {
    // 環境設定の中に同じ並びの文字があることもあるので、読めるところを順に試す
    for (let i = text.indexOf(marker); i > 0; i = text.indexOf(marker, i + 1)) {
      try {
        const o = JSON.parse(text.slice(0, i) + '}');
        if (o?.format === PACK_FORMAT || o?.format === BACKUP_FORMAT) return o;
      } catch { /* 途中で切れている：次を試す */ }
    }
  }
  return null;
}

// 先頭の管理情報（meta）だけから、一覧に出すための中身の見出しを作る（本文・稿は入らない）。作れなければ null
export function packFromHead(head) {
  if (head?.format !== PACK_FORMAT || !head.meta?.content) return null;
  const m = head.meta;
  const titles = new Map((m.projects || []).map((p) => [p.workId, p.title]));
  const project = (workId) => ({ workId, title: titles.get(workId) || '無題' });
  const items = [];
  const episodes = m.episodes || [];
  if (m.scope === 'all' || m.scope === 'project') {
    for (const p of m.projects || []) items.push({ key: `project:${p.workId}`, type: 'project', project: project(p.workId) });
    // 同じ作品を別々に持っているとき、作品全体の数が作品の種類より多い（数を合わせるだけの見出しを足す）
    for (let i = items.length; i < (m.wholeCount || 0) && m.projects?.length; i++) {
      const p = m.projects[i % m.projects.length];
      items.push({ key: `project:${p.workId}`, type: 'project', project: project(p.workId) });
    }
  } else {
    // 作品資料だけのもの（エピソードのない作品）
    const withEpisodes = new Set(episodes.map((e) => e.workId));
    for (const p of m.projects || []) {
      if (!withEpisodes.has(p.workId)) items.push({ key: `materials:${p.workId}`, type: 'materials', project: project(p.workId) });
    }
    for (const e of episodes) {
      items.push({
        key: `episode:${e.workId}:${e.id}`, type: 'episode', project: project(e.workId),
        // 名前は、エピソード名の出し方（なろう用の稿のタイトル）に合わせて入れる
        order: Number.isInteger(e.no) ? e.no - 1 : undefined, episode: { id: e.id, drafts: e.title ? { narou: { title: e.title } } : {} },
      });
    }
  }
  return { ...head, items };
}

export function isPack(text) {
  return fileFormat(text) === PACK_FORMAT;
}

export function parsePack(text) {
  let o;
  try { o = JSON.parse(text); } catch (e) { throw new Error(`JSONとして読めませんでした（${e.message}）`); }
  if (o?.format !== PACK_FORMAT || !Array.isArray(o.items)) throw new Error('あや綴りのバックアップパックではありません');
  checkNotTooNew(o, 'バックアップパック', PACK_VERSION);
  return o;
}

function legacyToPack(backup) {
  const allVersions = backup.versions || [];
  return {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    schemaVersion: backup.schemaVersion ?? 3,
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

// ---------- 管理情報・ファイル名 ----------
// ファイル名は人が見分けるためのもの。同じ作品・エピソードかどうかは、中の workId・エピソードの id で見分ける（名前では判断しない）。

const episodeNo = (item) => (Number.isInteger(item.order) && item.order >= 0 ? item.order + 1 : null);
// エピソードの名前（なろう用、なければアルファ用のタイトル）。ないときは空
const episodeTitle = (ep) => (ep ? draftOf(ep, 'narou').title || draftOf(ep, 'alpha').title || '' : '');

function episodesLabel(list) {
  const nos = list.map(episodeNo).filter((n) => n !== null).sort((a, b) => a - b);
  if (!nos.length) return `${list.length}話`;
  if (nos.length === 1) return `第${nos[0]}話`;
  const contiguous = nos.every((n, i) => i === 0 || n === nos[i - 1] + 1);
  return contiguous ? `第${nos[0]}-${nos.at(-1)}話` : `第${nos[0]}話ほか${nos.length - 1}話`;
}

/** パックの中身から、一覧とファイル名に使う情報を作る（古いファイルにも使える） */
export function packMeta(pack) {
  const items = pack.items || [];
  const byWork = new Map();
  for (const item of items) {
    const p = item.project || {};
    const workId = p.workId || p.id || item.key;
    if (!byWork.has(workId)) byWork.set(workId, { workId, title: p.title || '無題', whole: false, materials: false, episodes: [] });
    const row = byWork.get(workId);
    if (item.type === 'project') row.whole = true;
    else if (item.type === 'materials') row.materials = true;
    else if (item.type === 'episode') row.episodes.push(item);
  }
  const works = [...byWork.values()];
  const env = !!pack.environment && Object.keys(pack.environment).some((k) => Object.keys(pack.environment[k] || {}).length);
  const novel = items.length > 0;
  let scope = pack.meta?.scope || null;
  if (!scope && novel) {
    if (pack.legacy || (works.length > 1 && works.every((w) => w.whole))) scope = 'all';
    else if (works.every((w) => w.whole)) scope = 'project';
    else if (works.every((w) => !w.whole && !w.episodes.length)) scope = 'materials';
    else if (works.length === 1 && !works[0].whole && !works[0].materials) scope = 'episodes';
    else scope = 'targets';
  }
  return {
    content: env && novel ? 'both' : env ? 'environment' : novel ? 'novel' : 'none',
    scope,
    projects: works.map((w) => ({ workId: w.workId, title: w.title })),
    episodes: works.flatMap((w) => w.episodes.map((e) => ({ workId: w.workId, id: e.episode?.id || '', no: episodeNo(e), title: e.episode?.title || episodeTitle(e.episode) }))),
    auto: /^auto/.test(pack.reason || ''),
    works,
  };
}

const SCOPE_LABEL = { all: '全作品', project: '作品全体', materials: '作品資料', episodes: 'エピソード', targets: 'エピソード', custom: '作品資料・エピソード' };

/** 一覧に出す内容。分からないところは「不明」 */
export function describePack(pack) {
  const m = packMeta(pack);
  const one = m.works.length === 1 ? m.works[0] : null;
  const allEpisodes = m.works.flatMap((w) => w.episodes);
  return {
    // 前の形式（全体バックアップ）は、自動バックアップでも手動の保存でも同じ形なので見分けられない
    kind: !pack.reason || pack.reason === 'legacy-full' ? '不明' : m.auto ? '自動' : '手動',
    environment: m.content === 'environment' || m.content === 'both' ? 'あり' : 'なし',
    novel: m.content === 'novel' || m.content === 'both' ? 'あり' : 'なし',
    scope: m.content === 'environment' ? '—' : (SCOPE_LABEL[m.scope] || '不明'),
    project: !m.works.length ? '—' : m.scope === 'all' ? `${(pack.items || []).filter((x) => x.type === 'project').length || m.works.length}作品` : one ? one.title : `${m.works.length}作品（${m.works.map((w) => w.title).join('、')}）`,
    episode: !allEpisodes.length ? '—' : one ? episodesLabel(allEpisodes) : `${allEpisodes.length}話`,
    device: pack.device?.prefix ? String(pack.device.prefix).replace(/_+$/, '') : '不明',
    createdAt: pack.createdAt || null,
    meta: m,
  };
}

// 名前に入れる「対象」と「範囲」：小説全作品／小説作品_作品名／小説作品資料_作品名／小説話_作品名_第126話、環境は「環境」「環境＋…」
export function packLabel(pack) {
  const m = packMeta(pack);
  const title = (w) => safePart(w?.title || '無題', 24);
  let novel = '';
  if (m.content === 'novel' || m.content === 'both') {
    const one = m.works.length === 1 ? m.works[0] : null;
    const eps = m.works.flatMap((w) => w.episodes);
    if (m.scope === 'all') novel = '小説全作品';
    else if (m.scope === 'project') novel = one ? `小説作品_${title(one)}` : `小説作品_${m.works.length}作品`;
    else if (m.scope === 'materials' || (one && !eps.length)) novel = one ? `小説作品資料_${title(one)}` : `小説作品資料_${m.works.length}作品`;
    else novel = one ? `小説話_${title(one)}_${episodesLabel(eps)}` : `小説話_${m.works.length}作品${eps.length}話`;
  }
  if (m.content === 'environment') return '環境';
  if (m.content === 'both') return `環境＋${novel}`;
  return novel || '空';
}

/**
 * パックのファイル名：[対象]_[範囲]_[日時].json（例：小説話_星の庭_第126話_20261030-073000.json）
 * device を渡したとき（自動バックアップの共有フォルダ）は、どの端末のものか一覧で分かるよう「@端末名」を日時の前に付ける
 */
export function packFileName(pack, { device = '' } = {}) {
  const who = safePart(String(device || '').replace(/_+$/, ''), 20);
  return `${packLabel(pack)}${who ? '@' + who : ''}_${fileStamp(pack.createdAt || new Date())}.json`;
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

/**
 * 読み込んだ稿・履歴を入れる。この端末の稿・履歴・復元ポイントは消さない（同じ ID のものだけ読み込んだ側にする）。
 * この端末にしかない稿が、読み込んだ稿と同じサイト・同じ名前（第N稿）なら、区別できるよう「（この端末）」を付ける。
 * episodeId を渡したときは、そのエピソードの稿だけを名前の確認の対象にする。
 */
async function putVersionsKeepingLocal(localProjectId, remote, episodeId = null) {
  const remoteIds = new Set(remote.map((v) => v.id));
  const names = new Set(remote.filter((v) => v.kind === 'episode' && v.site).map((v) => `${v.episodeId}|${v.site}|${v.name}`));
  for (const v of await versions.list(localProjectId)) {
    if (remoteIds.has(v.id) || v.kind !== 'episode' || !v.site) continue;
    if (episodeId && v.episodeId !== episodeId) continue;
    if (names.has(`${v.episodeId}|${v.site}|${v.name}`)) await versions.put({ ...v, name: `${v.name}（この端末）` });
  }
  for (const v of remote) await versions.put(v);
}

// 作品資料（章・あらすじ・全体プロット・世界観・登場人物・メモ）が変わったかを見分ける印。日時は含めない
function signatureOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${s.length}-${h.toString(16)}`;
}

export function materialsSignature(p) {
  const { createdAt, updatedAt, ...rest } = projectMaterials(p);
  return signatureOf(JSON.stringify(rest));
}

// 環境設定が前に保存したときから変わったかを見るための印（バックアップパックの初期表示用）。
// 開いていたエピソード・最後に開いたフォルダなど、使っているだけで変わる記録は除く
const ENV_NOISE = /^(ep:|seeded:)|lastFolder$/;
export function environmentSignature() {
  const shared = withoutClientIds(sharedPrefs(prefs.entries()));
  const keys = Object.keys(shared).filter((k) => !ENV_NOISE.test(k)).sort();
  return signatureOf(JSON.stringify(keys.map((k) => [k, shared[k]])));
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
  const environmentResult = pack.environment && use('environment') ? applyEnvironment(pack.environment, environmentMode) : null;
  const locals = await db.all();
  const byWork = new Map(locals.map((p) => [p.workId, normalize(p)]));
  const created = new Map();
  const result = { addedList: [], updatedList: [], keptList: [], environmentResult };

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
      // この端末の稿・変更履歴・復元ポイントは消さずに残す
      if (existing) await putVersionsKeepingLocal(localId, versionValues);
      else for (const v of versionValues) await versions.put(v);
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
        // この端末のこのエピソードの稿は消さない（下で、読み込んだ稿を足す）
        target.episodes[index] = srcEp;
      } else if (target.episodes.length === 1 && !target.episodes[0].plot && !target.episodes[0].freeMemo
        && Object.values(target.episodes[0].drafts || {}).every((d) => !d.title && !d.body && !d.foreword && !d.afterword)) {
        target.episodes[0] = srcEp;
      } else target.episodes.splice(Math.min(item.order ?? target.episodes.length, target.episodes.length), 0, srcEp);
      const remapped = remapVersions(item.versions || [], target.id, asNew ? null : new Map((item.versions || []).map((v) => [v.id, v.id])));
      if (asNew) remapEditionIds({ episodes: [srcEp] }, remapped.map);
      if (existedBefore && !asNew) await putVersionsKeepingLocal(target.id, remapped.values, srcEp.id);
      else for (const v of remapped.values) await versions.put(v);
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
export const EPISODE_VERSION = 1;

export function makeEpisodeFile(ep, workTitle = '') {
  return JSON.stringify({
    format: EPISODE_FORMAT,
    version: EPISODE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    workTitle,
    episode: { drafts: ep.drafts, plot: ep.plot ?? '', freeMemo: ep.freeMemo ?? '' },
  }, null, 1);
}

export function isEpisodeFile(text) {
  return fileFormat(text) === EPISODE_FORMAT;
}

export function parseEpisodeFile(text) {
  const o = JSON.parse(text);
  if (o?.format !== EPISODE_FORMAT || !o.episode?.drafts) throw new Error('エピソードのファイルではありません');
  checkNotTooNew(o, 'エピソードのファイル', EPISODE_VERSION);
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
