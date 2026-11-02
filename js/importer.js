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
//   'line'      この行だけ消す（例：【本文】）
//   'title'     この行は消し、次の行をその話のタイトルにする（例：【エピソードタイトル】）
//   'block'     この行から、次の見出しか次の話の区切りまでを塊ごと消す（例：【リアクション】）
//   'foreword'  この行は消し、次の見出しまでを前書きにする
//   'afterword' この行は消し、次の見出しまでを後書きにする
// 話・章の区切り行（marks）で塊は終わる。

export const CLEANUP_ACTIONS = [
  ['line', 'この行だけ消す'],
  ['title', '次の行を話のタイトルにする（行は消す）'],
  ['block', 'この行から塊ごと消す'],
  ['foreword', '塊を前書きにする（行は消す）'],
  ['afterword', '塊を後書きにする（行は消す）'],
  ['keep', '残す'],
];

/**
 * 行ごとの扱いを返す。戻り値：配列
 *   null＝そのまま、'line'・'block'＝取り込まない、'title'＝話のタイトル、'foreword'・'afterword'＝その欄へ
 */
export function headingMask(lines, cleanup, marks = new Map()) {
  const mask = new Array(lines.length).fill(null);
  if (!cleanup || !cleanup.enabled) return mask;
  const isHeading = cleanup.pattern ? compileRule({ enabled: true, pattern: cleanup.pattern, method: 'regex' }) : null;
  const rules = (cleanup.rules || [])
    .filter((r) => r && r.text)
    .map((r) => ({ test: compileRule({ enabled: true, pattern: r.text, method: r.method || 'exact', position: 'start' }), action: r.action || 'line' }));
  let mode = null;
  let wantTitle = false;
  for (let i = 0; i < lines.length; i++) {
    if (marks.has(i)) { mode = null; continue; }
    const line = lines[i];
    const rule = line.trim() ? rules.find((r) => r.test(line)) : null;
    const action = rule ? rule.action : (isHeading && line.trim() && isHeading(line) ? cleanup.defaultAction || 'line' : null);
    if (action) {
      if (action === 'keep') { mode = null; continue; }
      mask[i] = 'line';
      wantTitle = action === 'title';
      mode = action === 'block' ? 'block' : action === 'foreword' ? 'foreword' : action === 'afterword' ? 'afterword' : null;
      continue;
    }
    // 「次の行をタイトルに」の見出しのあと、最初の空でない行がタイトル
    if (wantTitle && line.trim()) { mask[i] = 'title'; wantTitle = false; continue; }
    if (mode) mask[i] = mode;
  }
  return mask;
}

/**
 * opts = {
 *   episodeTitle: 'include'|'exclude'|'combine'
 *     include：区切り行をタイトルにする／exclude：区切り行は捨てて次の行をタイトルにする／combine：区切り行と次の行をつなげる
 *   chapterTitle: 同上（例：【第１章】の次の行が章の小タイトル → exclude）,
 *   episodePrefix / chapterPrefix: タイトルから外す区切り記号（前方一致の条件のとき）,
 *   separator: 前書き・後書きの区切り行の条件（rule。なければ分けない）,
 *   mask: headingMask の結果（消す行・タイトル・前書き／後書きにする行）,
 * }
 * 話の区切り線のすぐあとに章の見出しがある場合（区切り線 → 【第１章】 → 小タイトル → 【エピソードタイトル】 …）も、
 * 章の見出しのあとに話の区切り線がある場合も、どちらでも分けられる。
 * 戻り値 { head: { title, lines }, chapters: [{ title, line }], episodes: [{ title, chapter（章の位置 or null）, foreword, body, afterword, line, warnings }] }
 */
