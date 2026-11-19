// 小説家になろう用モジュール（サイト固有の設定と記法）
//   ルビ |漢字《かんじ》（漢字だけなら縦線なしでも可）。対象・ルビとも10文字まで
//   傍点 ルビで代用 |傍点《・・》
//   挿絵 <iコード|ユーザID>（みてみんの画像）
//   前書き・後書きの欄がある。章は1階層。短編は話のタイトルを持たない
// なろう ⇔ アルファポリスの変換は notation.js（既存の処理）、カクヨムとの変換は kakuyomu.js にある。
export default {
  key: 'narou',
  label: '小説家になろう',
  short: 'なろう',
  fields: ['title', 'foreword', 'body', 'afterword'],
  rubyBaseLimit: 10,
  rubyTextLimit: 10,
  images: true,
  headingLevels: 1,
  // 作品情報の欄（作品ごと）
  workFields: [
    { key: 'narouNcode', input: 'work-ncode', label: 'なろうの Nコード' },
    { key: 'narouUrl', input: 'narou-url', label: 'なろうの作品URL' },
  ],
  urlKey: 'narouUrl',
  ruby: (base, reading) => `|${base}《${reading}》`,
  rubyCaretOffset: (base) => 1 + base.length + 1,
  dotsByRuby: true,
  // 話の URL（作品URL＋話数）
  episodeUrl(project, index) {
    const base = (project.narouUrl || '').trim();
    return base ? base.replace(/\/?$/, '/') + (index + 1) + '/' : '';
  },
};
