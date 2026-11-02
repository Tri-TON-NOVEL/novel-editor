// あや綴り専用バックアップ形式。
// 利用者からは一つの .ayabackup ファイルだが、内部は索引＋項目ごとの gzip ブロック。
// 巨大なJSON全体を file.text() / JSON.parse() せず、必要なブロックだけ順番に読む。
import { db, meta, prefs, versions } from './db.js';
import { normalize, newProject, makeId, draftOf, SCHEMA_VERSION } from './format.js';
import { applyEnvironment, environmentSummary } from './backup.js';

export const ARCHIVE_FORMAT = 'ayatuzuri-block-backup';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_EXT = '.ayabackup';
export const ARCHIVE_MIME = 'application/x-ayatuzuri-backup';
const MAGIC = 'AYATUZURI-BACKUP\n';
const INDEX_HEX = 16;
export const ARCHIVE_HEADER_BYTES = MAGIC.length + INDEX_HEX + 1;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ArchiveFormatError extends Error {
  constructor(message) { super(message); this.name = 'ArchiveFormatError'; }
}

const DEVICE_PREFS = /^(sync\.|file\.|cloud\.|gdrive\.(folder|known)$|onedrive\.folder$|autoBackup|lastAutoBackupAt$|lastBackupAt$|restoredMessage$|restoredReport$|currentId$|settingsTab$|split$|plotMemoSplit$|sidebarWidth$|iphone\.|fold\.)/;
const PORTABLE_DEVICE_PREFS = /^(file\.destination$|autoBackupInterval$|autoBackupKeep$|split$|plotMemoSplit$|sidebarWidth$|iphone\.)/;
const CLOUD_PREFS = /^(cloud\.provider|gdrive\.(folder|backupFolder)|onedrive\.(folder|backupFolder)|sync\.mode)$/;
const DISPLAY_DEVICE_PREFS = /^fold\./;
const CLIENT_ID_PREFS = ['gdrive.clientId', 'onedrive.clientId'];
const sharedPrefs = (entries) => Object.fromEntries(Object.entries(entries || {}).filter(([k]) => !DEVICE_PREFS.test(k)));
const portableDevicePrefs = (entries) => Object.fromEntries(Object.entries(entries || {}).filter(([k]) => DEVICE_PREFS.test(k) && PORTABLE_DEVICE_PREFS.test(k)));
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