export function buildEpisodes(lines, marks, opts = {}) {
  const sepTest = opts.separator ? compileRule(opts.separator) : null;
  const mask = opts.mask || [];
  const textOf = (idx) => idx.map((i) => lines[i]);
  const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, k) => a + k);
  const hasText = (idx) => idx.some((i) => lines[i].trim());
  const points = [...marks.entries()].sort((a, b) => a[0] - b[0]);
  const chapters = [];
  const episodes = [];
  const firstMark = points.length ? points[0][0] : lines.length;
  const headLines = trimBlankLines(textOf(range(0, firstMark).filter((i) => !mask[i])));
  let chapterIndex = null;
  let pending = null; // 区切り線のあと中身がなく、すぐ章の見出しが来た話（{ line, title }）

  // 区切り行（start）とその後ろの行から、タイトルを決める。戻り値 { title, rest（タイトルに使った行を除いた行） }
  function titleOf(start, kind, bodyIdx) {
    const mode = kind === 'chapter' ? (opts.chapterTitle || 'include') : (opts.episodeTitle || 'include');
    let head = lines[start].trim();
    const prefix = kind === 'chapter' ? opts.chapterPrefix : opts.episodePrefix;
    // 「◆タイトル」のような前方一致の区切り記号は、タイトルから外す（記号だけの行ならそのまま）
    if (prefix && head.startsWith(prefix) && head.slice(prefix.length).trim()) head = head.slice(prefix.length).trim();
    if (mode === 'include') return { title: head, rest: bodyIdx };
    const t = bodyIdx.findIndex((i) => lines[i].trim());
    const next = t >= 0 ? lines[bodyIdx[t]].trim() : '';
    const rest = t >= 0 ? bodyIdx.slice(t + 1) : [];
    // 【第１章】 → 「第１章」のように、見出しの括弧は外してつなげる
    if (mode === 'combine') return { title: [head.replace(/^【(.+)】$/, '$1'), next].filter(Boolean).join('　'), rest };
    return { title: next, rest };
  }

  function makeEpisode(line, title, bodyIdx, foreIdx, afterIdx, warnings = []) {
    const ep = { title, chapter: chapterIndex, foreword: '', body: '', afterword: '', line, warnings: [...warnings] };
    const body = trimBlankLines(textOf(bodyIdx));
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

  for (let k = 0; k < points.length; k++) {
    const [start, kind] = points[k];
    const next = points[k + 1];
    const end = next ? next[0] : lines.length;
    // 区切り行のあとの行。消す行は除き、タイトル・前書き・後書きにする行は分けておく
    const after = range(start + 1, end);
    const markedTitle = after.find((i) => mask[i] === 'title');
    const bodyIdx = after.filter((i) => !mask[i]);
    const foreIdx = after.filter((i) => mask[i] === 'foreword');
    const afterIdx = after.filter((i) => mask[i] === 'afterword');

    if (kind === 'chapter') {
      const { title, rest } = titleOf(start, 'chapter', bodyIdx);
      chapters.push({ title, line: start });
      chapterIndex = chapters.length - 1;
      if (pending || markedTitle !== undefined) {
        // 区切り線 → 章の見出し → … の順：章の見出しのあとがその話の中身
        const epTitle = markedTitle !== undefined ? lines[markedTitle].trim() : (pending?.title || '');
        let r = rest;
        if (!epTitle && markedTitle === undefined && !pending?.title) {
          // タイトルの印がなければ、章の小タイトルの次の行を話のタイトルにする
          const t = r.findIndex((i) => lines[i].trim());
          makeEpisode(pending?.line ?? start, t >= 0 ? lines[r[t]].trim() : '', t >= 0 ? r.slice(t + 1) : [], foreIdx, afterIdx);
        } else {
          makeEpisode(pending?.line ?? start, epTitle, r, foreIdx, afterIdx);
        }
        pending = null;
        continue;
      }
      // 章の見出しのあとにある文章（章の前書きなど）は、どの話にも入らないので警告
      if (hasText(rest)) {
        episodes.push({
          title: '', chapter: chapterIndex, foreword: '', body: trimBlankLines(textOf(rest)).join('\n'), afterword: '', line: start + 1,
          warnings: ['章の見出しと最初の話の間に文章があります（タイトルなしの話として扱います）'], orphan: true,
        });
      }
      continue;
    }

    // 話
    if (pending) {
      // 前の区切り線のあと、章の見出しが来ないまま次の区切り線になった（中身のない話）
      makeEpisode(pending.line, pending.title, [], [], []);
      pending = null;
    }
    // 中身がなく、すぐあとが章の見出しなら、その章の見出しのあとを中身として扱う
    if (!hasText(bodyIdx) && !foreIdx.length && !afterIdx.length && markedTitle === undefined && next && next[1] === 'chapter') {
      const { title } = titleOf(start, 'episode', bodyIdx);
      pending = { line: start, title };
      continue;
    }
    let title;
    let rest = bodyIdx;
    if (markedTitle !== undefined) {
      title = lines[markedTitle].trim();
    } else {
      ({ title, rest } = titleOf(start, 'episode', bodyIdx));
    }
    makeEpisode(start, title, rest, foreIdx, afterIdx);
  }
  if (pending) makeEpisode(pending.line, pending.title, [], [], []);
  const headTitle = headLines.find((l) => l.trim())?.trim() || '';
  return { head: { title: headTitle, lines: headLines }, chapters, episodes };
}

