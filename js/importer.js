// TXT 一括インポートの解析（画面とは切り離した純粋関数。tests/tests.js でテスト）
//
// 流れ：読込 → 文字コード判定・デコード → 行に分割 → 区切りの自動検出 → 手動修正 → 章・話へ分割 → 重複判定 → 確定
// 解析の段階では作品データを一切変更しない（確定は画面側 importui.js で行う）。

import { countImages } from './notation.js';

// ---------- 文字コード ----------

export const ENCODINGS = [
  { value: 'auto', label: '自動判定' },
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'shift_jis', label: 'Shift_JIS（CP932）' },
];

function decodeWith(bytes, encoding) {
  const text = new TextDecoder(encoding).decode(bytes);
  let bad = 0;
  const lines = [];
  if (text.includes('�')) {
    text.split(/\r\n|\r|\n/).forEach((l, i) => {
      const n = l.split('�').length - 1;
      if (n) { bad += n; if (lines.length < 5) lines.push(i + 1); }
    });
  }
  return { text, bad, badLines: lines };
}

/**
 * バイト列を文字列にする。encoding が 'auto' なら判定する。
 * @returns {{ text, encoding, bom, confidence: 'high'|'medium'|'low', bad: 置換文字の数, badLines: 先頭5件の行番号, note }}
 */
export function decodeText(buffer, encoding = 'auto') {
  const bytes = new Uint8Array(buffer);
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  if (encoding !== 'auto') {
    const r = decodeWith(bom && encoding === 'utf-8' ? bytes.subarray(3) : bytes, encoding);
    return { ...r, encoding, bom, confidence: r.bad ? 'low' : 'high', note: r.bad ? '読めない文字があります' : '' };
  }
  if (bom) {
    const r = decodeWith(bytes.subarray(3), 'utf-8');
    return { ...r, encoding: 'utf-8', bom: true, confidence: 'high', note: 'UTF-8（BOM 付き）' };
  }
  // UTF-8 として正しく読めれば UTF-8
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, bad: 0, badLines: [], encoding: 'utf-8', bom: false, confidence: 'high', note: 'UTF-8' };
  } catch { /* UTF-8 ではない */ }
  const sjis = decodeWith(bytes, 'shift_jis');
  const utf8 = decodeWith(bytes, 'utf-8');
  if (sjis.bad <= utf8.bad) {
    return { ...sjis, encoding: 'shift_jis', bom: false, confidence: sjis.bad ? 'low' : 'medium', note: sjis.bad ? 'Shift_JIS と判定しましたが、読めない文字があります' : 'Shift_JIS（UTF-8 ではないため）' };
  }
  return { ...utf8, encoding: 'utf-8', bom: false, confidence: 'low', note: 'UTF-8 と判定しましたが、読めない文字があります' };
}

export function splitLines(text) {
  return text.replace(/^﻿/, '').split(/\r\n|\r|\n/);
}

// ---------- 区切りの条件 ----------
// rule = { enabled, pattern, position: 'start'|'any', method: 'exact'|'prefix'|'regex', title: 'include'|'exclude' }

export const MAX_PATTERN = 200;
const MAX_LINE_TEST = 400; // 1行のうち、判定に使う長さ（極端に長い行で止まらないように）

export class RuleError extends Error {}

export function compileRule(rule) {
  if (!rule || !rule.enabled || !rule.pattern) return null;
  const p = rule.pattern;
  if (p.length > MAX_PATTERN) throw new RuleError(`条件が長すぎます（${MAX_PATTERN}文字まで）`);
  if (rule.method === 'regex') {
    // 入れ子の繰り返し（例 (a+)+）は極端に遅くなることがあるので受け付けない
    if (/\((?:[^()\\]|\\.)*[+*}]\)\s*[+*{]/.test(p)) throw new RuleError('「(…+)+」のような入れ子の繰り返しは使えません');
    let re;
    try { re = new RegExp(p, 'u'); } catch (e) { throw new RuleError('正規表現の書き方に誤りがあります：' + e.message); }
    return (line) => re.test(line.slice(0, MAX_LINE_TEST));
  }
  const atStart = rule.position !== 'any';
  if (rule.method === 'exact') return (line) => line.trim() === p.trim();
  // 前方一致：行頭なら行の先頭（字下げの空白は無視）、行内ならどこかに含む
  return atStart ? (line) => line.replace(/^[\s　]+/, '').startsWith(p) : (line) => line.includes(p);
}

