// 投稿サイトごとの記法（サイト固有の設定は js/sites/ の各モジュール。ここはサイトを選んで呼び分ける窓口）
//   なろう       ルビ |漢字《かんじ》   傍点 |傍点《・・》    挿絵 <iコード|ユーザID>（みてみんの画像）
//   カクヨム     ルビ |漢字《かんじ》   傍点 《《傍点》》     挿絵 なし
//   アルファポリス ルビ #漢字__かんじ__#  傍点 #傍点__・・__#  挿絵 サイト上で画像をアップロード
// なろうのルビは対象・ルビとも10文字まで。
import { SITES } from './sites/index.js';
import * as kakuyomu from './sites/kakuyomu.js';
import { addWarning, sampleOf, imageMark, miteminUrl, dotsByRuby } from './sites/common.js';
export { SITES, imageMark, miteminUrl };

export const RUBY_LIMIT = 10;

export function ruby(site, base, reading) {
  return (SITES[site] || SITES.narou).ruby(base, reading);
}

// 傍点は、文字数分の「・」をルビとして振る。空白で区切り、10文字ずつに分ける
export function dots(site, text) {
  const s = SITES[site] || SITES.narou;
  return s.dots ? s.dots(text) : dotsByRuby(s.ruby, text, RUBY_LIMIT);
}