// ---------- TXT の作品・ユーザ情報と、設定に登録した内容の照合 ----------

const HEADING_LINE = /^[\s　]*【([^】]+)】[\s　]*(.*)$/;
const NCODE = /\bn\d{4}[a-z]{1,3}\b/i;
const USER_LABEL = /ユーザー?情報|ユーザー?ID|ユーザー?名|作者/;

/**
 * TXT の中の【Nコード】【ユーザ情報】などの塊を読む（最初に出てきたものだけ）。
 * 戻り値 { ncode（見つかった Nコード。小文字）, ncodeText, userText（ユーザ情報・作者の塊の文字）, labels（見つかった見出し） }
 */
export function extractSiteInfo(lines) {
  const blocks = new Map();
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_LINE.exec(lines[i]);
    if (!m) continue;
    const label = m[1].trim();
    if (blocks.has(label)) continue;
    const body = m[2] ? [m[2]] : [];
    for (let j = i + 1; j < lines.length && j <= i + 20; j++) {
      if (HEADING_LINE.test(lines[j]) || /^[\s　]*-{3,}/.test(lines[j])) break;
      if (lines[j].trim()) body.push(lines[j].trim());
    }
    blocks.set(label, body.join('\n'));
  }
  const ncodeLabel = [...blocks.keys()].find((k) => /Nコード|NCODE/i.test(k));
  const ncodeText = ncodeLabel ? blocks.get(ncodeLabel) : '';
  const userText = [...blocks.entries()].filter(([k]) => USER_LABEL.test(k)).map(([, v]) => v).join('\n');
  return {
    ncode: (NCODE.exec(ncodeText) || [])[0]?.toLowerCase() || '',
    ncodeText,
    userText,
    labels: [...blocks.keys()],
  };
}

const norm = (s) => (s || '').normalize('NFKC').replace(/[\s　]+/g, '').toLowerCase();

/**
 * 登録した内容と TXT の情報が違う項目を返す（どちらかが空の項目は比べない）。
 * @param account { userId, userName, author }  設定のアカウント
 * @param ncode   取り込み先の作品の Nコード（新しい作品なら空）
 * @returns [{ label, registered, found }]
 */