/**
 * 区切りを自動で探す。戻り値：Map<行番号, 'episode'|'chapter'>
 * 章の条件に合う行は章を優先する。時間がかかりすぎたら止める。
 */
export function detectMarks(lines, rules, { timeLimit = 3000 } = {}) {
  const ep = compileRule(rules.episode);
  const ch = compileRule(rules.chapter);
  const marks = new Map();
  if (!ep && !ch) return marks;
  const t0 = Date.now();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (ch && ch(line)) marks.set(i, 'chapter');
    else if (ep && ep(line)) marks.set(i, 'episode');
    if ((i & 1023) === 0 && Date.now() - t0 > timeLimit) {
      throw new RuleError('区切りの判定に時間がかかりすぎたため止めました。条件を見直してください');
    }
  }
  return marks;
}

// 自動検出と手動指定を合わせる（手動が優先。'none' は区切り解除）
export function mergeMarks(auto, manual) {
  const out = new Map(auto);
  for (const [i, m] of manual) {
    if (m === 'none') out.delete(i);
    else out.set(i, m);
  }
  return out;
}

// ---------- 章・話への分割 ----------

function trimBlankLines(arr) {
  let s = 0;
  let e = arr.length;
  while (s < e && !arr[s].trim()) s++;
  while (e > s && !arr[e - 1].trim()) e--;
  return arr.slice(s, e);
}

// ---------- 見出し（【…】）の掃除 ----------
//
// cleanup = {
//   enabled,
//   pattern:       見出しの行とみなす条件（正規表現。例 ^【[^】]+】$）,
//   defaultAction: 条件に合う見出しの既定の扱い,
//   rules: [{ text, method: 'exact'|'prefix'|'regex', action }]  見出しごとの扱い（こちらが優先）,
// }
// 扱い（action）
//   'keep'      残す（何もしない）
//   'line'      この行だけ消す（例：【本文】【エピソードタイトル】）
//   'block'     この行から、次の見出しか次の話の区切りまでを塊ごと消す（例：【リアクション】）
//   'foreword'  この行は消し、次の見出しまでを前書きにする
//   'afterword' この行は消し、次の見出しまでを後書きにする
// 話・章の区切り行（marks）で塊は終わる。

export const CLEANUP_ACTIONS = [
  ['line', 'この行だけ消す'],
  ['block', 'この行から塊ごと消す'],
  ['foreword', '塊を前書きにする（行は消す）'],
  ['afterword', '塊を後書きにする（行は消す）'],
  ['keep', '残す'],
];

/**
 * 行ごとの扱いを返す。戻り値：配列（null＝そのまま、'line'・'block'＝取り込まない、'foreword'・'afterword'＝その欄へ）
 */
export function headingMask(lines, cleanup, marks = new Map()) {
  const mask = new Array(lines.length).fill(null);
  if (!cleanup || !cleanup.enabled) return mask;
  const isHeading = cleanup.pattern ? compileRule({ enabled: true, pattern: cleanup.pattern, method: 'regex' }) : null;
  const rules = (cleanup.rules || [])
    .filter((r) => r && r.text)
    .map((r) => ({ test: compileRule({ enabled: true, pattern: r.text, method: r.method || 'exact', position: 'start' }), action: r.action || 'line' }));
  let mode = null;
  for (let i = 0; i < lines.length; i++) {
    if (marks.has(i)) { mode = null; continue; }
    const line = lines[i];
    const rule = line.trim() ? rules.find((r) => r.test(line)) : null;
    const action = rule ? rule.action : (isHeading && line.trim() && isHeading(line) ? cleanup.defaultAction || 'line' : null);
    if (action) {
      if (action === 'keep') { mode = null; continue; }
      mask[i] = 'line';
      mode = action === 'block' ? 'block' : action === 'foreword' ? 'foreword' : action === 'afterword' ? 'afterword' : null;
      continue;
    }
    if (mode) mask[i] = mode;
  }
  return mask;
}

