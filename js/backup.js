// 全体バックアップ：端末内のすべての作品・ひな型・設定を1つのファイルにまとめる
import { db, prefs, versions } from './db.js';
import { normalize } from './format.js';

export const BACKUP_FORMAT = 'novel-editor-backup';

// 端末ごとの設定（自動バックアップの記録・保存先・開いている作品など）は、バックアップに入れず、戻すときも使わない。
// 他の端末のバックアップを読み込んだときに、この端末の設定が書き換わらないように。
// 画面の幅・iPhone の高さなど、端末の画面に合わせたものも入れない。
const DEVICE_PREFS = /^(sync\.|file\.|cloud\.|gdrive\.(folder|known)$|autoBackup|lastAutoBackupAt$|lastBackupAt$|restoredMessage$|restoredReport$|currentId$|settingsTab$|split$|sidebarWidth$|iphone\.)/;
const sharedPrefs = (entries) => Object.fromEntries(Object.entries(entries || {}).filter(([k]) => !DEVICE_PREFS.test(k)));

// 端末ごとの設定のうち、「環境」として明示的に読み込むときだけ使うもの（ファイルの保存先の選び方・自動バックアップの間隔と件数・画面の幅など）。
// 自動バックアップの状態・保存先フォルダ・プレフィックス・ログイン・開いている作品などは、端末そのものの記録なので入れない。
const PORTABLE_DEVICE_PREFS = /^(file\.destination$|autoBackupInterval$|autoBackupKeep$|split$|sidebarWidth$|iphone\.)/;
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
  return `小説エディター_全体_${ymd}.json`;
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
