// 投稿サイトごとの記法
//   なろう       ルビ |漢字《かんじ》   傍点 |傍点《・・》    挿絵 <iコード|ユーザID>（みてみんの画像）
//   アルファポリス ルビ #漢字__かんじ__#  傍点 #傍点__・・__#  挿絵 サイト上で画像をアップロード
// なろうのルビは対象・ルビとも10文字まで。
export const SITES = {
  narou: { label: '小説家になろう', short: 'なろう' },
  alpha: { label: 'アルファポリス', short: 'アルファ' },
};

export const RUBY_LIMIT = 10;

export function ruby(site, base, reading) {
  return site === 'alpha' ? `#${base}__${reading}__#` : `|${base}《${reading}》`;
}

// 傍点は、文字数分の「・」をルビとして振る。空白で区切り、10文字ずつに分ける
export function dots(site, text) {
  return text.replace(/[^\s]+/g, (word) => {
    const chars = [...word];
    let out = '';
    for (let i = 0; i < chars.length; i += RUBY_LIMIT) {
      const part = chars.slice(i, i + RUBY_LIMIT);
      out += ruby(site, part.join(''), '・'.repeat(part.length));
    }
    return out;
  });
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
  return site === 'alpha' ? 1 + base.length + 2 : 1 + base.length + 1;
}

// ---------- なろう ⇔ アルファポリスの変換（純粋関数。tests/tests.js でテスト） ----------
//
// なろう → アルファ
//   ルビ       |漢字《かんじ》・｜漢字《かんじ》・漢字《かんじ》（縦線なし） → #漢字__かんじ__#
//   傍点       |傍点《・・》 → #傍点__・・__#（ルビと同じ規則）
//   画像       <i1149346|50921> → 【ここに画像を挿入：i1149346】
//   変換しない  漢字（かんじ）の括弧ルビ（なろうの自動ルビかどうか判別できない）、|《 のエスケープ → 原文のまま警告
// アルファ → なろう
//   ルビ       #漢字__かんじ__# → |漢字《かんじ》（10文字を超えると、なろうではルビにならないので警告）
//   傍点       《《傍点》》 → |傍点《・・》
//   画像       #__i_dd9a42ad__# → 【ここに画像を挿入：i_dd9a42ad】
// 変換先の記法で書かれているものはそのまま（2回変換しても増えない）。

const NAROU_IMAGE = /<i(\d+)\|(\d+)>/g;
const ALPHA_IMAGE = /#__(i_[0-9A-Za-z]+)__#/g;
const NAROU_RUBY = /[|｜]([^|｜《》\n]{1,30}?)《([^《》\n]{1,30}?)》/g;
const NAROU_RUBY_IMPLICIT = /([一-龠々〆ヵヶ]+)《([^《》\n]{1,30}?)》/g;
const NAROU_PAREN_RUBY = /[一-龠々〆ヵヶ]+[（(][ぁ-んァ-ヶー・]{1,20}[）)]/g;
const NAROU_ESCAPE = /[|｜](?=《)/g;
const ALPHA_RUBY = /#([^#_\n][^#\n]{0,29}?)__([^_#\n]{1,30}?)__#/g;
const ALPHA_DOTS = /《《([^《》\n]+?)》》/g;

export const imageMark = (id) => `【ここに画像を挿入：${id}】`;

function sampleOf(text, index, len = 24) {
  return text.slice(Math.max(0, index - 4), index + len).replace(/\n/g, '⏎');
}

function addWarning(warnings, type, message, sample) {
  const w = warnings.find((x) => x.type === type);
  if (w) { w.count++; if (w.samples.length < 3 && sample) w.samples.push(sample); return; }
  warnings.push({ type, message, count: 1, samples: sample ? [sample] : [] });
}

function narouToAlpha(text, warnings) {
  let t = text.replace(NAROU_IMAGE, (m, code, user) => {
    addWarning(warnings, 'image', '画像タグを「ここに画像を挿入」の目印にしました。アルファポリスで画像を入れ直してください', `<i${code}|${user}>`);
    return imageMark('i' + code);
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

function alphaToNarou(text, warnings) {
  let t = text.replace(ALPHA_IMAGE, (m, id) => {
    addWarning(warnings, 'image', '画像タグを「ここに画像を挿入」の目印にしました。なろうでは、みてみんの画像で入れ直してください', m);
    return imageMark(id);
  });
  t = t.replace(ALPHA_DOTS, (m, body) => dots('narou', body));
  t = t.replace(ALPHA_RUBY, (m, base, reading, i, all) => {
    if ([...base].length > RUBY_LIMIT || [...reading].length > RUBY_LIMIT) {
      addWarning(warnings, 'ruby-long', `なろうのルビは対象・読みとも${RUBY_LIMIT}文字までです。長いルビはなろうでは表示されません`, sampleOf(all, i));
    }
    return `|${base}《${reading}》`;
  });
  return t;
}

/**
 * from の記法で書かれた文章を to の記法へ変換する。変換できないものは原文のまま残し、warnings に入れる。
 * @returns {{ text: string, warnings: { type, message, count, samples }[] }}
 */
export function convertText(from, to, text) {
  const warnings = [];
  if (!text || from === to) return { text: text || '', warnings };
  const out = to === 'alpha' ? narouToAlpha(text, warnings) : alphaToNarou(text, warnings);
  return { text: out, warnings };
}

export function toNarou(text) { return convertText('alpha', 'narou', text).text; }
export function toAlpha(text) { return convertText('narou', 'alpha', text).text; }

// 旧版との互換：その投稿先の書き方にする
export function convertRuby(site, text) {
  return site === 'alpha' ? toAlpha(text) : toNarou(text);
}
export function convert(site, text) {
  return convertRuby(site, text);
}

export function countImages(text) {
  return (text.match(NAROU_IMAGE) || []).length + (text.match(ALPHA_IMAGE) || []).length;
}

// みてみんの画像ページURL → なろうの挿絵タグ
//   https://50921.mitemin.net/i1149234/  →  <i1149234|50921>
const MITEMIN_URL = /https?:\/\/(\d+)\.mitemin\.net\/i(\d+)\/?/g;

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
export const TEMPLATE_VARS = ['{作品名}', '{話数}', '{エピソード名}', '{URL}', '{なろうURL}', '{アルファURL}', '{日付}'];

export function episodeUrl(project, index, site) {
  if (site === 'alpha') return project.alphaUrl || '';
  const base = (project.narouUrl || '').trim();
  if (!base) return '';
  return base.replace(/\/?$/, '/') + (index + 1) + '/';
}

export function fillTemplate(text, project, index) {
  const e = project.episodes[index];
  // サイト別原稿のメイン側のタイトル（旧形式の title にも対応）
  const ep = { title: e?.drafts?.[project.site]?.title ?? e?.title ?? '' };
  const narou = episodeUrl(project, index, 'narou');
  const alpha = episodeUrl(project, index, 'alpha');
  const values = {
    '{作品名}': project.title || '',
    '{話数}': `第${index + 1}話`,
    '{エピソード名}': ep.title || '',
    '{URL}': (project.site === 'alpha' ? alpha : narou) || narou || alpha,
    '{なろうURL}': narou,
    '{アルファURL}': alpha,
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
    id: 'default-afterword',
    kind: 'afterword',
    name: '評価のお願い',
    title: '',
    body: 'お読みいただきありがとうございます！\n「面白かった」「続きが気になる」と思っていただけたら、\nブックマークや下の☆☆☆☆☆での評価をいただけると励みになります。',
  },
];