export function checkSiteInfo(info, account = {}, ncode = '') {
  const out = [];
  if (ncode && info.ncode && norm(ncode) !== norm(info.ncode)) {
    out.push({ label: 'Nコード', registered: ncode, found: info.ncode });
  }
  const labels = { userId: 'ユーザID', userName: 'ユーザ名', author: '作者名' };
  if (info.userText) {
    for (const [key, label] of Object.entries(labels)) {
      const v = account[key];
      if (v && !norm(info.userText).includes(norm(v))) {
        out.push({ label, registered: v, found: info.userText.replace(/\n/g, ' / ').slice(0, 80) });
      }
    }
  }
  return out;
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

// ---------- タイトル一覧を使った区切り ----------

export const ALPHA_TITLE_LIST_TEMPLATE = `#よみとばし
改行
空白
コメント //

#エピソード
エピソードタイトル
テキスト
テキスト
テキスト

#章
章タイトル
エピソードタイトル
テキスト
テキスト
テキスト`;

const TITLE_LIST_HEADS = new Map([['#よみとばし', 'skip'], ['#エピソード', 'episode'], ['#章', 'chapter']]);
const TITLE_LIST_TOKENS = new Set(['章タイトル', 'エピソードタイトル', 'テキスト']);

export function parseTitleListTemplate(text) {
  const raw = splitLines(text || '');
  let comment = '';
  let scanKind = null;
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i].trim();
    if (TITLE_LIST_HEADS.has(line)) { scanKind = TITLE_LIST_HEADS.get(line); continue; }
    const m = scanKind === 'skip' && /^コメント\s+(\S+)$/.exec(line);
    if (!m) continue;
    if (comment) throw new RuleError(`${i + 1}行目：「コメント」の指定が重複しています`);
    comment = m[1];
  }
  const lines = raw.map((source, i) => {
    const trimmed = source.trim();
    const isDirective = /^コメント\s+\S+$/.test(trimmed);
    const body = !isDirective && comment && source.includes(comment) ? source.slice(0, source.indexOf(comment)) : source;
    const line = body.trim();
    return line ? { line, no: i + 1 } : null;
  }).filter(Boolean);
  const blocks = {};
  const skip = { blankLines: false, whitespace: false, comment };
  let kind = null;
  for (const item of lines) {
    const { line, no } = item;
    if (TITLE_LIST_HEADS.has(line)) {
      kind = TITLE_LIST_HEADS.get(line);
      if (blocks[kind]) throw new RuleError(`${no}行目：${line}が重複しています`);
      blocks[kind] = [];
      continue;
    }
    if (!kind) throw new RuleError(`${no}行目：最初に「#よみとばし」「#エピソード」「#章」のいずれかを指定してください`);
    if (kind === 'skip') {
      if (line === '改行') skip.blankLines = true;
      else if (line === '空白') skip.whitespace = true;
      else if (/^コメント\s+\S+$/.test(line)) { /* 先の走査で取得済み */ }
      else throw new RuleError(`${no}行目：「#よみとばし」では「改行」「空白」「コメント 記号」を指定できます`);
      continue;
    }
    if (!TITLE_LIST_TOKENS.has(line)) throw new RuleError(`${no}行目：「${line}」は使用できません`);
    blocks[kind].push(line);
  }
  if (!blocks.episode) throw new RuleError('「#エピソード」の書式がありません');
  if (!blocks.chapter) throw new RuleError('「#章」の書式がありません');
  const count = (a, token) => a.filter((x) => x === token).length;
  if (count(blocks.episode, 'エピソードタイトル') !== 1 || count(blocks.episode, '章タイトル')) {
    throw new RuleError('「#エピソード」には「エピソードタイトル」を1つだけ指定してください');
  }
  if (count(blocks.chapter, '章タイトル') !== 1 || count(blocks.chapter, 'エピソードタイトル') !== 1) {
    throw new RuleError('「#章」には「章タイトル」と「エピソードタイトル」を1つずつ指定してください');
  }
  return { ...blocks, skip };
}

/** タイトル一覧を本文TXTと照合し、章・話の区切りを返す。 */
export function detectMarksFromTitleList(sourceLines, listText, templateText) {
  const blocks = parseTitleListTemplate(templateText);
  let rows = splitLines(listText || '').map((raw, i) => ({ raw, text: blocks.skip.whitespace ? raw.trim() : raw, line: i + 1 }));
  if (blocks.skip.comment) rows = rows.filter((row) => !row.raw.trimStart().startsWith(blocks.skip.comment));
  if (blocks.skip.blankLines) rows = rows.filter((row) => row.raw !== '');
  if (blocks.skip.whitespace) rows = rows.filter((row) => row.text !== '');
  while (rows.length && !rows[0].text) rows.shift();
  while (rows.length && !rows[rows.length - 1].text) rows.pop();
  if (!rows.length) throw new RuleError('タイトル一覧が空です');
  const marks = new Map();
  const records = [];
  let sourceFrom = 0;

  const findTitle = (title, from) => {
    const wanted = normalizeTitle(title);
    if (!wanted) return -1;
    for (let i = Math.max(0, from); i < sourceLines.length; i++) {
      if (normalizeTitle(sourceLines[i]) === wanted) return i;
    }
    return -1;
  };
  const candidate = (tokens, at, type) => {
    let cursor = at;
    let chapterTitle = '';
    let episodeTitle = '';
    for (const token of tokens) {
      const row = rows[cursor];
      if (!row) return null;
      if (!row.text) return null;
      if (token === '章タイトル') chapterTitle = row.text;
      if (token === 'エピソードタイトル') episodeTitle = row.text;
      cursor++;
    }
    const chapterLine = chapterTitle ? findTitle(chapterTitle, sourceFrom) : -1;
    const episodeLine = findTitle(episodeTitle, type === 'chapter' ? chapterLine + 1 : sourceFrom);
    if (episodeLine < 0 || (type === 'chapter' && (chapterLine < 0 || chapterLine >= episodeLine))) return null;
    if (type === 'chapter' && sourceLines.slice(chapterLine + 1, episodeLine).some((line) => line.trim())) return null;
    return { type, end: cursor, chapterTitle, episodeTitle, chapterLine, episodeLine };
  };

  for (let at = 0; at < rows.length;) {
    const chapter = candidate(blocks.chapter, at, 'chapter');
    const episode = candidate(blocks.episode, at, 'episode');
    // 章形式は章・話の2タイトルが本文中に順番どおり一致した場合に優先する。
    const picked = chapter || episode;
    if (!picked) {
      const sample = rows[at].text.length > 40 ? rows[at].text.slice(0, 40) + '…' : rows[at].text;
      throw new RuleError(`タイトル一覧の${rows[at].line}行目「${sample}」を本文TXTと照合できません`);
    }
    if (picked.type === 'chapter') marks.set(picked.chapterLine, 'chapter');
    marks.set(picked.episodeLine, 'episode');
    records.push(picked);
    sourceFrom = picked.episodeLine + 1;
    at = picked.end;
  }
  return { marks, records };
}

