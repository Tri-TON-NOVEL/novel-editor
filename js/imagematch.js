// メイン → サブにコピーするときの、画像の対応（純粋関数。tests/tests.js でテスト）
//
// コピー先（サブ）の原稿にすでに画像があるとき、コピー元（メイン）の画像と組み合わせる。
//   ・組み合わせた画像は、コピー後の本文でもコピー先の画像の書き方（タグ）をそのまま使う
//   ・組み合わせなかったコピー元の画像は、今までどおり変換した書き方（みてみんの URL・「ここに画像を挿入」の目印）
//   ・組み合わせなかったコピー先の画像も、タグはそのまま残す。すぐ前の行と同じ行をコピー後の本文から探して、その次に入れる
//     （見つからなければ、元の位置と同じくらいの行の次）
//   つまり、コピー先の画像タグはすべてそのまま残り、文章だけが入れ替わる
// 最初の組み合わせは、画像の前後の行がどれだけ似ているかで、順番を崩さずに決める。
import { findImages, convertText } from './notation.js';

const IMAGE_MARK = /【ここに画像を挿入：[^】\n]*】/g;
const CONTEXT_LEN = 40;
const PAIR_MIN = 0.3;   // これより似ていない組は、数が同じときだけ順番どおりに組む
export const PAIR_WEAK = 0.5; // これより低い組には ⚠ を付ける

/** 文章の中の画像（なろうの挿絵タグ・みてみんの URL・アルファの画像タグ・「ここに画像を挿入」の目印）。重なりなし、前から順 */
export function imageSlots(text) {
  if (!text) return [];
  const all = findImages(text).map((i) => ({ index: i.index, end: i.index + i.text.length, text: i.text }));
  for (const m of text.matchAll(IMAGE_MARK)) all.push({ index: m.index, end: m.index + m[0].length, text: m[0] });
  all.sort((a, b) => a.index - b.index || b.end - a.end);
  const out = [];
  for (const s of all) if (!out.length || s.index >= out.at(-1).end) out.push(s);
  return out;
}

/** 読みやすい文字だけにする（ルビ・傍点の記号と画像を外し、前後の空白を取る） */
export function plainLine(s) {
  return String(s || '')
    .replace(/<i\d+\|\d+>|#__i_[0-9A-Za-z]+__#|https?:\/\/\d+\.mitemin\.net\/i\d+\/?|【ここに画像を挿入：[^】\n]*】/g, '')
    .replace(/[|｜]([^|｜《》\n]+?)《[^《》\n]+?》/g, '$1')
    .replace(/#([^#_\n][^#\n]*?)__[^_#\n]+?__#/g, '$1')
    .replace(/《《([^《》\n]+?)》》/g, '$1')
    .replace(/^[\s　]+|[\s　]+$/g, '');
}

// 画像のすぐ前・すぐ後の、空でない行（同じ行に文字があれば、その部分）
function lineBefore(text, index) {
  const lines = text.slice(0, index).split('\n');
  for (let k = lines.length - 1; k >= 0; k--) {
    const p = plainLine(lines[k]);
    if (p) return { plain: p, raw: lines[k], sameLine: k === lines.length - 1 };
  }
  return null;
}
function lineAfter(text, end) {
  for (const l of text.slice(end).split('\n')) {
    const p = plainLine(l);
    if (p) return p;
  }
  return '';
}

/** 画像の前後の文（画像に近いほうから最大40字） */
export function contextOf(text, slot) {
  const b = lineBefore(text, slot.index);
  const before = b ? b.plain : '';
  const after = lineAfter(text, slot.end);
  return {
    before: [...before].slice(-CONTEXT_LEN).join(''),
    after: [...after].slice(0, CONTEXT_LEN).join(''),
    beforeLine: b && !b.sameLine ? b.plain : '', // 入れる場所を探すときに使う（行全体）
    tag: slot.text,
  };
}

const squash = (s) => s.replace(/[\s　「」『』（）()、。・…―ー！？!?]/g, '');
function bigrams(s) {
  const a = [...squash(s)];
  const out = new Map();
  for (let i = 0; i < a.length - 1; i++) { const k = a[i] + a[i + 1]; out.set(k, (out.get(k) || 0) + 1); }
  return { map: out, size: Math.max(0, a.length - 1), raw: a.join('') };
}
/** 2つの文の似ている度合い（0〜1） */
export function similarity(x, y) {
  const a = bigrams(x || ''); const b = bigrams(y || '');
  if (!a.raw && !b.raw) return 0.5; // どちらも何もない（本文の最初・最後など）
  if (a.raw === b.raw) return 1;
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const [k, n] of a.map) hit += Math.min(n, b.map.get(k) || 0);
  return (2 * hit) / (a.size + b.size);
}
export function pairScore(src, dst) {
  return (similarity(src.before, dst.before) + similarity(src.after, dst.after)) / 2;
}

/**
 * 最初の組み合わせ。順番を崩さず、似ている組の合計がいちばん大きくなるように組む。
 * 数が同じときは、似ていない組も順番どおりに組む（書き直して前後の文が変わった場合）。
 * 戻り値：コピー元の画像ごとに、組むコピー先の画像の番号（なければ -1）
 */
export function suggestPairs(src, dst) {
  const n = src.length; const m = dst.length;
  const same = n === m;
  const w = (i, j) => { const s = pairScore(src[i], dst[j]); return s >= PAIR_MIN ? 1 + s : same ? 0.01 : -Infinity; };
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1] + w(i - 1, j - 1));
    }
  }
  const map = new Array(n).fill(-1);
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (dp[i][j] === dp[i - 1][j]) i--;
    else if (dp[i][j] === dp[i][j - 1]) j--;
    else { map[i - 1] = j - 1; i--; j--; }
  }
  return map;
}

