// TXT インポート用の小さな ZIP 読み取り処理。
// ZIP を端末内で解析し、選んだ TXT だけをメモリ上へ展開する。

export class ZipError extends Error {}

const MAX_ENTRIES = 2000;
const MAX_TEXT_SIZE = 50 * 1024 * 1024;
const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function viewOf(buffer) {
  if (buffer instanceof ArrayBuffer) return new DataView(buffer);
  if (ArrayBuffer.isView(buffer)) return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new ZipError('ZIPデータを読み取れません。');
}

function bytesOf(buffer) {
  return buffer instanceof Uint8Array
    ? buffer
    : buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function decodeName(bytes, utf8) {
  if (utf8) return new TextDecoder('utf-8').decode(bytes);
  // UTF-8 フラグがない ZIP は、Windows で作られた日本語名（CP932）が多い。
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('shift_jis').decode(bytes); }
}

function findEnd(view) {
  const first = Math.max(0, view.byteLength - 65557); // EOCD + 最大コメント長
  for (let p = view.byteLength - 22; p >= first; p--) {
    if (view.getUint32(p, true) === EOCD) return p;
  }
  throw new ZipError('ZIPの終端情報が見つかりません。壊れたZIPの可能性があります。');
}

export function listZipTextEntries(buffer) {
  const view = viewOf(buffer);
  const all = bytesOf(buffer);
  if (view.byteLength < 22) throw new ZipError('ZIPファイルが短すぎます。');
  const end = findEnd(view);
  const disk = view.getUint16(end + 4, true);
  const centralDisk = view.getUint16(end + 6, true);
  const count = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (disk || centralDisk) throw new ZipError('複数ファイルに分割されたZIPには対応していません。');
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ZipError('ZIP64形式には対応していません。通常のZIPとして作り直してください。');
  }
  if (count > MAX_ENTRIES) throw new ZipError(`ZIP内のファイル数が多すぎます（${MAX_ENTRIES}件まで）。`);
  if (centralOffset + centralSize > view.byteLength) throw new ZipError('ZIPのファイル一覧が壊れています。');

  const entries = [];
  let p = centralOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > view.byteLength || view.getUint32(p, true) !== CENTRAL) {
      throw new ZipError('ZIPのファイル一覧を読み取れません。');
    }
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLength = view.getUint16(p + 28, true);
    const extraLength = view.getUint16(p + 30, true);
    const commentLength = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const next = p + 46 + nameLength + extraLength + commentLength;
    if (next > view.byteLength || p + 46 + nameLength > all.byteLength) throw new ZipError('ZIP内のファイル名を読み取れません。');
    if ([compressedSize, size, localOffset].includes(0xffffffff)) throw new ZipError('ZIP64形式には対応していません。');
    const rawName = all.subarray(p + 46, p + 46 + nameLength);
    const name = decodeName(rawName, !!(flags & 0x0800)).replace(/\\/g, '/').replace(/^\/+/, '');
    const base = name.split('/').pop() || '';
    if (!name.endsWith('/') && !name.startsWith('__MACOSX/') && !base.startsWith('._') && /\.txt$/i.test(name)) {
      entries.push({ name, method, flags, compressedSize, size, localOffset });
    }
    p = next;
  }
  return entries;
}

async function inflateRaw(data) {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipError('このブラウザーはZIPの展開に対応していません。TXTを取り出してから選択してください。');
  }
  try {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    throw new ZipError('ZIP内のTXTを展開できませんでした。ZIPが壊れている可能性があります。');
  }
}

export async function extractZipEntry(buffer, entry) {
  if (!entry) throw new ZipError('ZIP内のTXTが選ばれていません。');
  if (entry.flags & 1) throw new ZipError('パスワード付き・暗号化ZIPには対応していません。');
  if (entry.size > MAX_TEXT_SIZE) throw new ZipError('ZIP内のTXTが大きすぎます（展開後50MBまで）。');
  if (entry.method !== 0 && entry.method !== 8) throw new ZipError(`このZIPの圧縮方式（${entry.method}）には対応していません。`);
  const view = viewOf(buffer);
  const all = bytesOf(buffer);
  const p = entry.localOffset;
  if (p + 30 > view.byteLength || view.getUint32(p, true) !== LOCAL) throw new ZipError('ZIP内のTXTの場所を読み取れません。');
  const nameLength = view.getUint16(p + 26, true);
  const extraLength = view.getUint16(p + 28, true);
  const start = p + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > all.byteLength) throw new ZipError('ZIP内のTXTデータが途中で切れています。');
  const compressed = all.subarray(start, end);
  const result = entry.method === 0 ? compressed.slice() : await inflateRaw(compressed);
  if (result.byteLength !== entry.size) throw new ZipError('ZIP内のTXTのサイズが一致しません。ZIPが壊れている可能性があります。');
  return result.buffer;
}