export const PRESETS = [
  {
    // なろうからダウンロードした TXT：
    //   ------------------------- エピソード2開始 -------------------------
    //   【第１章】          ← 章の見出し（あれば。区切り線の前でも後でもよい）
    //   章の小タイトル
    //   【エピソードタイトル】
    //   タイトル
    //   【本文】
    //   本文…
    //   【リアクション】
    //   …（取り込まない）
    id: 'narou-download',
    name: 'なろう：ダウンロード TXT（区切り線と【見出し】）',
    site: 'narou',
    type: 'rules',
    rules: {
      episode: { enabled: true, pattern: '^[\\s\\u3000]*-{3,}[\\s\\u3000]*エピソード[\\s\\u3000]*[0-9０-９]+[\\s\\u3000]*開始[\\s\\u3000]*-{3,}[\\s\\u3000]*$', position: 'start', method: 'regex', title: 'exclude' },
      // 【第１章】の次の行が章の小タイトル
      chapter: { enabled: true, pattern: `^[\\s\\u3000]*【第[${NUM}]+章】[\\s\\u3000]*$`, position: 'start', method: 'regex', title: 'exclude' },
      separator: { enabled: false, pattern: '^[\\s\\u3000]*[＊*◇◆☆★]{3,}[\\s\\u3000]*$', position: 'start', method: 'regex' },
      cleanup: {
        enabled: true,
        pattern: '^[\\s\\u3000]*【[^】]+】[\\s\\u3000]*$',
        defaultAction: 'line',
        rules: [
          // 【エピソードタイトル】の次の行が話のタイトル
          { text: '【エピソードタイトル】', method: 'exact', action: 'title' },
          { text: '【リアクション】', method: 'exact', action: 'block' },
          // このエディターに入れる場所がない作品情報は、塊ごと消す（Nコード・ユーザ情報は取り込む前の照合には使う）
          { text: '【ユーザ情報】', method: 'exact', action: 'block' },
          { text: '【Nコード】', method: 'exact', action: 'block' },
          { text: '【種別】', method: 'exact', action: 'block' },
          { text: '【完結設定】', method: 'exact', action: 'block' },
          { text: '【年齢制限】', method: 'exact', action: 'block' },
          { text: '【ジャンル】', method: 'exact', action: 'block' },
          { text: '【作品に含まれる要素】', method: 'exact', action: 'block' },
          { text: '【キーワード】', method: 'exact', action: 'block' },
          { text: '【掲載エピソード数】', method: 'exact', action: 'block' },
          { text: '【初回掲載日時】', method: 'exact', action: 'block' },
          { text: '【最終掲載日時】', method: 'exact', action: 'block' },
          { text: '【感想受付】', method: 'exact', action: 'block' },
          { text: '【レビュー受付】', method: 'exact', action: 'block' },
          { text: '【評価受付】', method: 'exact', action: 'block' },
          { text: '【開示設定】', method: 'exact', action: 'block' },
          { text: '【評価】', method: 'exact', action: 'block' },
          { text: '【収益情報】', method: 'exact', action: 'block' },
          // ダウンロードTXT末尾の免責文と作成日時は作品本文ではないため、ここから末尾まで取り込まない
          { text: '本テキストデータの利用によって発生する如何なる案件につきましても、株式会社ヒナプロジェクト及びその関連グループは一切の責任を負いません。', method: 'prefix', action: 'block' },
          { text: '【前書き】', method: 'exact', action: 'foreword' },
          { text: '【後書き】', method: 'exact', action: 'afterword' },
        ],
      },
    },
  },
  {
    id: 'alpha-title-list',
    name: 'アルファポリス・タイトル一覧',
    site: 'alpha',
    type: 'title-list',
    template: ALPHA_TITLE_LIST_TEMPLATE,
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
