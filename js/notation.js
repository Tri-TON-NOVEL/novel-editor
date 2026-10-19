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

const NAROU_RUBY = /[|｜]([^|｜《》\n]{1,30}?)《([^《》\n]{1,30}?)》/g;
// 縦線なしのなろうルビ（漢字の直後の《》）
const NAROU_RUBY_IMPLICIT = /([一-龠々〆ヵヶ]+)《([^《》\n]{1,30}?)》/g;
const ALPHA_RUBY = /#([^#\n]{1,30}?)__([^_\n]{1,30}?)__#/g;
const NAROU_IMAGE = /<i(\d+)\|(\d+)>/g;
// アルファポリスの別記法の傍点 《《文字》》
const ALPHA_DOTS = /《《([^《》\n]+?)》》/g;

export function toNarou(text) {
  return text
    .replace(ALPHA_DOTS, (_, t) => dots('narou', t))
    .replace(ALPHA_RUBY, (_, b, r) => `|${b}《${r}》`);
}

export function toAlpha(text) {
  return text
    .replace(NAROU_RUBY, (_, b, r) => `#${b}__${r}__#`)
    .replace(NAROU_RUBY_IMPLICIT, (_, b, r) => `#${b}__${r}__#`);
}

// ルビ・傍点の書き方だけを変換（原稿の書き換え用）
export function convertRuby(site, text) {
  return site === 'alpha' ? toAlpha(text) : toNarou(text);
}

// 投稿用に変換（コピー・書き出し用）。アルファポリスでは挿絵タグを目印に置き換える
export function convert(site, text) {
  const t = convertRuby(site, text);
  return site === 'alpha' ? t.replace(NAROU_IMAGE, (_, img) => `【挿絵 i${img}：アルファポリスで画像を挿入】`) : t;
}

export function countImages(text) {
  return (text.match(NAROU_IMAGE) || []).length;
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
  const ep = project.episodes[index] || { title: '' };
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
    body: '『{作品名}』{話数}「{エピソード名}」を更新しました！\n{URL}\n#小説家になろう #web小説',
  },
  {
    id: 'default-narou',
    kind: 'narou',
    name: '更新告知',
    title: '『{作品名}』{話数}を更新しました',
    body: 'いつもお読みいただきありがとうございます。\n\n『{作品名}』{話数}「{エピソード名}」を更新しました。\n{URL}\n\nブックマーク・評価・感想、とても励みになっています。\n今後ともよろしくお願いします。',
  },
  {
    id: 'default-afterword',
    kind: 'afterword',
    name: '評価のお願い',
    title: '',
    body: 'お読みいただきありがとうございます！\n「面白かった」「続きが気になる」と思っていただけたら、\nブックマークや下の☆☆☆☆☆での評価をいただけると励みになります。',
  },
];
