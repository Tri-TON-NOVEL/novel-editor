// 全体バックアップ：端末内のすべての作品・ひな型・設定を1つのファイルにまとめる
import { db, prefs, versions } from './db.js';
import { normalize } from './format.js';

export const BACKUP_FORMAT = 'novel-editor-backup';

export async function makeBackup() {
  const projects = await db.all();
  const allVersions = await versions.all();
  return {
    text: JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: new Date().toISOString(),
      projects,
      versions: allVersions,
      prefs: prefs.entries(),
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
  const saved = backup.prefs || {};
  for (const [key, value] of Object.entries(saved)) {
    if (key === 'templates' && mode === 'merge') {
      // ひな型は、端末にあるものとまとめる（同じものはバックアップ側を使う）
      const mine = prefs.get('templates', []) || [];
      const ids = new Set(value.map((t) => t.id));
      prefs.set('templates', [...value, ...mine.filter((t) => !ids.has(t.id))]);
    } else {
      prefs.set(key, value);
    }
  }
  return backup.projects.length;
}

export function backupFileName() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `小説エディター_バックアップ_${ymd}.json`;
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