/**
 * 組み合わせに従って、コピー後の文章を作る。
 * map：コピー元の画像ごとの、コピー先の画像の番号（-1 は組まない）
 * 戻り値 { text, warnings, placed: [前の行の次に入れたコピー先の番号], approx: [だいたいの位置に入れた番号] }
 */
export function applyImageMap(from, to, srcText, destText, map) {
  const srcSlots = imageSlots(srcText);
  const dstSlots = imageSlots(destText);
  const warnings = [];
  const add = (list) => {
    for (const w of list) {
      const x = warnings.find((y) => y.type === w.type);
      if (x) { x.count += w.count; x.samples.push(...w.samples.slice(0, Math.max(0, 3 - x.samples.length))); } else warnings.push({ ...w, samples: [...w.samples] });
    }
  };
  const conv = (s) => { const r = convertText(from, to, s); add(r.warnings); return r.text; };
  let text = '';
  let pos = 0;
  srcSlots.forEach((s, k) => {
    text += conv(srcText.slice(pos, s.index));
    const j = map[k];
    text += j >= 0 && dstSlots[j] ? dstSlots[j].text : conv(s.text);
    pos = s.end;
  });
  text += conv(srcText.slice(pos));
  // 組まなかったコピー先の画像も、タグはそのまま残す（0.89）。
  //   すぐ前の行と同じ行を探して、その次に入れる（placed）
  //   見つからなければ、元の本文での位置（行の割合）と同じくらいの行の次に入れる（approx）
  const used = new Set(map.filter((j) => j >= 0));
  const placed = []; const approx = [];
  let from0 = 0;
  const destLines = Math.max(1, destText.split('\n').length);
  dstSlots.forEach((d, j) => {
    if (used.has(j)) return;
    const ctx = contextOf(destText, d);
    let at = ctx.beforeLine ? findLineEnd(text, ctx.beforeLine, from0) : -1;
    if (at >= 0) placed.push(j);
    else {
      approx.push(j);
      const lines = text.split('\n');
      const want = Math.round((destText.slice(0, d.index).split('\n').length - 1) / destLines * lines.length);
      if (want <= 0) at = -1; // 先頭
      else at = lines.slice(0, Math.min(want, lines.length)).join('\n').length;
      if (at >= 0 && at < from0) at = Math.min(from0, text.length);
    }
    // 元の行と画像のあいだの改行（空行の数）をまねる
    const lineEnd = destText.lastIndexOf('\n', d.index - 1);
    const gap = lineEnd >= 0 ? destText.slice(lineEnd, d.index) : '\n';
    const sep = /^[\s　]*$/.test(gap) && gap.includes('\n') ? gap : '\n';
    const ins = at < 0 ? d.text + sep : sep + d.text;
    const p = at < 0 ? 0 : at;
    text = text.slice(0, p) + ins + text.slice(p);
    from0 = p + ins.length;
  });
  return { text, warnings, placed, approx };
}

// plain が同じ行を start 以降で探し、その行の終わりの位置を返す（なければ -1）
function findLineEnd(text, plain, start) {
  const want = squash(plain);
  let i = text.lastIndexOf('\n', start - 1) + 1;
  while (i <= text.length) {
    const e = text.indexOf('\n', i);
    const end = e < 0 ? text.length : e;
    if (end >= start && squash(plainLine(text.slice(i, end))) === want) return end;
    if (e < 0) break;
    i = e + 1;
  }
  return -1;
}