function identity(p) { return { id: p.id, workId: p.workId, title: p.title || '無題', createdAt: p.createdAt, updatedAt: p.updatedAt }; }
function epTitle(ep) { return draftOf(ep, 'narou').title || draftOf(ep, 'alpha').title || ''; }
function episodeBrief(ep) {
  return {
    id: ep.id,
    chapterId: ep.chapterId || null,
    drafts: {
      narou: { title: draftOf(ep, 'narou').title || '' },
      alpha: { title: draftOf(ep, 'alpha').title || '' },
    },
  };
}
function projectMaterials(p) {
  const n = normalize(p);
  return {
    title: n.title, site: n.site, narouUrl: n.narouUrl, alphaUrl: n.alphaUrl,
    narouNcode: n.narouNcode, alphaWorkId: n.alphaWorkId, synopsis: n.synopsis,
    projectMemo: n.projectMemo || '', chapters: n.chapters, world: n.world,
    characters: n.characters, createdAt: n.createdAt, updatedAt: n.updatedAt,
  };
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

async function compress(bytes) {
  if (!globalThis.CompressionStream) return { codec: 'store', blob: new Blob([bytes]) };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return { codec: 'gzip', blob: await new Response(stream).blob() };
}

async function decompress(bytes, codec) {
  if (codec === 'store') return bytes;
  if (codec !== 'gzip') throw new ArchiveFormatError(`未対応の圧縮方式です（${codec}）`);
  if (!globalThis.DecompressionStream) throw new ArchiveFormatError('このブラウザーはgzipの展開に対応していません');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function blockMeta(v) {
  return {
    versionId: v.id, kind: v.kind || '', episodeId: v.episodeId || '', site: v.site || '',
    name: v.name || '', createdAt: v.createdAt || '', updatedAt: v.updatedAt || '',
  };
}

/** plan は従来の makePack と同じ。戻り値は { blob, pack, index, itemCount }。 */
export async function makeArchive(plan = {}) {
  let rawProjects;
  if (plan.scope === 'all') rawProjects = await db.all();
  else if (plan.scope === 'targets' && (plan.targets || []).every((t) => t.projectId)) {
    rawProjects = (await Promise.all([...new Set(plan.targets.map((t) => t.projectId))].map((id) => db.get(id)))).filter(Boolean);
  } else if (plan.projectId) {
    const one = await db.get(plan.projectId);
    rawProjects = one ? [one] : [];
  } else rawProjects = await db.all();
  const projects = rawProjects.map(normalize);
  const createdAt = new Date().toISOString();
  const blocks = [];
  const blockBlobs = [];
  const items = [];
  let dataOffset = 0;
  let nextBlock = 1;

  const addBlock = async (kind, itemKey, value, metaInfo = {}) => {
    const bytes = encoder.encode(JSON.stringify(value));
    const zipped = await compress(bytes);
    const id = `b${nextBlock++}`;
    blocks.push({ id, kind, itemKey, offset: dataOffset, size: zipped.blob.size, rawSize: bytes.byteLength, codec: zipped.codec, crc32: crc32(bytes), ...metaInfo });
    blockBlobs.push(zipped.blob);
    dataOffset += zipped.blob.size;
    return id;
  };

  let environment = null;
  if (plan.environment) {
    const payload = environmentPayload();
    environment = { blockId: await addBlock('environment', 'environment', payload), summary: environmentSummary(payload) };
  }

  const addVersions = async (p, item, accept = () => true) => {
    for (let after = null; ;) {
      const page = await versions.pageProject(p.id, after, 25);
      for (const v of page) {
        if (!accept(v)) continue;
        const id = await addBlock('version', item.key, v, blockMeta(v));
        item.blockIds.push(id);
        item.summary.versionCount++;
      }
      if (page.length < 25) break;
      after = page.at(-1).id;
    }
  };

  const addWhole = async (p) => {
    const item = {
      key: `project:${p.workId}`, type: 'project', project: identity(p), blockIds: [],
      summary: { episodeCount: p.episodes.length, versionCount: 0 },
    };
    const base = { ...p, episodes: [] };
    item.blockIds.push(await addBlock('project', item.key, base));
    for (let order = 0; order < p.episodes.length; order++) {
      const ep = p.episodes[order];
      item.blockIds.push(await addBlock('episode', item.key, ep, { episodeId: ep.id, order, title: epTitle(ep) }));
    }
    await addVersions(p, item);
    items.push(item);
  };

  const addMaterials = async (p) => {
    const item = { key: `materials:${p.workId}`, type: 'materials', project: identity(p), blockIds: [], summary: {} };
    item.blockIds.push(await addBlock('materials', item.key, projectMaterials(p)));
    items.push(item);
  };

  const addEpisodes = async (p, ids) => {
    const wanted = new Set(ids || []);
    for (let order = 0; order < p.episodes.length; order++) {
      const ep = p.episodes[order];
      if (!wanted.has(ep.id)) continue;
      const chapter = p.chapters.find((c) => c.id === ep.chapterId) || null;
      const item = {
        key: `episode:${p.workId}:${ep.id}`, type: 'episode', project: identity(p),
        chapter, order, episode: episodeBrief(ep), blockIds: [], summary: { versionCount: 0 },
      };
      item.blockIds.push(await addBlock('episode', item.key, ep, { episodeId: ep.id, order, title: epTitle(ep) }));
      await addVersions(p, item, (v) => v.episodeId === ep.id);
      items.push(item);
    }
  };

  if (plan.scope === 'all') for (const p of projects) await addWhole(p);
  if (plan.scope === 'project') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) await addWhole(p);
  }
  if (plan.scope === 'materials') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) await addMaterials(p);
  }
  if (plan.scope === 'episodes') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) await addEpisodes(p, plan.episodeIds);
  }
  if (plan.scope === 'custom') {
    const p = projects.find((x) => x.id === plan.projectId);
    if (p) {
      if (plan.materials) await addMaterials(p);
      await addEpisodes(p, plan.episodeIds);
    }
  }
  if (plan.scope === 'targets') {
    for (const target of plan.targets || []) {
      const p = projects.find((x) => x.id === target.projectId || x.workId === target.workId);
      if (!p) continue;
      if (target.materials) await addMaterials(p);
      await addEpisodes(p, target.episodeIds);
    }
  }
  if (!environment && !items.length) throw new Error('保存する内容が選ばれていません');

  const index = {
    format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, schemaVersion: SCHEMA_VERSION,
    createdAt, appVersion: plan.appVersion || '', reason: plan.reason || 'manual-pack',
    device: plan.device || null, scope: items.length ? (plan.scope || null) : null,
    environment, items, blocks,
  };
  const indexBytes = encoder.encode(JSON.stringify(index));
  if (indexBytes.byteLength > MAX_INDEX_BYTES) throw new Error('バックアップの索引が大きすぎます');
  const header = `${MAGIC}${indexBytes.byteLength.toString(16).padStart(INDEX_HEX, '0')}\n`;
  const blob = new Blob([header, indexBytes, ...blockBlobs], { type: ARCHIVE_MIME });
  projects.length = 0;
  return { blob, index, pack: packFromArchive(index), itemCount: items.length };
}

