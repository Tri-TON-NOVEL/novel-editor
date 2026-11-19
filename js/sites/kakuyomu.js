// カクヨム用モジュール（サイト固有の設定・記法・変換・公式バックアップの読み取り）
//
// 記法（公式ヘルプ https://kakuyomu.jp/help/entry/notation で確認）
//   ルビ  |漢字《かんじ》・｜漢字《かんじ》、漢字だけなら 漢字《かんじ》。対象20字・ルビ50字まで
//   傍点  《《傍点》》（ルビと重ねられない。改行をまたげない）
//   《 を文字として出す  ｜《
//   挿絵  公式に記法なし（本文に画像は入れられない）
// 欄    タイトル・本文だけ（前書き・後書きなし。アルファポリスと同じ扱い）
// 章    大見出し・小見出しの2階層（このアプリの「部」「章」）
//
// 公式バックアップ（作品データをダウンロード）の ZIP（2026-11-19 に実ファイル1つで確認。短編・1話・章なし）
//   about.txt         作品情報。【見出し】の次の行から値。「【紹介文（5行）】」「【本文（1,058行）】」のように行数のあるものは、その行数が値
//   episode_0001.txt  話ごと。【タイトル】【公開状態】【作成日時】【公開日時】【更新日時】【文字数】【本文（N行）】
//   文字コード UTF-8、改行 CRLF
//   未確認：章（大見出し・小見出し）がある作品の about.txt【目次】の書き方、複数話のときのファイル番号と掲載順の関係

import {
  addWarning, sampleOf, imageMark, miteminUrl, dotsByRuby,
  NAROU_IMAGE, MITEMIN_URL, ALPHA_IMAGE, ALPHA_RUBY, DOUBLE_DOTS, BAR_RUBY, KANJI_RUBY, PAREN_RUBY, BAR_ESCAPE,
} from './common.js';

const RUBY_BASE_LIMIT = 20;
const RUBY_TEXT_LIMIT = 50;
const NAROU_LIMIT = 10;

const site = {
  key: 'kakuyomu',
  label: 'カクヨム',
  short: 'カクヨム',
  fields: ['title', 'body'],
  rubyBaseLimit: RUBY_BASE_LIMIT,
  rubyTextLimit: RUBY_TEXT_LIMIT,
  images: false,
  headingLevels: 2,
  workFields: [
    { key: 'kakuyomuWorkId', input: 'work-kakuyomu-id', label: 'カクヨムの作品ID' },
    { key: 'kakuyomuUrl', input: 'kakuyomu-url', label: 'カクヨムの作品URL' },
  ],
  urlKey: 'kakuyomuUrl',
  ruby: (base, reading) => `|${base}《${reading}》`,
  rubyCaretOffset: (base) => 1 + base.length + 1,
  dotsByRuby: false,
  // 傍点：《《傍点》》。空白で区切る（改行をまたげないため、空白・改行の前後で分ける）
  dots: (text) => text.replace(/[^\s]+/g, (w) => `《《${w}》》`),
  episodeUrl: (project) => project.kakuyomuUrl || '',
  workUrl: (id) => (/^\d+$/.test(id) ? `https://kakuyomu.jp/works/${id}` : ''),
  workIdOf: (url) => /kakuyomu\.jp\/works\/(\d+)/.exec(url || '')?.[1] || '',
};
export default site;

const narouRuby = (b, r) => `|${b}《${r}》`;
const IMAGE_KEEP = 'カクヨムには挿絵の書き方がないため、画像タグ・画像の URL はそのまま残しました（投稿する前に消してください）';

function warnKeptImages(text, warnings, kinds) {
  if (kinds.includes('narou')) for (const m of text.matchAll(NAROU_IMAGE)) addWarning(warnings, 'image-keep', IMAGE_KEEP, m[0]);
  if (kinds.includes('mitemin')) for (const m of text.matchAll(MITEMIN_URL)) addWarning(warnings, 'image-keep', IMAGE_KEEP, m[0]);
  if (kinds.includes('alpha')) for (const m of text.matchAll(ALPHA_IMAGE)) addWarning(warnings, 'image-keep', IMAGE_KEEP, m[0]);
}

function warnRubyLength(text, warnings, baseLimit, textLimit, message) {
  const check = (m, base, reading) => {
    if ([...base].length > baseLimit || [...reading].length > textLimit) addWarning(warnings, 'ruby-long', message, sampleOf(text, m.index));
  };
  for (const m of text.matchAll(BAR_RUBY)) check(m, m[1], m[2]);
  for (const m of text.matchAll(KANJI_RUBY)) {
    if (/[|｜]$/.test(text.slice(0, m.index))) continue;
    check(m, m[1], m[2]);
  }
}

