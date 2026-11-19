// 串刺し検索（0.74）：作品のすべての文字（あらすじ・全体プロット・世界観・登場人物・メモ・伏線・各エピソードの原稿・
// プロット・フリーメモ・活動報告）をまとめて検索する。画面に関係しない処理だけをここに置く。
//
// 検索の単位（AND の判定もこの単位ごと）：
//   あらすじ／章1つ（タイトル＋プロット）／世界観・登場人物の1行／メモ1つ（名前＋本文）／伏線1件（名前・内容・回収の記録）／
//   エピソードの欄1つ（例：第3話のなろう用の本文、第3話のプロット）
// 大文字・小文字と、全角・半角の英数字は区別しない（文字の位置は変えないので、当たった位置で入力欄の文字を選べる）。
import { draftOf, episodeName, SITE_KEYS } from './format.js';
import { SITES } from './sites/index.js';
import { CHARACTER_COLUMNS, WORLD_COLUMNS } from './tables.js';

export const SEARCH_TARGETS = [
  { key: 'synopsis', label: 'あらすじ', group: 'work' },
  { key: 'outline', label: '全体プロット（章）', group: 'work' },
  { key: 'world', label: '世界観・用語', group: 'work' },
  { key: 'characters', label: '登場人物', group: 'work' },
  { key: 'memo', label: 'メモ', group: 'work' },
  { key: 'foreshadow', label: '伏線', group: 'work' },
  { key: 'ep-title', label: 'エピソードタイトル', group: 'episode', site: true },
  { key: 'body', label: '本文', group: 'episode', site: true },
  { key: 'foreword', label: '前書き', group: 'episode', site: true },
  { key: 'afterword', label: '後書き', group: 'episode', site: true },
  { key: 'plot', label: 'エピソードのプロット', group: 'episode' },
  { key: 'free-memo', label: 'フリーメモ', group: 'episode' },
  { key: 'report', label: '活動報告', group: 'episode' },
];
export const SEARCH_TARGET_KEYS = SEARCH_TARGETS.map((t) => t.key);
const TARGET_LABEL = Object.fromEntries(SEARCH_TARGETS.map((t) => [t.key, t.label]));
const SITE_LABEL = Object.fromEntries(SITE_KEYS.map((s) => [s, `${SITES[s].short}用`]));
const DRAFT_KEY = { 'ep-title': 'title', body: 'body', foreword: 'foreword', afterword: 'afterword' };

// 1文字ずつ置き換える（長さを変えない）：全角英数・記号 → 半角、全角スペース → 半角、A〜Z → a〜z
export function foldText(s) {
  let out = '';
  for (const ch of String(s ?? '')) {
    let c = ch.charCodeAt(0);
    if (ch.length === 1) {
      if (c >= 0xff01 && c <= 0xff5e) c -= 0xfee0;
      else if (c === 0x3000) c = 0x20;
      if (c >= 0x41 && c <= 0x5a) c += 0x20;
      out += String.fromCharCode(c);
    } else out += ch; // 2つで1文字のもの（絵文字など）はそのまま
  }
  return out;
}

// 検索語に分ける。スペース（全角も）で区切り、"…" または「…」で囲むと、スペースを含めて1語
export function parseQuery(q) {
  const words = [];
  const re = /"([^"]*)"|“([^”]*)”|「([^」]*)」|(\S+)/g;
  const src = String(q ?? '').replace(/　/g, ' ');
  let m;
  while ((m = re.exec(src))) {
    const w = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (w && w.trim()) words.push(w);
  }
  return [...new Set(words)];
}