export function packFromArchive(index) {
  return {
    format: ARCHIVE_FORMAT, version: index.version, schemaVersion: index.schemaVersion,
    createdAt: index.createdAt, appVersion: index.appVersion, reason: index.reason,
    device: index.device, meta: { scope: index.scope },
    environment: index.environment ? { archiveSummary: index.environment.summary || [], present: true } : null,
    items: (index.items || []).map((item) => ({
      key: item.key, type: item.type, project: item.project, chapter: item.chapter,
      order: item.order, episode: item.episode, summary: item.summary || {},
    })),
  };
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new ArchiveFormatError('バックアップをバイト列として読めませんでした');
}

export function archiveSourceFromBlob(blob) {
  return {
    size: blob.size,
    async readRange(start, end) { return blob.slice(start, end).arrayBuffer(); },
  };
}

export async function openArchive(source) {
  if (!source?.readRange) throw new ArchiveFormatError('バックアップの読み込み元がありません');
  const headBytes = asBytes(await source.readRange(0, ARCHIVE_HEADER_BYTES));
  const head = decoder.decode(headBytes);
  if (!head.startsWith(MAGIC)) throw new ArchiveFormatError('あや綴りの新しいバックアップ形式ではありません');
  const sizeText = head.slice(MAGIC.length, MAGIC.length + INDEX_HEX);
  const indexSize = Number.parseInt(sizeText, 16);
  if (!Number.isSafeInteger(indexSize) || indexSize <= 0 || indexSize > MAX_INDEX_BYTES) throw new ArchiveFormatError('バックアップの索引サイズが不正です');
  const indexBytes = asBytes(await source.readRange(ARCHIVE_HEADER_BYTES, ARCHIVE_HEADER_BYTES + indexSize));
  if (indexBytes.byteLength !== indexSize) throw new ArchiveFormatError('バックアップの索引が途中で切れています');
  let index;
  try { index = JSON.parse(decoder.decode(indexBytes)); }
  catch (e) { throw new ArchiveFormatError(`バックアップの索引を読めませんでした（${e.message}）`); }
  if (index?.format !== ARCHIVE_FORMAT || !Array.isArray(index.blocks) || !Array.isArray(index.items)) throw new ArchiveFormatError('あや綴りのバックアップではありません');
  if (Number(index.version || 1) > ARCHIVE_VERSION) throw new ArchiveFormatError(`新しい版のバックアップ形式です（v${index.version}）`);
  if (Number(index.schemaVersion || 3) > SCHEMA_VERSION) throw new ArchiveFormatError(`新しい版の作品データです（v${index.schemaVersion}）`);
  return { source, index, indexSize, pack: packFromArchive(index) };
}