// 直前で作った傍点どうしがつながっているときは1つにする（10文字ずつに分けたルビの傍点を戻す）
const joinDots = (t) => t.replace(/》》《《/g, '');

// ---------- なろう → カクヨム ----------
// ルビは同じ書き方なのでそのまま。ルビで付けた傍点（|傍点《・・》）は《《傍点》》にする
export function fromNarou(text, warnings) {
  let t = text.replace(/[|｜]([^|｜《》\n]+?)《(・+)》/g, (m, base, dots) => ([...base].length === dots.length ? `《《${base}》》` : m));
  t = joinDots(t);
  for (const m of t.matchAll(PAREN_RUBY)) {
    addWarning(warnings, 'paren-ruby', '「漢字（かな）」はなろうでは自動でルビになりますが、カクヨムではなりません。そのまま残しました', m[0]);
  }
  warnKeptImages(t, warnings, ['narou', 'mitemin', 'alpha']);
  return t;
}

// ---------- カクヨム → なろう ----------
// 《《傍点》》は、なろうのルビの傍点にする。長いルビ（なろうは10文字まで）は警告
export function toNarou(text, warnings) {
  let t = text.replace(ALPHA_IMAGE, (m, id) => {
    addWarning(warnings, 'image', 'アルファポリスの画像タグを「ここに画像を挿入」の目印にしました。なろうでは、みてみんの画像で入れ直してください', m);
    return imageMark(id);
  });
  t = t.replace(MITEMIN_URL, (m, user, code) => `<i${code}|${user}>`);
  t = t.replace(DOUBLE_DOTS, (m, body) => dotsByRuby(narouRuby, body, NAROU_LIMIT));
  warnRubyLength(t, warnings, NAROU_LIMIT, NAROU_LIMIT, `なろうのルビは対象・読みとも${NAROU_LIMIT}文字までです。長いルビはなろうでは表示されません`);
  return t;
}

// ---------- アルファ → カクヨム ----------
// #漢字__かんじ__# → |漢字《かんじ》、#傍点__・・__# → 《《傍点》》。《《傍点》》はそのまま
export function fromAlpha(text, warnings) {
  let t = text.replace(ALPHA_RUBY, (m, base, reading, i, all) => {
    if (/[|｜《》]/.test(base + reading)) {
      addWarning(warnings, 'ruby-unsafe', 'ルビに「|」「《」「》」が含まれるため変換しませんでした（カクヨムでは正しく表示できません）', sampleOf(all, i));
      return m;
    }
    if (/^・+$/.test(reading) && [...reading].length === [...base].length) return `《《${base}》》`;
    return `|${base}《${reading}》`;
  });
  t = joinDots(t);
  warnRubyLength(t, warnings, RUBY_BASE_LIMIT, RUBY_TEXT_LIMIT, `カクヨムのルビは対象${RUBY_BASE_LIMIT}文字・読み${RUBY_TEXT_LIMIT}文字までです。長いルビはカクヨムでは表示されません`);
  warnKeptImages(t, warnings, ['alpha', 'narou', 'mitemin']);
  return t;
}

// ---------- カクヨム → アルファ ----------
// |漢字《かんじ》・漢字《かんじ》 → #漢字__かんじ__#。《《傍点》》はそのまま（アルファポリスでも使える）。
// ｜《（ルビにしない書き方）は、アルファポリスでは要らないので縦線を外す。なろうの挿絵タグは、みてみんの URL にする
export function toAlpha(text, warnings) {
  let t = text.replace(NAROU_IMAGE, (m, code, user) => {
    addWarning(warnings, 'image', 'なろうの挿絵タグを、みてみんの画像ページの URL にしました。アルファポリスで、その画像を入れ直してください（エディターの「画像」一覧から開けます）', m);
    return miteminUrl(user, code);
  });
  const toAlphaRuby = (m, base, reading, i, all) => {
    if (/[#_]/.test(base + reading)) {
      addWarning(warnings, 'ruby-unsafe', 'ルビに「#」「_」が含まれるため変換しませんでした', sampleOf(all, i));
      return m;
    }
    return `#${base}__${reading}__#`;
  };
  t = t.replace(BAR_RUBY, toAlphaRuby);
  t = t.replace(KANJI_RUBY, (m, base, reading, i, all) => (/[|｜]$/.test(all.slice(0, i)) ? m : toAlphaRuby(m, base, reading, i, all)));
  t = t.replace(BAR_ESCAPE, '');
  return t;
}

// ---------- 公式バックアップ（ZIP）の読み取り ----------

// 【見出し】で区切られた文章を読む。戻り値：Map（見出し → 行の配列）
export function parseSections(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r\n|\r|\n/);
  const fields = new Map();
  let i = 0;
  while (i < lines.length) {
    const m = /^【(.+?)】\s*$/.exec(lines[i]);
    if (!m) { i++; continue; }
    let label = m[1];
    let count = null;
    const c = /^(.*?)（([\d,]+)行）$/.exec(label);
    if (c) { label = c[1]; count = Number(c[2].replace(/,/g, '')); }
    i++;
    let value;
    if (count !== null) {
      value = lines.slice(i, i + count);
      i += count;
    } else {
      value = [];
      while (i < lines.length && !/^【.+?】\s*$/.test(lines[i])) value.push(lines[i++]);
      while (value.length && !value.at(-1).trim()) value.pop();
    }
    if (!fields.has(label)) fields.set(label, value);
  }
  return fields;
}