/**
 * opts = {
 *   episodeTitle: 'include'|'exclude'（区切り行をタイトルにする／捨てて次の行をタイトルにする）,
 *   chapterTitle: 同上,
 *   episodePrefix / chapterPrefix: タイトルから外す区切り記号（前方一致の条件のとき）,
 *   separator: 前書き・後書きの区切り行の条件（rule。なければ分けない）,
 *   mask: headingMask の結果（消す行・前書き／後書きにする行）,
 * }
 * 戻り値 { head: { title, lines }, chapters: [{ title, line }], episodes: [{ title, chapter（章の位置 or null）, foreword, body, afterword, line, warnings }] }
 */
export function buildEpisodes(lines, marks, opts = {}) {
  const sepTest = opts.separator ? compileRule(opts.separator) : null;
  const mask = opts.mask || [];
  const textOf = (idx) => idx.map((i) => lines[i]);
  const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
  const points = [...marks.entries()].sort((a, b) => a[0] - b[0]);
  const chapters = [];
  const episodes = [];
  const firstMark = points.length ? points[0][0] : lines.length;
  const headLines = trimBlankLines(textOf(range(0, firstMark).filter((i) => !mask[i])));
  let chapterIndex = null;

  for (let k = 0; k < points.length; k++) {
    const [start, kind] = points[k];
    const end = k + 1 < points.length ? points[k + 1][0] : lines.length;
    // 区切り行のあとの行。消す行は除き、前書き・後書きにする行は分けておく
    const after = range(start + 1, end);
    let bodyIdx = after.filter((i) => !mask[i]);
    const foreIdx = after.filter((i) => mask[i] === 'foreword');
    const afterIdx = after.filter((i) => mask[i] === 'afterword');
    const titleMode = kind === 'chapter' ? (opts.chapterTitle || 'include') : (opts.episodeTitle || 'include');
    let title;
    if (titleMode === 'include') {
      title = lines[start].trim();
      // 「◆タイトル」のような前方一致の区切り記号は、タイトルから外す（記号だけの行ならそのまま）
      const prefix = kind === 'chapter' ? opts.chapterPrefix : opts.episodePrefix;
      if (prefix && title.startsWith(prefix) && title.slice(prefix.length).trim()) title = title.slice(prefix.length).trim();
    } else {
      // 区切り行は取り込まず、そのあとの最初の（消さない）行をタイトルにする
      const t = bodyIdx.findIndex((i) => lines[i].trim());
      title = t >= 0 ? lines[bodyIdx[t]].trim() : '';
      bodyIdx = t >= 0 ? bodyIdx.slice(t + 1) : [];
    }
    const block = textOf(bodyIdx);
    if (kind === 'chapter') {
      chapters.push({ title, line: start });
      chapterIndex = chapters.length - 1;
      // 章の見出しのあとにある文章（章の前書きなど）は、どの話にも入らないので警告
      const rest = trimBlankLines(block);
      if (rest.length) {
        episodes.push({
          title: '', chapter: chapterIndex, foreword: '', body: rest.join('\n'), afterword: '', line: start + 1,
          warnings: ['章の見出しと最初の話の間に文章があります（タイトルなしの話として扱います）'], orphan: true,
        });
      }
      continue;
    }
    const ep = { title, chapter: chapterIndex, foreword: '', body: '', afterword: '', line: start, warnings: [] };
    const body = trimBlankLines(block);
    if (foreIdx.length || afterIdx.length) {
      // 見出しで前書き・後書きが分かっているときは、それを使う
      ep.foreword = trimBlankLines(textOf(foreIdx)).join('\n');
      ep.afterword = trimBlankLines(textOf(afterIdx)).join('\n');
      ep.body = body.join('\n');
    } else if (sepTest) {
      const seps = body.map((l, i) => (sepTest(l) ? i : -1)).filter((i) => i >= 0);
      if (seps.length >= 2) {
        ep.foreword = trimBlankLines(body.slice(0, seps[0])).join('\n');
        ep.body = trimBlankLines(body.slice(seps[0] + 1, seps[seps.length - 1])).join('\n');
        ep.afterword = trimBlankLines(body.slice(seps[seps.length - 1] + 1)).join('\n');
        if (seps.length > 2) ep.warnings.push(`前書き・後書きの区切り行が${seps.length}個あります（最初と最後で分けました）`);
      } else if (seps.length === 1) {
        ep.body = trimBlankLines(body.slice(0, seps[0])).join('\n');
        ep.afterword = trimBlankLines(body.slice(seps[0] + 1)).join('\n');
        ep.warnings.push('区切り行が1つだけなので、後ろを後書きとして扱いました');
      } else {
        ep.body = body.join('\n');
      }
    } else {
      ep.body = body.join('\n');
    }
    if (!ep.title) ep.warnings.push('タイトルがありません');
    if (!ep.body) ep.warnings.push('本文が空です');
    episodes.push(ep);
  }
  const headTitle = headLines.find((l) => l.trim())?.trim() || '';
  return { head: { title: headTitle, lines: headLines }, chapters, episodes };
}

