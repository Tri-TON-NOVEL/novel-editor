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

const DEVICE_PREFS = /^(sync\.|file\.|cloud\.|gdrive\.(folder|known)$|onedrive\.folder$|autoBackup|lastAutoBackupAt$|lastBackupAt$|restoredMessage$|restoredReport$|currentId$|settingsTab$|split$|plotMemoSplit$|sidebarWidth$|iphone\.|android\.|fold\.)/;
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

// 稿・履歴のブロックの見出し。版の種類は versionKind に入れる（kind はブロックの種類 'version' で、上書きしない）
function blockMeta(v) {
  return {
    versionId: v.id, versionKind: v.kind || '', episodeId: v.episodeId || '', site: v.site || '',
    name: v.name || '', createdAt: v.createdAt || '', updatedAt: v.updatedAt || '',
  };
}

// 作品全体の復元ポイント（その時点の作品まるごとのコピー）。バックアップには入れず、読み込みでも持ってこない
// （app.js の isEpisodeVersion と同じ分け方：稿でないものは、作品全体の復元ポイント）
export const isRestorePoint = (v) => !['episode', 'episode-legacy'].includes(v?.kind);

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
    blocks.push({ ...metaInfo, id, kind, itemKey, offset: dataOffset, size: zipped.blob.size, rawSize: bytes.byteLength, codec: zipped.codec, crc32: crc32(bytes) });
    blockBlobs.push(zipped.blob);
    dataOffset += zipped.blob.size;
    return id;
  };

  let environment = null;
  if (plan.environment) {
    const payload = environmentPayload();
    environment = { blockId: await addBlock('environment', 'environment', payload), summary: environmentSummary(payload) };
  }

  // 稿だけを少しずつ読む（作品全体の復元ポイントは読まない。iPhone で、一緒に読むとメモリが足りず落ちていた）
  const addVersions = async (p, item, accept = () => true) => {
    const added = new Map(); // 稿の id → エピソードの id
    for (let after = null; ;) {
      const page = await versions.pageEditions(p.id, after, 25);
      for (const v of page) {
        if (!accept(v)) continue;
        const id = await addBlock('version', item.key, v, blockMeta(v));
        item.blockIds.push(id);
        item.summary.versionCount++;
        added.set(v.id, v.episodeId);
      }
      if (page.length < 25) break;
      after = page.at(-1);
    }
    return added;
  };

  // エピソードの「今の稿」が、この作品のこのエピソードの稿として見つからなかったもの（別の作品・別の話から写したエピソードなど）も入れる。
  // 入れないと、読み込んだ端末で今の稿が見つからず、新しい番号の稿が作られていた。
  // 元の稿（ほかの作品のもの）を読み込みで書き換えないよう、この作品用の別の id にして入れ、エピソードもその id を指すようにする
  const withStrayEditions = async (p, ep, item, added) => {
    let out = ep;
    for (const [site, id] of Object.entries(ep.editionIds || {})) {
      if (!id || added.get(id) === ep.id) continue;
      const v = await versions.get(id);
      if (!v || isRestorePoint(v)) continue;
      const fixed = { ...v, id: `${id}@${p.id}:${ep.id}`, projectId: p.id, episodeId: ep.id, site: v.site || site };
      item.blockIds.push(await addBlock('version', item.key, fixed, blockMeta(fixed)));
      item.summary.versionCount++;
      added.set(fixed.id, ep.id);
      out = { ...out, editionIds: { ...out.editionIds, [site]: fixed.id } };
    }
    return out;
  };

  const addWhole = async (p) => {
    const item = {
      key: `project:${p.workId}`, type: 'project', project: identity(p), blockIds: [],
      summary: { episodeCount: p.episodes.length, versionCount: 0 },
    };
    const base = { ...p, episodes: [] };
    item.blockIds.push(await addBlock('project', item.key, base));
    // 作品全体の復元ポイント（作品まるごとのコピー）は入れない。稿だけを入れる
    const added = await addVersions(p, item);
    for (let order = 0; order < p.episodes.length; order++) {
      const ep = await withStrayEditions(p, p.episodes[order], item, added);
      item.blockIds.push(await addBlock('episode', item.key, ep, { episodeId: ep.id, order, title: epTitle(ep) }));
    }
    items.push(item);
  };

  const addMaterials = async (p) => {
    const item = { key: `materials:${p.workId}`, type: 'materials', project: identity(p), blockIds: [], summary: {} };
    item.blockIds.push(await addBlock('materials', item.key, projectMaterials(p)));
    items.push(item);
  };

  const addEpisodes = async (p, ids) => {
    const wanted = new Set(ids || []);
    if (!p.episodes.some((ep) => wanted.has(ep.id))) return;
    // 選んだエピソードの稿だけを、作品の稿をひと通り読んで集める（エピソードごとに作品の稿を読み直さない）
    const editions = new Map();
    for (let after = null; ;) {
      const page = await versions.pageEditions(p.id, after, 50);
      for (const v of page) if (wanted.has(v.episodeId)) editions.set(v.episodeId, [...(editions.get(v.episodeId) || []), v]);
      if (page.length < 50) break;
      after = page.at(-1);
    }
    for (let order = 0; order < p.episodes.length; order++) {
      const ep = p.episodes[order];
      if (!wanted.has(ep.id)) continue;
      const chapter = p.chapters.find((c) => c.id === ep.chapterId) || null;
      const item = {
        key: `episode:${p.workId}:${ep.id}`, type: 'episode', project: identity(p),
        chapter, order, episode: episodeBrief(ep), blockIds: [], summary: { versionCount: 0 },
      };
      const added = new Map(); // 稿の id → エピソードの id
      for (const v of editions.get(ep.id) || []) {
        item.blockIds.push(await addBlock('version', item.key, v, blockMeta(v)));
        item.summary.versionCount++;
        added.set(v.id, v.episodeId);
      }
      editions.delete(ep.id);
      const saved = await withStrayEditions(p, ep, item, added);
      item.blockIds.push(await addBlock('episode', item.key, saved, { episodeId: ep.id, order, title: epTitle(ep) }));
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
  // 稿の件数は、読み込む分だけを数え直す（前の版のファイルには、作品全体の復元ポイントも入っている）
  const editions = new Map();
  for (const b of index.blocks || []) if (isEditionBlock(b)) editions.set(b.itemKey, (editions.get(b.itemKey) || 0) + 1);
  const summaryOf = (item) => (item.summary && 'versionCount' in item.summary ? { ...item.summary, versionCount: editions.get(item.key) || 0 } : item.summary || {});
  return {
    format: ARCHIVE_FORMAT, version: index.version, schemaVersion: index.schemaVersion,
    createdAt: index.createdAt, appVersion: index.appVersion, reason: index.reason,
    device: index.device, meta: { scope: index.scope },
    environment: index.environment ? { archiveSummary: index.environment.summary || [], present: true } : null,
    items: (index.items || []).map((item) => ({
      key: item.key, type: item.type, project: item.project, chapter: item.chapter,
      order: item.order, episode: item.episode, summary: summaryOf(item),
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

/** 新しい形式（.ayabackup）か。先頭の数バイトだけ読んで見分ける（前の版の .json なら false） */
export async function isArchiveSource(source) {
  const head = decoder.decode(asBytes(await source.readRange(0, MAGIC.length)));
  return head === MAGIC;
}

/**
 * 復元のとき、ブロックを一つずつ通信で取りに行くと、数千回の通信になる（OneDrive は1回に2往復）。
 * 先の部分までまとめて読んでおき、続くブロックはそこから渡す（ブロックはファイルの中で項目の順に並んでいる）。
 */
export function bufferedSource(source, windowBytes = 8 * 1024 * 1024) {
  let cache = null; // { start, bytes }
  return {
    size: source.size,
    async readRange(start, end) {
      if (cache && start >= cache.start && end <= cache.start + cache.bytes.byteLength) {
        return cache.bytes.slice(start - cache.start, end - cache.start);
      }
      let to = Math.max(end, start + windowBytes);
      if (source.size) to = Math.min(to, Math.max(end, source.size));
      const bytes = asBytes(await source.readRange(start, to));
      cache = { start, bytes };
      return bytes.slice(0, end - start);
    },
  };
}

// 0.51 の最初の版で作ったファイルでは、稿・履歴のブロックの kind が版の種類（'episode' など）で上書きされている。
// versionId があれば稿・履歴として扱う（そのファイルも正しく戻せるように）
const isVersionBlock = (b) => b.kind === 'version' || !!b.versionId;
const blockKind = (b) => (isVersionBlock(b) ? 'version' : b.kind);
const versionKindOf = (b) => b.versionKind ?? (b.kind === 'version' ? '' : b.kind);
// 読み込む稿のブロック（前の版で作ったファイルに入っている、作品全体の復元ポイントは飛ばす）
const isEditionBlock = (b) => isVersionBlock(b) && !isRestorePoint({ kind: versionKindOf(b) });

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
  if (!archive.blockMap) archive.blockMap = new Map(archive.index.blocks.map((b) => [b.id, b]));
  const block = typeof blockOrId === 'string' ? archive.blockMap.get(blockOrId) : blockOrId;
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

// 上書きするときは、この端末の稿（その作品、またはその話の分）を消して、バックアップの稿にそっくり入れ替える。
// 消す前の状態は、読み込む前に「同期の前の状態」として端末全体を残している（app.js の protectBeforeRestore）
async function restoreVersions(archive, item, localProjectId, { remap = null, existing = false, episodeId = null } = {}) {
  const blocks = blocksOf(archive, item).filter(isEditionBlock);
  if (existing) await versions.removeEditions(localProjectId, episodeId);
  for (const block of blocks) {
    const v = await readArchiveBlock(archive, block);
    v.projectId = localProjectId;
    if (remap) v.id = remap.get(v.id) || v.id;
    await versions.put(v);
  }
}

// 項目のブロック（ファイルの中の順）
function blocksOf(archive, item) {
  if (!archive.blockMap) archive.blockMap = new Map(archive.index.blocks.map((b) => [b.id, b]));
  return (item.blockIds || []).map((id) => archive.blockMap.get(id)).filter(Boolean);
}

/** 選択した項目を、ブロック単位で読みながら復元する。 */
export async function restoreArchive(opened, { selected = null, asNew = false, environmentMode = 'merge' } = {}) {
  const archive = { ...opened, source: bufferedSource(opened.source) };
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
    const itemBlocks = blocksOf(archive, item);
    const versionBlocks = itemBlocks.filter(isEditionBlock);

    if (item.type === 'project') {
      const baseBlock = itemBlocks.find((b) => blockKind(b) === 'project');
      if (!baseBlock) throw new ArchiveFormatError('作品データがありません');
      const src = normalize(await readArchiveBlock(archive, baseBlock));
      src.episodes = [];
      for (const block of itemBlocks.filter((b) => blockKind(b) === 'episode').sort((a, b) => a.order - b.order)) src.episodes.push(await readArchiveBlock(archive, block));
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

    const { target } = targetFor(item.project || {});
    // この読み込みで新しく作った作品は「この端末にあった作品」として扱わない（restorePack と同じ）
    const existing = locals.some((p) => p.id === target.id);
    if (item.type === 'materials') {
      const block = itemBlocks.find((b) => blockKind(b) === 'materials');
      if (!block) throw new ArchiveFormatError('作品資料のデータがありません');
      const data = await readArchiveBlock(archive, block);
      Object.assign(target, data, { id: target.id, workId: target.workId, links: target.links || {}, episodes: target.episodes });
    } else if (item.type === 'episode') {
      const block = itemBlocks.find((b) => blockKind(b) === 'episode');
      if (!block) throw new ArchiveFormatError('エピソードのデータがありません');
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