export async function readArchiveBlock(archive, blockOrId) {
  const block = typeof blockOrId === 'string' ? archive.index.blocks.find((b) => b.id === blockOrId) : blockOrId;
  if (!block) throw new ArchiveFormatError('バックアップ内のデータが見つかりません');
  const dataStart = ARCHIVE_HEADER_BYTES + archive.indexSize;
  const stored = asBytes(await archive.source.readRange(dataStart + block.offset, dataStart + block.offset + block.size));
  if (stored.byteLength !== block.size) throw new ArchiveFormatError('バックアップ内のデータが途中で切れています');
  const raw = await decompress(stored, block.codec);
  if (raw.byteLength !== block.rawSize || crc32(raw) !== block.crc32) throw new ArchiveFormatError('バックアップ内のデータが破損しています');
  try { return JSON.parse(decoder.decode(raw)); }
  catch (e) { throw new ArchiveFormatError(`バックアップ内のデータを読めませんでした（${e.message}）`); }
}

function remapEditionIds(holder, map) {
  for (const ep of holder.episodes || []) {
    if (!ep.editionIds) continue;
    ep.editionIds = Object.fromEntries(Object.entries(ep.editionIds).map(([site, id]) => [site, map.get(id) || id]));
  }
}

async function preserveLocalVersionNames(localProjectId, versionBlocks, episodeId = null) {
  const remoteIds = new Set(versionBlocks.map((b) => b.versionId));
  const names = new Set(versionBlocks.filter((b) => b.kind === 'episode' && b.site).map((b) => `${b.episodeId}|${b.site}|${b.name}`));
  for (let after = null; ;) {
    const page = await versions.pageProject(localProjectId, after, 25);
    for (const v of page) {
      if (remoteIds.has(v.id) || v.kind !== 'episode' || !v.site) continue;
      if (episodeId && v.episodeId !== episodeId) continue;
      if (names.has(`${v.episodeId}|${v.site}|${v.name}`)) await versions.put({ ...v, name: `${v.name}（この端末）` });
    }
    if (page.length < 25) break;
    after = page.at(-1).id;
  }
}

async function restoreVersions(archive, item, localProjectId, { remap = null, existing = false, episodeId = null } = {}) {
  const ids = new Set(item.blockIds || []);
  const blocks = archive.index.blocks.filter((b) => ids.has(b.id) && b.kind === 'version');
  if (existing) await preserveLocalVersionNames(localProjectId, blocks, episodeId);
  for (const block of blocks) {
    const v = await readArchiveBlock(archive, block);
    v.projectId = localProjectId;
    if (remap) v.id = remap.get(v.id) || v.id;
    await versions.put(v);
  }
}