// ---------- 重複判定 ----------

export function normalizeTitle(s) {
  return (s || '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();
}

// 本文の指紋（空白の違いは無視）。FNV-1a 32bit
export function textHash(s) {
  const t = (s || '').normalize('NFKC').replace(/[\s　]+/g, '');
  let h = 0x811c9dc5;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return t.length + ':' + h.toString(16);
}

// 「第1話　筆になった朝」と「筆になった朝」のような、話数の有無だけが違うタイトル
const TITLE_NUMBER = /^(第[0-9０-９一二三四五六七八九十百千〇零]+[話章部節]|episode[0-9]+|[0-9０-９]+[.．、話])/i;
function coreTitle(s) {
  return normalizeTitle(s).replace(TITLE_NUMBER, '').replace(/^[-‐ー:：・]+/, '');
}

/**
 * 取り込む話ごとに、既存のエピソードとの重複候補を探す。
 * 優先順：① 以前の取り込みで保存した取込キー（同じサイト側の本文の指紋）が一致 ② 本文の指紋が一致
 *        ③ タイトル（と章名）が一致 ④ 話数を除いたタイトルが一致（似たタイトル）
 * 判定の種類：'same'（同じ本文）／'title'（同じタイトル）／'similar'（似たタイトル）／'none'
 * 既定の扱い：same → スキップ。title・similar → 取り込み先が空なら上書き（空を埋めるだけで何も失わない）、
 *            内容があればスキップ（判定が確実でないものは自動で上書きしない）。none → 追加
 * @param items  buildEpisodes の episodes に chapterTitle を付けたもの
 * @param existing [{ id, title, chapterTitle, body（取り込むサイト側）, importKey（取り込むサイト側） }]
 */
export function findDuplicates(items, existing) {
  const byKey = new Map();
  const byHash = new Map();
  const byTitle = new Map();
  const byCore = new Map();
  for (const e of existing) {
    if (e.importKey) byKey.set(e.importKey, e);
    if (e.body) byHash.set(textHash(e.body), e);
    const t = normalizeTitle(e.title);
    if (t) {
      const k = t + '|' + normalizeTitle(e.chapterTitle);
      if (!byTitle.has(k)) byTitle.set(k, e);
      if (!byTitle.has(t)) byTitle.set(t, e);
      const core = coreTitle(e.title);
      if (core.length >= 2 && !byCore.has(core)) byCore.set(core, e);
    }
  }
  const used = new Set();
  return items.map((it) => {
    const hash = textHash(it.body);
    const hit = byKey.get(hash) || (it.body ? byHash.get(hash) : null);
    if (hit) { used.add(hit.id); return { kind: 'same', target: hit.id, action: 'skip', hash }; }
    const t = normalizeTitle(it.title);
    const th = t && (byTitle.get(t + '|' + normalizeTitle(it.chapterTitle)) || byTitle.get(t));
    if (th && !used.has(th.id)) { used.add(th.id); return { kind: 'title', target: th.id, action: th.body ? 'skip' : 'overwrite', hash }; }
    const core = coreTitle(it.title);
    const sim = core.length >= 2 && byCore.get(core);
    if (sim && !used.has(sim.id)) { used.add(sim.id); return { kind: 'similar', target: sim.id, action: sim.body ? 'skip' : 'overwrite', hash }; }
    return { kind: 'none', target: null, action: 'add', hash };
  });
}

// ---------- プリセット（区切り条件の初期値。サンプルの TXT に合わせて調整する） ----------

const NUM = '0-9０-９一二三四五六七八九十百千〇零';

// 見出し（【…】）の掃除を使わないときの値
export const NO_CLEANUP = { enabled: false, pattern: '^[\\s\\u3000]*【[^】]+】[\\s\\u3000]*$', defaultAction: 'line', rules: [] };

export const PRESETS = [
  {
    // なろうからダウンロードした TXT：
    //   ------------------------- エピソード2開始 -------------------------
    //   【エピソードタイトル】
    //   タイトル
    //   【本文】
    //   本文…
    //   【リアクション】
    //   …（取り込まない）
    id: 'narou-download',
    name: 'なろう：ダウンロード TXT（区切り線と【見出し】）',
    site: 'narou',
    rules: {
      episode: { enabled: true, pattern: '^[\\s\\u3000]*-{3,}[\\s\\u3000]*エピソード[\\s\\u3000]*[0-9０-９]+[\\s\\u3000]*開始[\\s\\u3000]*-{3,}[\\s\\u3000]*$', position: 'start', method: 'regex', title: 'exclude' },
      chapter: { enabled: false, pattern: `^[\\s\\u3000]*第[${NUM}]+章`, position: 'start', method: 'regex', title: 'include' },
      separator: { enabled: false, pattern: '^[\\s\\u3000]*[＊*◇◆☆★]{3,}[\\s\\u3000]*$', position: 'start', method: 'regex' },
      cleanup: {
        enabled: true,
        pattern: '^[\\s\\u3000]*【[^】]+】[\\s\\u3000]*$',
        defaultAction: 'line',
        rules: [
          { text: '【リアクション】', method: 'exact', action: 'block' },
          { text: '【前書き】', method: 'exact', action: 'foreword' },
          { text: '【後書き】', method: 'exact', action: 'afterword' },
        ],
      },
    },
  },
  {
    id: 'narou',
    name: 'なろう：「第○話」「第○章」の行',
    site: 'narou',
    rules: {
      episode: { enabled: true, pattern: `^[\\s\\u3000]*第[${NUM}]+話`, position: 'start', method: 'regex', title: 'include' },
      chapter: { enabled: true, pattern: `^[\\s\\u3000]*第[${NUM}]+章`, position: 'start', method: 'regex', title: 'include' },
      separator: { enabled: false, pattern: '^[\\s\\u3000]*[＊*◇◆☆★]{3,}[\\s\\u3000]*$', position: 'start', method: 'regex' },
      cleanup: NO_CLEANUP,
    },
  },
  {
    id: 'alpha-mark',
    name: 'アルファ：行頭「◆」でエピソード',
    site: 'alpha',
    rules: {
      episode: { enabled: true, pattern: '◆', position: 'start', method: 'prefix', title: 'include' },
      chapter: { enabled: false, pattern: '■', position: 'start', method: 'prefix', title: 'include' },
      separator: { enabled: false, pattern: '', position: 'start', method: 'regex' },
      cleanup: NO_CLEANUP,
    },
  },
  {
    id: 'episode-en',
    name: '「Episode 1」形式',
    site: 'alpha',
    rules: {
      episode: { enabled: true, pattern: '^\\s*Episode\\s*[0-9]+', position: 'start', method: 'regex', title: 'include' },
      chapter: { enabled: false, pattern: '^\\s*Chapter\\s*[0-9]+', position: 'start', method: 'regex', title: 'include' },
      separator: { enabled: false, pattern: '', position: 'start', method: 'regex' },
      cleanup: NO_CLEANUP,
    },
  },
];

export function summarize(result) {
  const eps = result.episodes;
  return {
    chapters: result.chapters.length,
    episodes: eps.length,
    chars: eps.reduce((n, e) => n + [...e.body].length, 0),
    images: eps.reduce((n, e) => n + countImages(e.body), 0),
    forewords: eps.filter((e) => e.foreword).length,
    afterwords: eps.filter((e) => e.afterword).length,
    warnings: eps.reduce((n, e) => n + e.warnings.length, 0),
    headLines: result.head.lines.length,
  };
}