// 検索する単位を並べる
export function searchUnits(project, { targets = SEARCH_TARGET_KEYS, sites = SITE_KEYS } = {}) {
  const on = new Set(targets);
  const units = [];
  const add = (target, title, text, ref, sub = '') => { if (text) units.push({ target, title, sub, text, ref }); };
  if (on.has('synopsis')) add('synopsis', 'あらすじ', project.synopsis, { kind: 'synopsis' });
  if (on.has('outline')) {
    project.chapters.forEach((ch, i) => {
      const name = ch.title || `（名前なしの章 ${i + 1}）`;
      add('outline', name, [ch.title, ch.plot].filter(Boolean).join('\n'), { kind: 'outline', chapterId: ch.id, titleLen: ch.title ? ch.title.length + 1 : 0 }, `第${i + 1}章`);
    });
  }
  const table = (key, data, columns) => {
    const cat = new Map((data?.categories || []).map((c) => [c.id, c.name]));
    for (const item of data?.items || []) {
      const parts = columns.filter((c) => !c.kind).map((c) => String(item[c.key] ?? '')).filter(Boolean);
      for (const r of Array.isArray(item.orgs) ? item.orgs : []) if (r.note) parts.push(r.note);
      const name = String(item[columns[0].key] ?? '') || '（名前なし）';
      add(key, name, parts.join('\n'), { kind: key, itemId: item.id, name: String(item[columns[0].key] ?? '') }, cat.get(item.categoryId) || '');
    }
  };
  if (on.has('world')) table('world', project.world, WORLD_COLUMNS);
  if (on.has('characters')) table('characters', project.characters, CHARACTER_COLUMNS);
  if (on.has('memo')) {
    for (const m of project.memos || []) {
      // 名前と本文は別の単位（本文の位置で入力欄の文字を選べるように）。名前だけ当たったときも、そのメモを出す
      add('memo', m.title || 'メモ', m.body, { kind: 'memo', memoId: m.id });
      add('memo', m.title || 'メモ', m.title, { kind: 'memo', memoId: m.id, inTitle: true }, '（メモの名前）');
    }
  }
  if (on.has('foreshadow')) {
    for (const fs of project.foreshadows || []) {
      const text = [fs.title, fs.body, ...(fs.events || []).map((e) => e.body)].filter(Boolean).join('\n');
      add('foreshadow', fs.title || '（名前なし）', text, { kind: 'foreshadow', fsId: fs.id, title: fs.title });
    }
  }
  project.episodes.forEach((ep, i) => {
    const no = i + 1;
    const name = episodeName(ep, project.site);
    const epTitle = `第${no}話「${name}」`;
    for (const key of ['ep-title', 'body', 'foreword', 'afterword']) {
      if (!on.has(key)) continue;
      for (const site of sites) add(key, epTitle, draftOf(ep, site)[DRAFT_KEY[key]], { kind: 'episode', episodeId: ep.id, field: key, site }, `${TARGET_LABEL[key]}（${SITE_LABEL[site] || site}）`);
    }
    if (on.has('plot')) add('plot', epTitle, ep.plot, { kind: 'episode', episodeId: ep.id, field: 'plot' }, 'プロット');
    if (on.has('free-memo')) add('free-memo', epTitle, ep.freeMemo, { kind: 'episode', episodeId: ep.id, field: 'free-memo' }, 'フリーメモ');
    if (on.has('report')) {
      const r = ep.report || {};
      add('report', epTitle, r.x, { kind: 'episode', episodeId: ep.id, field: 'x-text' }, 'X の投稿文');
      add('report', epTitle, r.narouTitle, { kind: 'episode', episodeId: ep.id, field: 'narou-report-title' }, '活動報告のタイトル');
      add('report', epTitle, r.narouBody, { kind: 'episode', episodeId: ep.id, field: 'narou-report-body' }, '活動報告の本文');
    }
  });
  return units;
}

// 当たった位置（語ごと）。重なりは気にせず、すべての出現を返す
function occurrences(folded, word) {
  const out = [];
  if (!word) return out;
  let i = folded.indexOf(word);
  while (i >= 0) { out.push(i); i = folded.indexOf(word, i + word.length); }
  return out;
}

// 前後の文字を付けた抜き出し（最大 max 件）。marks は抜き出しの中で色を付ける範囲
function snippets(text, ranges, { context = 30, max = 3 } = {}) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  let lastEnd = -1;
  for (const [s, e] of sorted) {
    if (out.length >= max) break;
    if (s < lastEnd) continue; // 前の抜き出しに入っている
    const from = Math.max(0, s - context);
    const to = Math.min(text.length, e + context);
    // 改行は「 ⏎ 」にして1行で見せる。map[i]＝元の i 文字目が、見せる文字列の何文字目か
    let shown = '';
    const map = [];
    for (let i = from; i < to; i++) {
      map.push(shown.length);
      const c = text[i];
      shown += c === '\n' ? ' ⏎ ' : c === '\r' ? '' : c;
    }
    map.push(shown.length);
    const marks = [];
    for (const [a, b] of sorted) {
      if (a < from || b > to) continue;
      const m = [map[a - from], map[b - from]];
      const last = marks[marks.length - 1];
      if (last && m[0] <= last[1]) last[1] = Math.max(last[1], m[1]); // 重なる語はまとめて1つの色
      else marks.push(m);
    }
    out.push({ text: shown, marks, cut: [from > 0, to < text.length] });
    lastEnd = to;
  }
  return out;
}

// 検索する。mode：'and'（すべての語を含む）| 'or'（どれかを含む）
// 戻り値：{ words, results: [{ target, title, sub, ref, count, first:{index,length}, snippets }], total, truncated }
export function crossSearch(project, { query = '', mode = 'and', targets = SEARCH_TARGET_KEYS, sites = SITE_KEYS, limit = 300 } = {}) {
  const words = parseQuery(query);
  if (!words.length) return { words, results: [], total: 0, truncated: false };
  const folded = words.map(foldText);
  const results = [];
  let total = 0;
  for (const u of searchUnits(project, { targets, sites })) {
    const f = foldText(u.text);
    const per = folded.map((w) => occurrences(f, w));
    const ok = mode === 'or' ? per.some((p) => p.length) : per.every((p) => p.length);
    if (!ok) continue;
    total++;
    if (results.length >= limit) continue;
    const ranges = per.flatMap((p, i) => p.map((s) => [s, s + folded[i].length]));
    const first = ranges.reduce((a, b) => (b[0] < a[0] ? b : a));
    results.push({
      target: u.target, title: u.title, sub: u.sub, ref: u.ref,
      count: ranges.length,
      first: { index: first[0], length: first[1] - first[0] },
      snippets: snippets(u.text, ranges),
    });
  }
  return { words, results, total, truncated: total > results.length };
}