const one = (fields, label) => (fields.get(label) || []).join('\n').trim();
const list = (fields, label) => (fields.get(label) || []).map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);

// ZIP の中のファイルがカクヨムのバックアップに見えるか（about.txt と episode_NNNN.txt）
export function looksLikeBackup(names) {
  const base = names.map((n) => n.replace(/^.*\//, ''));
  return base.includes('about.txt') && base.some((n) => /^episode_\d+\.txt$/i.test(n));
}

/**
 * カクヨムのバックアップの中身を読む。files：[{ name, text }]（ZIP の中のテキストファイル）
 * 戻り値：{ title, catchphrase, synopsis, tags, info: [[見出し, 値]], episodes: [{ file, no, title, body, status }], tocOther: [], warnings: [] }
 */
export function parseBackup(files) {
  const warnings = [];
  const byBase = new Map(files.map((f) => [f.name.replace(/^.*\//, ''), f]));
  const about = byBase.get('about.txt');
  if (!about) throw new Error('about.txt がありません。カクヨムの「作品データをダウンロード」で作った ZIP を選んでください');
  const a = parseSections(about.text);
  const episodes = [];
  for (const [name, f] of byBase) {
    const m = /^episode_(\d+)\.txt$/i.exec(name);
    if (!m) continue;
    const e = parseSections(f.text);
    if (!e.has('本文')) warnings.push(`${name}：【本文】が見つかりません`);
    episodes.push({ file: name, no: Number(m[1]), title: one(e, 'タイトル'), body: (e.get('本文') || []).join('\n'), status: one(e, '公開状態') });
  }
  episodes.sort((x, y) => x.no - y.no);
  const others = [...byBase.keys()].filter((n) => n !== 'about.txt' && !/^episode_\d+\.txt$/i.test(n));
  if (others.length) warnings.push(`読まなかったファイル：${others.join('、')}`);
  // 目次：「1. タイトル」の行（確認できた書き方）。それ以外の行（章の見出しかもしれない）は読まずに知らせる
  const toc = [];
  const tocOther = [];
  for (const line of a.get('目次') || []) {
    if (!line.trim()) continue;
    const m = /^\s*(\d+)\.\s*(.*)$/.exec(line);
    if (m) toc.push({ no: Number(m[1]), title: m[2].trim() }); else tocOther.push(line.trim());
  }
  if (tocOther.length) warnings.push(`目次に、話ではない行が ${tocOther.length}行あります（章の見出しかもしれません。この書き方はまだ確認できていないため、章としては取り込みません）`);
  if (toc.length && (toc.length !== episodes.length || toc.some((t, i) => episodes[i] && t.title !== episodes[i].title))) {
    warnings.push('目次の話の並びと、話のファイルの番号順が一致しません。ファイルの番号順で取り込みます');
  }
  const info = ['作者名', '連載状態', 'ジャンル', 'セルフレイティング', '公開日時', '更新日時']
    .map((k) => [k, (a.get(k) || []).map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean).join('・')])
    .filter(([, v]) => v);
  return {
    title: one(a, 'タイトル'),
    catchphrase: one(a, 'キャッチコピー'),
    synopsis: (a.get('紹介文') || []).join('\n').replace(/\s+$/, ''),
    tags: list(a, 'タグ'),
    info,
    episodes,
    tocOther,
    warnings,
  };
}