/** 選択した項目を、ブロック単位で読みながら復元する。 */
export async function restoreArchive(archive, { selected = null, asNew = false, environmentMode = 'merge' } = {}) {
  const keys = selected ? new Set(selected) : null;
  const use = (key) => !keys || keys.has(key);
  let environmentResult = null;
  if (archive.index.environment && use('environment')) {
    const env = await readArchiveBlock(archive, archive.index.environment.blockId);
    environmentResult = applyEnvironment(env, environmentMode);
  }

  const locals = (await db.all()).map(normalize);
  const byWork = new Map(locals.map((p) => [p.workId, p]));
  const created = new Map();
  const result = { addedList: [], updatedList: [], keptList: [], environmentResult };
  const addResult = (list, p) => { if (!list.some((x) => x.id === p.id)) list.push({ id: p.id, title: p.title || '無題' }); };

  const targetFor = (remote) => {
    const workId = remote.workId || remote.id || makeId();
    if (!asNew && byWork.has(workId)) return { target: byWork.get(workId), existing: true };
    if (created.has(workId)) return { target: created.get(workId), existing: false };
    const p = newProject({ title: asNew ? `${remote.title || '無題'}（バックアップ）` : (remote.title || '無題'), workId: asNew ? makeId() : workId });
    created.set(workId, p);
    addResult(result.addedList, p);
    return { target: p, existing: false };
  };

  for (const item of archive.index.items || []) {
    if (!use(item.key)) continue;
    const ids = new Set(item.blockIds || []);
    const itemBlocks = archive.index.blocks.filter((b) => ids.has(b.id));
    const versionBlocks = itemBlocks.filter((b) => b.kind === 'version');

    if (item.type === 'project') {
      const baseBlock = itemBlocks.find((b) => b.kind === 'project');
      if (!baseBlock) throw new ArchiveFormatError('作品データがありません');
      const src = normalize(await readArchiveBlock(archive, baseBlock));
      src.episodes = [];
      for (const block of itemBlocks.filter((b) => b.kind === 'episode').sort((a, b) => a.order - b.order)) src.episodes.push(await readArchiveBlock(archive, block));
      const existing = !asNew ? byWork.get(src.workId) : null;
      const localId = existing?.id || makeId();
      const idMap = new Map(versionBlocks.map((b) => [b.versionId, (asNew || !existing) ? makeId() : b.versionId]));
      remapEditionIds(src, idMap);
      const restored = normalize({ ...src, id: localId, links: existing?.links || {}, workId: asNew ? makeId() : src.workId });
      await db.put(restored);
      await restoreVersions(archive, item, localId, { remap: idMap, existing: !!existing });
      if (existing) addResult(result.updatedList, restored); else addResult(result.addedList, restored);
      byWork.set(restored.workId, restored);
      continue;
    }

    const { target, existing } = targetFor(item.project || {});
    if (item.type === 'materials') {
      const block = itemBlocks.find((b) => b.kind === 'materials');
      const data = await readArchiveBlock(archive, block);
      Object.assign(target, data, { id: target.id, workId: target.workId, links: target.links || {}, episodes: target.episodes });
    } else if (item.type === 'episode') {
      const block = itemBlocks.find((b) => b.kind === 'episode');
      const ep = await readArchiveBlock(archive, block);
      const idMap = new Map(versionBlocks.map((b) => [b.versionId, (asNew || !existing) ? makeId() : b.versionId]));
      remapEditionIds({ episodes: [ep] }, idMap);
      if (item.chapter && !target.chapters.some((c) => c.id === item.chapter.id)) target.chapters.push(structuredClone(item.chapter));
      const at = target.episodes.findIndex((e) => e.id === ep.id);
      if (at >= 0) target.episodes[at] = ep;
      else if (target.episodes.length === 1 && !target.episodes[0].plot && !target.episodes[0].freeMemo
        && Object.values(target.episodes[0].drafts || {}).every((d) => !d.title && !d.body && !d.foreword && !d.afterword)) target.episodes[0] = ep;
      else target.episodes.splice(Math.min(item.order ?? target.episodes.length, target.episodes.length), 0, ep);
      await restoreVersions(archive, item, target.id, { remap: idMap, existing, episodeId: ep.id });
    }
    target.updatedAt = new Date().toISOString();
    const saved = normalize(target);
    await db.put(saved);
    byWork.set(saved.workId, saved);
    if (existing) addResult(result.updatedList, saved);
  }
  return result;
}

export async function savePreRestoreArchive(from = '', plan = { environment: true, scope: 'all', reason: 'pre-restore' }) {
  try {
    const made = await makeArchive(plan);
    await meta.set('preSyncBackup', { createdAt: made.index.createdAt, from, blob: made.blob, name: `同期の前_${made.index.createdAt.slice(0, 10)}${ARCHIVE_EXT}` });
  } catch (e) {
    console.warn('同期の前の状態を残せませんでした', e);
  }
}

export function archiveEnvironmentSummary(pack) {
  return pack?.environment?.archiveSummary || [];
}
