// サイト別モジュールで共通に使う、記法の部品（どのサイトにも属さない小さな処理）

// 変換の注意を種類ごとにまとめる（件数と、例を3つまで）
export function addWarning(warnings, type, message, sample) {
  const w = warnings.find((x) => x.type === type);
  if (w) { w.count++; if (w.samples.length < 3 && sample) w.samples.push(sample); return; }
  warnings.push({ type, message, count: 1, samples: sample ? [sample] : [] });
}

export function sampleOf(text, index, len = 24) {
  return text.slice(Math.max(0, index - 4), index + len).replace(/\n/g, '⏎');
}

// 画像の目印（変換先で画像タグにできないとき）
export const imageMark = (id) => `【ここに画像を挿入：${id}】`;

// みてみんの画像ページ
export function miteminUrl(user, code) {
  return `https://${user}.mitemin.net/i${code}/`;
}

// 傍点をルビ（・）で付ける。空白で区切り、limit 文字ずつに分ける（なろう・アルファ）
export function dotsByRuby(rubyFn, text, limit = 10) {
  return text.replace(/[^\s]+/g, (word) => {
    const chars = [...word];
    let out = '';
    for (let i = 0; i < chars.length; i += limit) {
      const part = chars.slice(i, i + limit);
      out += rubyFn(part.join(''), '・'.repeat(part.length));
    }
    return out;
  });
}

// 記法の正規表現（サイトをまたいで使うもの）
export const NAROU_IMAGE = /<i(\d+)\|(\d+)>/g;
export const MITEMIN_URL = /https?:\/\/(\d+)\.mitemin\.net\/i(\d+)\/?/g;
export const ALPHA_IMAGE = /#__(i_[0-9A-Za-z]+)__#/g;
export const ALPHA_RUBY = /#([^#_\n][^#\n]{0,29}?)__([^_#\n]{1,30}?)__#/g;
// 《《傍点》》（カクヨムの傍点。アルファポリスでも使える）
export const DOUBLE_DOTS = /《《([^《》\n]+?)》》/g;
// |漢字《かんじ》（なろう・カクヨム。カクヨムは対象20字・ルビ50字まで）
export const BAR_RUBY = /[|｜]([^|｜《》\n]{1,30}?)《([^《》\n]{1,50}?)》/g;
// 漢字《かんじ》（縦線なし。漢字だけのとき）
export const KANJI_RUBY = /([一-龠々〆ヵヶ]+)《([^《》\n]{1,50}?)》/g;
// 漢字（かな）の括弧ルビ（なろうでは自動でルビになる）
export const PAREN_RUBY = /[一-龠々〆ヵヶ]+[（(][ぁ-んァ-ヶー・]{1,20}[）)]/g;
// |《（ルビにしない書き方）
export const BAR_ESCAPE = /[|｜](?=《)/g;