// 自動字下げ：段落の先頭に全角スペースを1つ入れる
// （空行、すでに全角スペースで始まる行、かぎかっこ等で始まる行、挿絵だけの行は除く）
export function autoIndent(text) {
  return text.split('\n').map((line) => {
    if (!line.trim() || /^[　「『（(【〈《〔“"―…]/.test(line) || /^<i\d+\|\d+>\s*$/.test(line)) return line;
    return '　' + line.replace(/^ +/, '');
  }).join('\n');
}

export const SYMBOLS = ['……', '――', '！？', '！！', '？？', '「」', '『』', '（）', '【】', '・', '〜', '♪', '☆', '※'];

// ルビ入力後にカーソルを置く位置（読みを入力する場所）。挿入文字列の先頭からの文字数
export function rubyCaretOffset(site, base) {
  return (SITES[site] || SITES.narou).rubyCaretOffset(base);
}

// ---------- なろう ⇔ アルファポリスの変換（純粋関数。tests/tests.js でテスト） ----------
//
// なろう → アルファ
//   ルビ       |漢字《かんじ》・｜漢字《かんじ》・漢字《かんじ》（縦線なし） → #漢字__かんじ__#
//   傍点       |傍点《・・》 → #傍点__・・__#（ルビと同じ規則）
//   画像       <i1234568|12345> → https://12345.mitemin.net/i1234568/（みてみんの画像ページ。アルファでその画像を入れ直す）
//   変換しない  漢字（かんじ）の括弧ルビ（なろうの自動ルビかどうか判別できない）、|《 のエスケープ → 原文のまま警告
// アルファ → なろう
//   ルビ       #漢字__かんじ__# → |漢字《かんじ》（10文字を超えると、なろうではルビにならないので警告）
//   傍点       《《傍点》》 → |傍点《・・》
//   画像       #__i_dd9a42ad__# → 【ここに画像を挿入：i_dd9a42ad】
//              みてみんの URL https://12345.mitemin.net/i1234568/ → <i1234568|12345>（なろうの挿絵タグに戻す）
// 変換先の記法で書かれているものはそのまま（2回変換しても増えない）。

const NAROU_IMAGE = /<i(\d+)\|(\d+)>/g;
const ALPHA_IMAGE = /#__(i_[0-9A-Za-z]+)__#/g;
const NAROU_RUBY = /[|｜]([^|｜《》\n]{1,30}?)《([^《》\n]{1,30}?)》/g;
const NAROU_RUBY_IMPLICIT = /([一-龠々〆ヵヶ]+)《([^《》\n]{1,30}?)》/g;
const NAROU_PAREN_RUBY = /[一-龠々〆ヵヶ]+[（(][ぁ-んァ-ヶー・]{1,20}[）)]/g;
const NAROU_ESCAPE = /[|｜](?=《)/g;
const ALPHA_RUBY = /#([^#_\n][^#\n]{0,29}?)__([^_#\n]{1,30}?)__#/g;
const ALPHA_DOTS = /《《([^《》\n]+?)》》/g;

function narouToAlpha(text, warnings) {
  let t = text.replace(NAROU_IMAGE, (m, code, user) => {
    addWarning(warnings, 'image', 'なろうの挿絵タグを、みてみんの画像ページの URL にしました。アルファポリスで、その画像を入れ直してください（エディターの「画像」一覧から開けます）', `<i${code}|${user}>`);
    return miteminUrl(user, code);
  });
  for (const m of t.matchAll(NAROU_ESCAPE)) addWarning(warnings, 'escape', '「|《」（ルビにしない書き方）はアルファポリスに同じ書き方がないため、そのまま残しました', sampleOf(t, m.index));
  t = t.replace(NAROU_RUBY, (m, base, reading, i, all) => {
    if (/[#_]/.test(base + reading)) {
      addWarning(warnings, 'ruby-unsafe', 'ルビに「#」「_」が含まれるため変換しませんでした', sampleOf(all, i));
      return m;
    }
    return `#${base}__${reading}__#`;
  });
  t = t.replace(NAROU_RUBY_IMPLICIT, (m, base, reading, i, all) => {
    // 直前が | ならルビにしない書き方（エスケープ）なので触らない
    if (/[|｜]$/.test(all.slice(0, i))) return m;
    return `#${base}__${reading}__#`;
  });
  for (const m of t.matchAll(NAROU_PAREN_RUBY)) {
    addWarning(warnings, 'paren-ruby', '「漢字（かな）」はなろうでは自動でルビになりますが、ただの括弧か判別できないためそのまま残しました', m[0]);
  }
  return t;
}

function alphaToNarou(text, warnings, opts = {}) {
  // keepImages：画像タグはそのまま残す（アルファの文章をなろう用の本文へ貼り付けたとき）
  let t = opts.keepImages ? text : text.replace(ALPHA_IMAGE, (m, id) => {
    addWarning(warnings, 'image', 'アルファポリスの画像タグを「ここに画像を挿入」の目印にしました。なろうでは、みてみんの画像で入れ直してください', m);
    return imageMark(id);
  });
  // みてみんの画像ページの URL は、なろうの挿絵タグに戻す
  t = t.replace(MITEMIN_URL, (m, user, code) => `<i${code}|${user}>`);
  t = t.replace(ALPHA_DOTS, (m, body) => dots('narou', body));
  t = t.replace(ALPHA_RUBY, (m, base, reading, i, all) => {
    // なろうの記号（| 《 》）が入ったルビは、なろうで正しく表示できないので変換しない
    if (/[|｜《》]/.test(base + reading)) {
      addWarning(warnings, 'ruby-unsafe', 'ルビに「|」「《」「》」が含まれるため変換しませんでした（なろうでは正しく表示できません）', sampleOf(all, i));
      return m;
    }
    if ([...base].length > RUBY_LIMIT || [...reading].length > RUBY_LIMIT) {
      addWarning(warnings, 'ruby-long', `なろうのルビは対象・読みとも${RUBY_LIMIT}文字までです。長いルビはなろうでは表示されません`, sampleOf(all, i));
    }
    return `|${base}《${reading}》`;
  });
  return t;
}

/**
 * from の記法で書かれた文章を to の記法へ変換する。変換できないものは原文のまま残し、warnings に入れる。
 * opts.keepImages（アルファ → なろうのとき）：アルファの画像タグを目印にせず、そのまま残す。
 * @returns {{ text: string, warnings: { type, message, count, samples }[] }}
 */
export function convertText(from, to, text, opts = {}) {
  const warnings = [];
  if (!text || from === to) return { text: text || '', warnings };
  let out;
  if (from === 'kakuyomu') out = to === 'alpha' ? kakuyomu.toAlpha(text, warnings) : kakuyomu.toNarou(text, warnings);
  else if (to === 'kakuyomu') out = from === 'alpha' ? kakuyomu.fromAlpha(text, warnings) : kakuyomu.fromNarou(text, warnings);
  else out = to === 'alpha' ? narouToAlpha(text, warnings) : alphaToNarou(text, warnings, opts);
  return { text: out, warnings };
}

export function toNarou(text) { return convertText('alpha', 'narou', text).text; }
export function toAlpha(text) { return convertText('narou', 'alpha', text).text; }

// 旧版との互換：その投稿先の書き方にする
// カクヨムは、まぎれこんだアルファポリスの書き方だけを直す（《《傍点》》・ルビはそのまま。0.97）
export function convertRuby(site, text) {
  if (site === 'kakuyomu') return convertText('alpha', 'kakuyomu', text).text;
  return site === 'alpha' ? toAlpha(text) : toNarou(text);
}
export function convert(site, text) {
  return convertRuby(site, text);
}

export function countImages(text) {
  return findImages(text || '').length;
}

// みてみんの画像ページURL → なろうの挿絵タグ
//   https://12345.mitemin.net/i1234569/  →  <i1234569|12345>
const MITEMIN_URL = /https?:\/\/(\d+)\.mitemin\.net\/i(\d+)\/?/g;

/**
 * 文章の中の画像を探す（なろうの挿絵タグ・みてみんの URL・アルファポリスの画像タグ）。
 * 戻り値: [{ kind: 'narou'|'mitemin'|'alpha', text（見つかった文字列）, index, line（1から）, user, code, url（開けるときだけ） }]
 */
export function findImages(text) {
  const out = [];
  const lineOf = (i) => text.slice(0, i).split('\n').length;
  for (const m of text.matchAll(NAROU_IMAGE)) {
    out.push({ kind: 'narou', text: m[0], index: m.index, line: lineOf(m.index), code: m[1], user: m[2], url: miteminUrl(m[2], m[1]) });
  }
  for (const m of text.matchAll(MITEMIN_URL)) {
    out.push({ kind: 'mitemin', text: m[0], index: m.index, line: lineOf(m.index), user: m[1], code: m[2], url: miteminUrl(m[1], m[2]) });
  }
  for (const m of text.matchAll(ALPHA_IMAGE)) {
    out.push({ kind: 'alpha', text: m[0], index: m.index, line: lineOf(m.index), code: m[1], url: '' });
  }
  return out.sort((a, b) => a.index - b.index);
}

export function miteminToTag(text) {
  return text.replace(MITEMIN_URL, (_, user, img) => `<i${img}|${user}>`);
}

export function hasMiteminUrl(text) {
  MITEMIN_URL.lastIndex = 0;
  return MITEMIN_URL.test(text);
}

// X の文字数（全角は2、半角は1、URLは23として数える。上限280＝全角140字）
const X_URL = /https?:\/\/[^\s]+/g;
export function xLength(text) {
  let n = 0;
  const rest = text.replace(X_URL, () => { n += 23; return ''; });
  for (const ch of rest) {
    const c = ch.codePointAt(0);
    const light = c <= 0x10ff || (c >= 0x2000 && c <= 0x200d) || (c >= 0x2010 && c <= 0x201f) || (c >= 0x2032 && c <= 0x2037);
    n += light ? 1 : 2;
  }
  return n;
}

// ひな型の差し込み
export const TEMPLATE_VARS = ['{作品名}', '{話数}', '{エピソード名}', '{URL}', '{なろうURL}', '{アルファURL}', '{カクヨムURL}', '{日付}'];

export function episodeUrl(project, index, site) {
  return (SITES[site] || SITES.narou).episodeUrl(project, index);
}

export function fillTemplate(text, project, index) {
  const e = project.episodes[index];
  // サイト別原稿のメイン側のタイトル（旧形式の title にも対応）
  const ep = { title: e?.drafts?.[project.site]?.title ?? e?.title ?? '' };
  const narou = episodeUrl(project, index, 'narou');
  const alpha = episodeUrl(project, index, 'alpha');
  const kakuyomu = episodeUrl(project, index, 'kakuyomu');
  const main = episodeUrl(project, index, project.site);
  const values = {
    '{作品名}': project.title || '',
    '{話数}': `第${index + 1}話`,
    '{エピソード名}': ep.title || '',
    '{URL}': main || narou || kakuyomu || alpha,
    '{なろうURL}': narou,
    '{アルファURL}': alpha,
    '{カクヨムURL}': kakuyomu,
    '{日付}': new Date().toLocaleDateString('ja-JP'),
  };
  return text.replace(/\{[^{}\n]+\}/g, (m) => (m in values ? values[m] : m));
}

export const DEFAULT_TEMPLATES = [
  {
    id: 'default-x',
    kind: 'x',
    name: '更新告知',
    title: '',
    body: '『{作品名}』「{エピソード名}」を更新しました！\n{URL}\n#小説家になろう #web小説',
  },
  {
    id: 'default-narou',
    kind: 'narou',
    name: '更新告知',
    title: '『{作品名}』「{エピソード名}」を更新しました',
    body: 'いつもお読みいただきありがとうございます。\n\n『{作品名}』「{エピソード名}」を更新しました。\n{URL}\n\nブックマーク・評価・感想、とても励みになっています。\n今後ともよろしくお願いします。',
  },
  {
    id: 'default-foreword',
    kind: 'foreword',
    name: 'ごあいさつ',
    title: '',
    body: 'いつもお読みいただきありがとうございます。\n{話数}「{エピソード名}」をお届けします。',
  },
  {
    id: 'default-afterword',
    kind: 'afterword',
    name: '評価のお願い',
    title: '',
    body: 'お読みいただきありがとうございます！\n「面白かった」「続きが気になる」と思っていただけたら、\nブックマークや下の☆☆☆☆☆での評価をいただけると励みになります。',
  },
];

// ---------- アルファポリスの書き方が入っているか（なろう用の本文へ貼り付けたときに変換する） ----------
// 戻り値：ルビ・傍点の数（0 ならアルファの書き方はない）
export function countAlphaNotation(text) {
  if (!text) return 0;
  return [...text.matchAll(ALPHA_RUBY)].length + [...text.matchAll(ALPHA_DOTS)].length;
}
export function countAlphaImages(text) {
  return text ? [...text.matchAll(ALPHA_IMAGE)].length : 0;
}

// ---------- 本文の中の画像の書き方の範囲（入力欄で色を付ける） ----------
// なろうの挿絵タグ・みてみんの URL・アルファの画像タグ・「ここに画像を挿入」の目印。[開始, 終わり] の並び（重なりなし）
const IMAGE_MARK = /【ここに画像を挿入：[^】\n]*】/g;
export function imageRanges(text) {
  if (!text) return [];
  const all = findImages(text).map((i) => [i.index, i.index + i.text.length]);
  for (const m of text.matchAll(IMAGE_MARK)) all.push([m.index, m.index + m[0].length]);
  all.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const out = [];
  for (const r of all) if (!out.length || r[0] >= out.at(-1)[1]) out.push(r);
  return out;
}
