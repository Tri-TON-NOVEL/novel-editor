// アルファポリス用モジュール（サイト固有の設定と記法）
//   ルビ #漢字__かんじ__#
//   傍点 ルビで代用 #傍点__・・__#（《《傍点》》も読める）
//   挿絵 #__i_xxx__#（サイト上で画像をアップロード）
//   前書き・後書きの欄は使わない。章は1階層
export default {
  key: 'alpha',
  label: 'アルファポリス',
  short: 'アルファ',
  fields: ['title', 'body'],
  rubyBaseLimit: 0, // 0：アプリでは制限しない
  rubyTextLimit: 0,
  images: true,
  headingLevels: 1,
  workFields: [
    { key: 'alphaWorkId', input: 'work-alpha-id', label: 'アルファポリスの作品ID' },
    { key: 'alphaUrl', input: 'alpha-url', label: 'アルファポリスの作品URL' },
  ],
  urlKey: 'alphaUrl',
  ruby: (base, reading) => `#${base}__${reading}__#`,
  rubyCaretOffset: (base) => 1 + base.length + 2,
  dotsByRuby: true,
  episodeUrl: (project) => project.alphaUrl || '',
};
