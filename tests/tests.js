// 小説エディターの自動テスト（ブラウザで tests/index.html を開くと実行される）
import * as F from '../js/format.js';
import * as N from '../js/notation.js';
import * as I from '../js/importer.js';

const results = [];
const groups = [];
function group(name, fn) { groups.push([name, fn]); }

function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || '一致しません'}\n  期待: ${e}\n  実際: ${a}`);
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '条件を満たしません'); }
function throws(fn, pattern, msg) {
  try { fn(); } catch (e) {
    if (pattern && !pattern.test(e.message)) throw new Error(`${msg || '別のエラー'}: ${e.message}`);
    return;
  }
  throw new Error(msg || 'エラーになりませんでした');
}

// ---------- Phase 1: データ形式 v3 と旧データの移行 ----------

const oldV2 = (site = 'narou') => ({
  title: '旧作品', site, synopsis: 'あらすじ', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  episodes: [
    { id: 'e1', title: '第1話 出会い', foreword: '前書き', body: '|漢字《かんじ》本文<i1|2>', afterword: '後書き', plot: 'プロット1' },
    { id: 'e2', title: '第2話', body: '二話', plot: '' },
  ],
  chapters: [{ id: 'c1', title: '第一章', plot: '章プロット' }],
  futureField: { keep: true },
});

group('Phase 1：旧 JSON（v2）の移行', () => {
  for (const site of ['narou', 'alpha']) {
    const p = F.normalize(oldV2(site));
    const other = site === 'narou' ? 'alpha' : 'narou';
    eq(p.episodes[0].drafts[site], { title: '第1話 出会い', foreword: '前書き', body: '|漢字《かんじ》本文<i1|2>', afterword: '後書き' }, `${site}: メイン側に原稿が入る`);
    eq(p.episodes[0].drafts[other], F.emptyDraft(), `${site}: もう一方は空`);
    eq(p.episodes[0].plot, 'プロット1', 'プロットはそのまま');
    eq(p.episodes[0].freeMemo, '', 'フリーメモは空');
    eq(p.episodes[0].chapterId, null, '章は未分類');
    ok(!('body' in p.episodes[0]) && !('title' in p.episodes[0]), '旧フィールドは残らない');
  }
});

group('Phase 1：未知のフィールド・章・順番を保持', () => {
  const src = oldV2();
  src.episodes[0].customEp = 123;
  const p = F.normalize(src);
  eq(p.futureField, { keep: true }, '作品の未知フィールド');
  eq(p.episodes[0].customEp, 123, 'エピソードの未知フィールド');
  eq(p.chapters.map((c) => [c.id, c.title, c.plot]), [['c1', '第一章', '章プロット']], '章');
  ok(p.workId, 'workId が付く');
  const sorted = F.normalize({ ...src, episodes: [{ id: 'b', order: 1 }, { id: 'a', order: 0 }] });
  eq(sorted.episodes.map((e) => e.id), ['a', 'b'], 'order の順に並ぶ');
  const badChapter = F.normalize({ ...src, episodes: [{ id: 'x', chapterId: 'nothing', drafts: {} }] });
  eq(badChapter.episodes[0].chapterId, null, '存在しない章は未分類');
});

group('Phase 1：移行は何度行っても同じ（元データを変更しない）', () => {
  const src = oldV2();
  const before = JSON.stringify(src);
  const once = F.normalize(src);
  const twice = F.normalize(once);
  eq(JSON.stringify(src), before, '元のオブジェクトは変わらない');
  eq(twice.episodes.map((e) => e.drafts), once.episodes.map((e) => e.drafts), '2回目も同じ');
});

group('Phase 1：保存 → 読込の往復', () => {
  const p = F.normalize(oldV2('alpha'));
  p.id = 'local'; p.links = { gdrive: 'x' };
  const text = F.serialize(p);
  const o = JSON.parse(text);
  eq([o.format, o.version, o.schemaVersion], ['novel-editor', 3, 3], 'ヘッダー');
  ok(!('id' in o.project) && !('links' in o.project), '端末ローカルの値は書かない');
  eq(o.project.episodes.map((e) => e.order), [0, 1], 'order を書く');
  const back = F.parse(text, '作品.json');
  eq(back.episodes.map((e) => e.drafts), p.episodes.map((e) => e.drafts), '原稿が一致');
  eq(back.workId, p.workId, 'workId が一致');
  eq(back.chapters.map((c) => c.title), p.chapters.map((c) => c.title), '章が一致');
});

group('Phase 1：v1 とテキストの読込', () => {
  const v1 = F.parse(JSON.stringify({ format: 'novel-editor', title: 'T', body: '本文', plot: 'P' }), 'a.json');
  eq([v1.title, v1.episodes[0].drafts.narou.body, v1.episodes[0].plot], ['T', '本文', 'P'], 'v1');
  const txt = F.parse('ただの文章', 'メモ.txt');
  eq([txt.title, txt.episodes[0].drafts.narou.body], ['メモ', 'ただの文章'], 'txt');
});

group('Phase 1：壊れた JSON・新しすぎる JSON は読み込まない', () => {
  throws(() => F.parse('{ 壊れた', '作品.json'), /JSON として読めません/, '壊れた JSON');
  throws(() => F.parse(JSON.stringify({ a: 1 }), '他.json'), /作品ファイルではありません/, '別形式');
  throws(() => F.parse(JSON.stringify({ format: 'novel-editor', schemaVersion: 99, project: {} }), 'x.json'), /新しい版/, '新しい版');
});

group('Phase 1：100話以上の作品', () => {
  const src = { title: '長編', site: 'narou', episodes: Array.from({ length: 150 }, (_, i) => ({ id: 'e' + i, title: `第${i + 1}話`, body: 'あ'.repeat(5000) })) };
  const t0 = performance.now();
  const p = F.normalize(src);
  const back = F.parse(F.serialize({ ...p, id: 'x', links: {} }), 'long.json');
  const ms = performance.now() - t0;
  eq(back.episodes.length, 150, '150話');
  eq(back.episodes[149].drafts.narou.title, '第150話', '最後の話');
  ok(ms < 2000, `処理時間 ${Math.round(ms)}ms`);
});

group('Phase 1：エピソード名', () => {
  const ep = F.newEpisode({ drafts: { narou: { ...F.emptyDraft(), title: 'な' }, alpha: { ...F.emptyDraft(), title: 'ア' } } });
  eq(F.episodeName(ep, 'narou'), 'な');
  eq(F.episodeName(ep, 'alpha'), 'ア');
  const onlyAlpha = F.newEpisode({ drafts: { narou: F.emptyDraft(), alpha: { ...F.emptyDraft(), title: 'ア' } } });
  eq(F.episodeName(onlyAlpha, 'narou'), 'ア', 'メインが空ならもう一方');
  eq(F.episodeName(F.newEpisode(), 'narou'), '（無題）');
});

// ---------- Phase 6: ルビ・傍点・画像タグの変換 ----------

const c = (from, to, text) => N.convertText(from, to, text);
const types = (r) => r.warnings.map((w) => `${w.type}:${w.count}`);

group('Phase 6：なろう → アルファ（ルビ）', () => {
  eq(c('narou', 'alpha', '|暁神天翔《あかつきがみ あまと》').text, '#暁神天翔__あかつきがみ あまと__#', '仕様書の例');
  eq(c('narou', 'alpha', '｜漢字《かんじ》と|魔法《まほう》').text, '#漢字__かんじ__#と#魔法__まほう__#', '全角・半角の縦線');
  eq(c('narou', 'alpha', '漢字《かんじ》').text, '#漢字__かんじ__#', '縦線なし（漢字の直後）');
  eq(c('narou', 'alpha', '|傍点《・・》').text, '#傍点__・・__#', '傍点');
});

group('Phase 6：アルファ → なろう（ルビ・傍点）', () => {
  eq(c('alpha', 'narou', '#宇宙__そら__#を見る').text, '|宇宙《そら》を見る', 'ルビ');
  eq(c('alpha', 'narou', '《《ここ》》が大事').text, '|ここ《・・》が大事', '《《》》の傍点');
  eq(c('alpha', 'narou', '|漢字《かんじ》').text, '|漢字《かんじ》', 'アルファでも使えるなろう記法はそのまま');
  const long = c('alpha', 'narou', '#とても長いルビの対象文字列__とてもながいるびのたいしょうもじれつ__#');
  eq(types(long), ['ruby-long:1'], '10文字を超えると警告');
});

group('Phase 6：往復・二重変換で記法が増えない', () => {
  const src = '彼は|漢字《かんじ》を|傍点《・・》で書いた。';
  const a = c('narou', 'alpha', src).text;
  eq(c('narou', 'alpha', a).text, a, 'なろう→アルファを2回');
  eq(c('alpha', 'narou', a).text, src, 'アルファ→なろうで元に戻る');
  const n = c('alpha', 'narou', src).text;
  eq(n, src, 'なろう記法をアルファ→なろうに通しても変わらない');
});

group('Phase 6：紛らわしい文字列は変換しない', () => {
  const normal = '『題名』《書名》〈注〉#ハッシュタグ __強調__ <b>太字</b> 20%';
  eq(c('narou', 'alpha', normal).text, normal, 'なろう→アルファ');
  eq(c('alpha', 'narou', normal).text, normal, 'アルファ→なろう');
  eq(c('alpha', 'narou', '#小説家になろう #web小説').text, '#小説家になろう #web小説', 'ハッシュタグ');
  const esc = c('narou', 'alpha', '山田|《二重山括弧のまま》');
  eq(esc.text, '山田|《二重山括弧のまま》', 'エスケープは原文のまま');
  eq(types(esc), ['escape:1'], 'エスケープは警告');
  const paren = c('narou', 'alpha', '漢字（かんじ）と普通の（括弧）');
  eq(paren.text, '漢字（かんじ）と普通の（括弧）', '括弧ルビは原文のまま');
  eq(types(paren), ['paren-ruby:1'], '括弧ルビは警告');
});

group('Phase 6：画像タグ', () => {
  const n = c('narou', 'alpha', '前<i1285249|50921>中<i1285249|50921>後');
  eq(n.text, '前https://50921.mitemin.net/i1285249/中https://50921.mitemin.net/i1285249/後', 'なろう→アルファ：みてみんの URL（同じタグ2つとも位置を保つ）');
  eq(types(n), ['image:2'], '画像の警告');
  eq(c('alpha', 'narou', n.text).text, '前<i1285249|50921>中<i1285249|50921>後', 'みてみんの URL はなろうの挿絵タグに戻る（往復）');
  const a = c('alpha', 'narou', 'ここ#__i_dd9a42ad__#です');
  eq(a.text, 'ここ【ここに画像を挿入：i_dd9a42ad】です', 'アルファの画像タグ→なろう');
  eq(N.countImages('<i1|2>#__i_ab__#https://3.mitemin.net/i4/'), 3, '画像の数');
  eq(c('narou', 'alpha', '<i壊れた|タグ>').text, '<i壊れた|タグ>', '識別子が取れないタグは消さない');
  const ruby = c('narou', 'alpha', '|漢字《かんじ》<i1|2>');
  eq(ruby.text, '#漢字__かんじ__#https://2.mitemin.net/i1/', 'ルビと画像が並んでいても正しく変換');
});

group('画像の一覧（findImages）', () => {
  const t = '一行目<i1285249|50921>\n二行目 https://50921.mitemin.net/i1149346/\n三行目#__i_dd9a42ad__#';
  eq(N.findImages(t).map((x) => [x.kind, x.line, x.url]), [
    ['narou', 1, 'https://50921.mitemin.net/i1285249/'],
    ['mitemin', 2, 'https://50921.mitemin.net/i1149346/'],
    ['alpha', 3, ''],
  ]);
});

group('Phase 6：空・同じサイト', () => {
  eq(c('narou', 'narou', '|漢字《かんじ》').text, '|漢字《かんじ》', '同じサイトなら変えない');
  eq(c('narou', 'alpha', '').text, '', '空');
});

// ---------- Phase 7〜8: TXT インポートの解析 ----------

group('Phase 7：文字コードの判定（UTF-8・BOM・Shift_JIS）', () => {
  const utf8 = new TextEncoder().encode('第1話 はじまり\n本文');
  const r1 = I.decodeText(utf8.buffer);
  eq([r1.encoding, r1.bom, r1.confidence, r1.text.startsWith('第1話')], ['utf-8', false, 'high', true], 'UTF-8');
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]);
  const r2 = I.decodeText(bom.buffer);
  eq([r2.encoding, r2.bom, r2.text.startsWith('第1話')], ['utf-8', true, true], 'UTF-8 BOM 付き');
  // 「漢字あ」の Shift_JIS
  const sjis = new Uint8Array([0x8a, 0xbf, 0x8e, 0x9a, 0x82, 0xa0]);
  const r3 = I.decodeText(sjis.buffer);
  eq([r3.encoding, r3.text, r3.bad], ['shift_jis', '漢字あ', 0], 'Shift_JIS');
  const r4 = I.decodeText(sjis.buffer, 'utf-8');
  ok(r4.bad > 0 && r4.confidence === 'low', '文字コードを間違えると読めない文字を数える');
});

const sampleNarou = [
  '転生したら筆だった件', '作者：テスト', '',
  '第一章 はじまり', '',
  '第1話 出会い', '', '前書きです', '＊＊＊', '　本文一行目', '', '　本文二行目', '＊＊＊', '後書きです', '',
  '第2話 旅立ち', '　二話の本文<i1|2>', '',
  '第二章 決戦', '',
  '第10話 決戦', '　十話の本文',
];

group('Phase 7：なろう形式（章・話・前書き・後書き）', () => {
  const preset = I.PRESETS.find((p) => p.id === 'narou');
  const rules = { ...preset.rules, separator: { ...preset.rules.separator, enabled: true } };
  const marks = I.detectMarks(sampleNarou, rules);
  eq([...marks.entries()], [[3, 'chapter'], [5, 'episode'], [15, 'episode'], [18, 'chapter'], [20, 'episode']], '自動検出');
  const r = I.buildEpisodes(sampleNarou, marks, { separator: rules.separator });
  eq(r.head.title, '転生したら筆だった件', '作品名の候補');
  eq(r.chapters.map((c) => c.title), ['第一章 はじまり', '第二章 決戦'], '章');
  eq(r.episodes.map((e) => [e.title, e.chapter]), [['第1話 出会い', 0], ['第2話 旅立ち', 0], ['第10話 決戦', 1]], '話と章');
  eq([r.episodes[0].foreword, r.episodes[0].body, r.episodes[0].afterword], ['前書きです', '　本文一行目\n\n　本文二行目', '後書きです'], '前書き・本文・後書き（空行・字下げを保つ）');
  eq(I.summarize(r).images, 1, '画像タグの数');
});

group('Phase 8：区切り条件（前方一致・完全一致・行内・除外）', () => {
  const lines = ['◆一話目', '本文A', '◆', '二話目のタイトル', '本文B', '途中に◆がある行'];
  const prefix = I.detectMarks(lines, { episode: { enabled: true, pattern: '◆', method: 'prefix', position: 'start' } });
  eq([...prefix.keys()], [0, 2], '行頭の前方一致（行内の◆は対象外）');
  const any = I.detectMarks(lines, { episode: { enabled: true, pattern: '◆', method: 'prefix', position: 'any' } });
  eq([...any.keys()], [0, 2, 5], '行内');
  const exact = I.detectMarks(lines, { episode: { enabled: true, pattern: '◆', method: 'exact' } });
  eq([...exact.keys()], [2], '完全一致');
  const r = I.buildEpisodes(lines, exact, { episodeTitle: 'exclude' });
  eq([r.episodes[0].title, r.episodes[0].body], ['二話目のタイトル', '本文B\n途中に◆がある行'], '区切り行を除外して次の行をタイトルに');
});

group('Phase 8：手動の区切り（開始・章・解除）を優先', () => {
  const lines = ['第1話', 'a', '第2話', 'b', 'おまけ', 'c'];
  const auto = I.detectMarks(lines, { episode: { enabled: true, pattern: '^第\\d+話', method: 'regex' } });
  const manual = new Map([[2, 'none'], [4, 'episode']]);
  const merged = I.mergeMarks(auto, manual);
  eq([...merged.entries()].sort((a, b) => a[0] - b[0]), [[0, 'episode'], [4, 'episode']], '解除と追加');
  const r = I.buildEpisodes(lines, merged);
  eq(r.episodes.map((e) => [e.title, e.body]), [['第1話', 'a\n第2話\nb'], ['おまけ', 'c']], '分割し直し');
});

group('Phase 8：正規表現の誤り・危険な条件', () => {
  throws(() => I.compileRule({ enabled: true, pattern: '第[', method: 'regex' }), /誤り/, '書き方の誤り');
  throws(() => I.compileRule({ enabled: true, pattern: '(a+)+$', method: 'regex' }), /入れ子/, '入れ子の繰り返し');
  throws(() => I.compileRule({ enabled: true, pattern: 'x'.repeat(201), method: 'prefix' }), /長すぎ/, '長すぎる条件');
  eq(I.compileRule({ enabled: false, pattern: 'x' }), null, '無効な条件');
});

group('Phase 7：重複の判定', () => {
  const existing = [
    { id: 'A', title: '第1話 出会い', chapterTitle: '第一章', body: '　本文一行目\n\n　本文二行目' },
    { id: 'B', title: '第2話 旅立ち', chapterTitle: '第一章', body: '' },
    { id: 'C', title: '第3話', chapterTitle: '', body: '別の本文' },
  ];
  const items = [
    { title: '第１話　出会い', chapterTitle: '第一章', body: '本文一行目 本文二行目' }, // 空白違いの同じ本文
    { title: '第2話 旅立ち', chapterTitle: '第一章', body: '新しい本文' },        // 同じタイトル・既存は空
    { title: '第3話', chapterTitle: '', body: '書き直した本文' },                 // 同じタイトル・既存に内容あり
    { title: '第4話', chapterTitle: '', body: '新規' },
  ];
  const d = I.findDuplicates(items, existing);
  eq(d.map((x) => [x.kind, x.target, x.action]), [['same', 'A', 'skip'], ['title', 'B', 'overwrite'], ['title', 'C', 'skip'], ['none', null, 'add']]);
  // 話数の有無だけが違うタイトル（なろう版にアルファ版を足すとき）
  const sim = I.findDuplicates([{ title: '筆になった朝', body: 'x' }], [{ id: 'N1', title: '第1話　筆になった朝', body: '' }]);
  eq(sim.map((x) => [x.kind, x.target, x.action]), [['similar', 'N1', 'overwrite']], '似たタイトル・取り込み先が空なら上書き');
  const simFull = I.findDuplicates([{ title: '筆になった朝', body: 'x' }], [{ id: 'N1', title: '第1話　筆になった朝', body: '内容あり' }]);
  eq(simFull[0].action, 'skip', '取り込み先に内容があれば自動では上書きしない');
});

const narouDownload = [
  '転生したら筆だった件', '作者：テスト太郎', '',
  '------------------------- エピソード1開始 -------------------------',
  '【エピソードタイトル】', '第1話　筆になった朝', '',
  '【前書き】', '初投稿です。', '',
  '【本文】', '　朝、目が覚めた。', '', '　二段落目。<i1285249|50921>', '',
  '【後書き】', 'ありがとうございます。', '',
  '【リアクション】', 'いいね　12', 'ナイス　3',
  '------------------------- エピソード2開始 -------------------------',
  '【エピソードタイトル】', '第2話　旅立ち', '',
  '【本文】', '　紙の上を走った。', '',
  '【リアクション】', 'いいね　5',
];

group('見出しの掃除：なろうのダウンロード TXT', () => {
  const preset = I.PRESETS.find((p) => p.id === 'narou-download');
  const marks = I.detectMarks(narouDownload, preset.rules);
  eq([...marks.entries()], [[3, 'episode'], [21, 'episode']], '「エピソード○開始」の区切り線を検出');
  const mask = I.headingMask(narouDownload, preset.rules.cleanup, marks);
  const r = I.buildEpisodes(narouDownload, marks, { episodeTitle: 'exclude', mask });
  eq(r.episodes.map((e) => e.title), ['第1話　筆になった朝', '第2話　旅立ち'], '【エピソードタイトル】の次の行がタイトル');
  eq([r.episodes[0].foreword, r.episodes[0].body, r.episodes[0].afterword],
    ['初投稿です。', '　朝、目が覚めた。\n\n　二段落目。<i1285249|50921>', 'ありがとうございます。'], '前書き・本文・後書き（見出しの行は消える）');
  eq(r.episodes[1].body, '　紙の上を走った。', '【リアクション】以下は取り込まない');
  ok(!r.episodes.some((e) => /【|いいね|エピソード\d+開始/.test(e.title + e.body + e.foreword + e.afterword)), '見出し・リアクション・区切り線が残らない');
  eq(r.head.lines, ['転生したら筆だった件', '作者：テスト太郎'], '作品情報');
});

const narouInfo = [
  '転生したら筆だった件',
  '【ユーザ情報】', 'ユーザID：50921', 'ユーザ名：テスト太郎',
  '【Nコード】', 'N1234AB',
  '【種別】', '連載', '【完結設定】', '連載中', '【年齢制限】', 'なし',
  '【ジャンル】', 'ハイファンタジー', '【作品に含まれる要素】', '異世界転生', '【キーワード】', '筆　転生', '',
  '------------------------- エピソード1開始 -------------------------',
  '【エピソードタイトル】', '第1話', '【本文】', '本文',
];

group('作品情報の塊は既定で消す・Nコードとユーザ情報の照合', () => {
  const preset = I.PRESETS.find((p) => p.id === 'narou-download');
  const marks = I.detectMarks(narouInfo, preset.rules);
  const mask = I.headingMask(narouInfo, preset.rules.cleanup, marks);
  const r = I.buildEpisodes(narouInfo, marks, { episodeTitle: 'exclude', mask });
  eq(r.head.lines, ['転生したら筆だった件'], '【ユーザ情報】〜【キーワード】の塊は残らない');
  eq([r.episodes[0].title, r.episodes[0].body], ['第1話', '本文']);
  const info = I.extractSiteInfo(narouInfo);
  eq([info.ncode, info.userText], ['n1234ab', 'ユーザID：50921\nユーザ名：テスト太郎'], 'TXT から読む');
  eq(I.checkSiteInfo(info, { userId: '50921', userName: 'テスト太郎' }, 'n1234ab'), [], '一致すれば何も出ない');
  eq(I.checkSiteInfo(info, { userId: '99999' }, 'n0000zz').map((m) => m.label), ['Nコード', 'ユーザID'], '違えば項目を返す');
  eq(I.checkSiteInfo(info, {}, ''), [], '登録がなければ比べない');
  eq(I.checkSiteInfo(I.extractSiteInfo(['本文だけ']), { userId: '1' }, 'n1111aa'), [], 'TXT に情報がなければ比べない');
});

group('章の見出し【第１章】の次の行が章の小タイトル（区切り線の前でも後でも）', () => {
  const preset = I.PRESETS.find((p) => p.id === 'narou-download');
  const build = (lines) => {
    const marks = I.detectMarks(lines, preset.rules);
    const mask = I.headingMask(lines, preset.rules.cleanup, marks);
    return I.buildEpisodes(lines, marks, { episodeTitle: preset.rules.episode.title, chapterTitle: preset.rules.chapter.title, mask });
  };
  const sep = (n) => `------------------------- エピソード${n}開始 -------------------------`;
  // 区切り線 → 章の見出し → 小タイトル → 【エピソードタイトル】
  const after = build([
    sep(1), '【第１章】', 'はじまりの朝', '【エピソードタイトル】', '第1話　目覚め', '【本文】', '本文1',
    sep(2), '【エピソードタイトル】', '第2話　旅立ち', '【本文】', '本文2',
    sep(3), '【第２章】', '決戦', '【エピソードタイトル】', '第3話　最後', '【本文】', '本文3',
  ]);
  eq(after.chapters.map((c) => c.title), ['はじまりの朝', '決戦'], '章の小タイトル（区切り線の後に章）');
  eq(after.episodes.map((e) => [e.title, e.chapter, e.body]), [['第1話　目覚め', 0, '本文1'], ['第2話　旅立ち', 0, '本文2'], ['第3話　最後', 1, '本文3']], '話と所属');
  // 章の見出し → 小タイトル → 区切り線 → …
  const before = build([
    '【第１章】', 'はじまりの朝', sep(1), '【エピソードタイトル】', '第1話　目覚め', '【本文】', '本文1',
    '【第２章】', '決戦', sep(2), '【エピソードタイトル】', '第2話　最後', '【本文】', '本文2',
  ]);
  eq(before.chapters.map((c) => c.title), ['はじまりの朝', '決戦'], '章の小タイトル（区切り線の前に章）');
  eq(before.episodes.map((e) => [e.title, e.chapter, e.body]), [['第1話　目覚め', 0, '本文1'], ['第2話　最後', 1, '本文2']], '話と所属');
  ok(!before.episodes.some((e) => e.orphan) && !after.episodes.some((e) => e.orphan), 'タイトルなしの話ができない');
  // 区切り行と次の行をつなげる
  const lines = ['【第１章】', 'はじまりの朝', sep(1), '【エピソードタイトル】', '第1話', '本文'];
  const marks = I.detectMarks(lines, preset.rules);
  const r = I.buildEpisodes(lines, marks, { chapterTitle: 'combine', episodeTitle: 'exclude', mask: I.headingMask(lines, preset.rules.cleanup, marks) });
  eq(r.chapters[0].title, '第１章　はじまりの朝', 'つなげる（括弧は外す）');
});

group('見出しの扱い「次の行を話のタイトルにする」', () => {
  const cleanup = { enabled: true, pattern: '^【[^】]+】$', defaultAction: 'line', rules: [{ text: '【エピソードタイトル】', method: 'exact', action: 'title' }] };
  eq(I.headingMask(['【エピソードタイトル】', '', 'タイトル', '本文'], cleanup), ['line', null, 'title', null], '空行を飛ばして次の行');
  // 区切り行をタイトルにする設定でも、印の付いた行が優先
  const lines = ['◆', '【エピソードタイトル】', '本当のタイトル', '本文'];
  const marks = new Map([[0, 'episode']]);
  const r = I.buildEpisodes(lines, marks, { episodeTitle: 'include', mask: I.headingMask(lines, cleanup, marks) });
  eq([r.episodes[0].title, r.episodes[0].body], ['本当のタイトル', '本文']);
});

group('見出しの掃除：扱いの種類と優先順位', () => {
  const lines = ['【メモ】', 'メモ本文', '【感想】', '感想本文', '【本文】', '本文', '★お知らせ', 'お知らせ本文'];
  const cleanup = {
    enabled: true, pattern: '^【[^】]+】$', defaultAction: 'line',
    rules: [
      { text: '【メモ】', method: 'exact', action: 'keep' },
      { text: '【感想】', method: 'exact', action: 'block' },
      { text: '★', method: 'prefix', action: 'block' },
    ],
  };
  eq(I.headingMask(lines, cleanup), [null, null, 'line', 'block', 'line', null, 'line', 'block'],
    '残す／塊ごと消す（次の見出しまで）／既定の「行だけ消す」／前方一致の見出し');
  eq(I.headingMask(lines, { ...cleanup, enabled: false }).every((x) => x === null), true, '無効なら何もしない');
  const marks = new Map([[4, 'episode']]);
  eq(I.headingMask(['【感想】', 'a', 'b', 'c', '次の話', 'd'], cleanup, marks).slice(0, 6), ['line', 'block', 'block', 'block', null, null], '塊は話の区切りで終わる');
});

group('Phase 8：区切り記号をタイトルから外す', () => {
  const lines = ['◆筆になった朝', '本文', '◆', '本文2'];
  const marks = I.detectMarks(lines, { episode: { enabled: true, pattern: '◆', method: 'prefix', position: 'start' } });
  const r = I.buildEpisodes(lines, marks, { episodePrefix: '◆' });
  eq(r.episodes.map((e) => e.title), ['筆になった朝', '◆'], '記号だけの行はそのまま');
});

// ---------- 実行 ----------

const list = document.getElementById('results');
let pass = 0;
let failCount = 0;
for (const [name, fn] of groups) {
  const item = document.createElement('li');
  try {
    await fn();
    pass++;
    item.className = 'ok';
    item.textContent = '✔ ' + name;
  } catch (e) {
    failCount++;
    item.className = 'ng';
    item.textContent = '✘ ' + name;
    const pre = document.createElement('pre');
    pre.textContent = e.message;
    item.append(pre);
  }
  list.append(item);
}
const summary = document.getElementById('summary');
summary.className = failCount ? 'ng' : 'ok';
summary.textContent = `${pass + failCount}件中 ${pass}件 成功${failCount ? `、${failCount}件 失敗` : ''}`;
window.testResult = { pass, fail: failCount };
