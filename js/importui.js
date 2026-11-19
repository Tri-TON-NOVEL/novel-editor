// TXT インポートの画面（設定 →「インポート／エクスポート」→「TXT をインポート…」）
// 解析は importer.js。この画面は、確定するまで作品データを一切変更しない。
// 途中の作業は IndexedDB の meta.importSession に自動で残し、あとから再開できる。
import * as I from './importer.js';
import { normalize, newProject, newEpisode, newChapter, draftOf, serialize, countChars, SITE_KEYS, normalizeSites, episodeOrderFromFile } from './format.js';
import { SITES, countImages } from './notation.js';
import { looksLikeBackup, parseBackup } from './sites/kakuyomu.js';
import { imageSlots, contextOf, suggestPairs, pairScore, applyImageMap, PAIR_WEAK } from './imagematch.js';
import { ask, askText } from './dialogs.js';
import { listZipTextEntries, extractZipEntry, ZipError } from './zip.js';

const KINDS = [
  ['chapter', '章の区切り'],
  ['episode', '話の区切り'],
  ['separator', '前書き・後書きの区切り'],
];
const MARK_LABEL = { episode: '話', chapter: '章' };
const clone = (x) => structuredClone(x);
// 中身のない話（どの投稿先の原稿も、プロット・フリーメモ・活動報告も空）
const isBlankEpisode = (e) => !e.plot && !e.freeMemo && !Object.values(e.report || {}).some(Boolean)
  && SITE_KEYS.every((s) => ['title', 'foreword', 'body', 'afterword'].every((f) => !draftOf(e, s)[f]));

/**
 * @param ctx {
 *   db, versions, meta, prefs, toast, fail,
 *   getProject() → 開いている作品, flush(), switchTo(作品), closeSettings()
 * }
 */
export function initImport(ctx) {
  const $ = (id) => document.getElementById(id);
  const dlg = $('import-dialog');
  let state = fresh();
  let rowEls = [];
  let saveTimer = null;

  // 区切りの条件に足りない項目を補う（見出しの扱いがない古い保存など）
  function completeRules(rules) {
    const r = clone(rules || I.PRESETS[0].rules);
    r.cleanup = { ...clone(I.NO_CLEANUP), ...(r.cleanup || {}) };
    r.cleanup.rules = r.cleanup.rules || [];
    return r;
  }

  function userFormats() {
    const saved = ctx.prefs.get('importFormats', null);
    if (Array.isArray(saved)) return saved;
    // 以前の版で保存した区切り条件を、そのまま新しい書式リストへ移す。
    const old = ctx.prefs.get('importPresets', []) || [];
    const migrated = old.map((p) => ({ id: p.id, name: p.name, type: 'rules', rules: p.rules, updatedAt: p.updatedAt || '' }));
    if (migrated.length) ctx.prefs.set('importFormats', migrated);
    return migrated;
  }

  function formatOf(id) {
    if (id?.startsWith('b:')) return I.PRESETS.find((p) => 'b:' + p.id === id) || null;
    return userFormats().find((p) => 'u:' + p.id === id) || null;
  }

  // 既定の書式（なければ先頭の標準書式）
  function defaultPreset() {
    const id = ctx.prefs.get('importDefaultPreset', null);
    const format = id && formatOf(id);
    return format ? { id, format } : { id: 'b:' + I.PRESETS[0].id, format: I.PRESETS[0] };
  }

  // 0.82：インポート元（なろう／アルファ）だけを選ぶ。読み取り方法・取り込む原稿・書式は、インポート元で決まる
  //   なろう → 書式あり（区切りのルール）・なろう用の原稿／アルファ → 書式なし（タイトル一覧）・アルファ用の原稿
  //   カクヨム（v4）→ 公式バックアップの ZIP（区切りの設定なし）・カクヨム用の原稿
  const SOURCE_TYPE = { narou: 'rules', alpha: 'title-list', kakuyomu: 'kakuyomu-zip' };
  const KAKUYOMU_FORMAT = { id: 'b:kakuyomu-zip', format: { id: 'kakuyomu-zip', type: 'kakuyomu-zip', name: 'カクヨムのバックアップ' } };
  // 宣言の前（state = fresh()）でも使うので function
  function siteOfType(type) { return type === 'title-list' ? 'alpha' : type === 'kakuyomu-zip' ? 'kakuyomu' : 'narou'; }
  const isKakuyomu = () => state.type === 'kakuyomu-zip';
  // 画面の言葉：カクヨムは ZIP、なろう・アルファは TXT（0.97）
  const srcWord = () => (isKakuyomu() ? 'ZIP' : 'TXT');
  // 取り込むサイト以外の投稿サイト（対にするとき、そのタイトルでも探す）
  const otherSites = () => SITE_KEYS.filter((s) => s !== state.site);
  const hasDraftOf = (e, s) => { const d = draftOf(e, s); return !!((d.title || '').trim() || (d.body || '').trim()); };
  // その話で原稿のある、ほかのサイト（なければ null）
  const otherSiteOf = (e) => otherSites().find((s) => hasDraftOf(e, s)) || null;
  const otherTitleOf = (e) => otherSites().map((s) => draftOf(e, s).title).find(Boolean) || '';
  // そのインポート元で使う書式：既定の書式が同じ方式ならそれ、違えば標準の書式
  function sourceFormat(site) {
    if (site === 'kakuyomu') return KAKUYOMU_FORMAT;
    const def = defaultPreset();
    if ((def.format.type || 'rules') === SOURCE_TYPE[site]) return def;
    const f = I.PRESETS.find((p) => p.site === site);
    return { id: 'b:' + f.id, format: f };
  }
  // なろうの標準の書式は、連載か短編かを TXT の中身で見分ける（「詳しい設定」で書式を選んだとき・手動の区切りがあるときはそのまま）
  const NAROU_BUILT_IN = ['b:narou-download', 'b:narou-download-short'];
  function autoNarouFormat() {
    if (!state.text || state.presetPicked || state.manual.size || !NAROU_BUILT_IN.includes(state.presetId)) return;
    const series = I.PRESETS.find((p) => p.id === 'narou-download');
    const re = new RegExp(series.rules.episode.pattern);
    const short = !state.lines.some((l) => re.test(l)) && state.lines.some((l) => l.trim() === '【タイトル】');
    const want = short ? 'b:narou-download-short' : 'b:narou-download';
    if (want !== state.presetId) applyFormat(formatOf(want), want);
  }

  function fresh() {
    const preset = defaultPreset();
    const type = preset.format.type || 'rules';
    return {
      fileName: '', buffer: null, archiveName: '', archiveBuffer: null, zipEntries: [], zipEntryIndex: 0, text: '', lines: [], decode: null,
      encoding: 'auto', site: siteOfType(type), target: 'new', mode: 'overwrite', strictMatch: true,
      presetId: preset.id, presetPicked: false, type, rules: completeRules(preset.format.rules), template: preset.format.template || I.ALPHA_TITLE_LIST_TEMPLATE,
      titleListText: '', titleListFileName: '',
      auto: new Map(), manual: new Map(),
      result: null, rows: [], actionFilter: 'all', workTitle: '', workTitleEdited: false, txtTitle: '', useHead: true, step: 1, siteInfo: null, mismatches: [],
    };
  }

  // ---------- 途中の作業の保存・再開（オプション C） ----------

  function saveSession() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      // カクヨムのバックアップは ZIP をそのまま読むので、途中の作業は残さない（ファイルを選び直す）
      if (!state.text || isKakuyomu()) return;
      ctx.meta.set('importSession', {
        savedAt: new Date().toISOString(),
        fileName: state.fileName, text: state.text, decode: state.decode && { encoding: state.decode.encoding, note: state.decode.note, bad: state.decode.bad },
        site: state.site, target: state.target, mode: state.mode, strictMatch: state.strictMatch, presetId: state.presetId, type: state.type, rules: state.rules, template: state.template,
        titleListText: state.titleListText, titleListFileName: state.titleListFileName,
        manual: [...state.manual.entries()], step: Math.min(state.step, 2),
      }).catch(() => {});
    }, 800);
  }

  async function clearSession() {
    clearTimeout(saveTimer);
    await ctx.meta.remove('importSession').catch(() => {});
  }

  async function showResume() {
    const s = await ctx.meta.get('importSession').catch(() => null);
    $('imp-resume').hidden = !s;
    if (s) {
      $('imp-resume-text').textContent =
        `前回の作業が残っています：「${s.fileName}」（${new Date(s.savedAt).toLocaleString('ja-JP')}、手動の区切り ${s.manual.length}件）`;
    }
  }

  async function resume() {
    const s = await ctx.meta.get('importSession');
    if (!s) return;
    state = { ...fresh(), fileName: s.fileName, text: s.text, lines: I.splitLines(s.text), decode: s.decode, site: s.site, target: s.target,
      // 0.69 までの 'merge'・'replace' は「置き換える」（その投稿先の原稿だけ）から始める
      mode: ['overwrite', 'edition', 'rebuild'].includes(s.mode) ? s.mode : 'overwrite', strictMatch: s.strictMatch !== false,
      presetId: s.presetId, type: s.type || 'rules', rules: completeRules(s.rules), template: s.template || I.ALPHA_TITLE_LIST_TEMPLATE,
      titleListText: s.titleListText || '', titleListFileName: s.titleListFileName || '', manual: new Map(s.manual) };
    state.site = siteOfType(state.type); // 前の版の作業（取り込む原稿を別に選べた）も、読み取り方法に合わせる
    $('imp-source').value = state.site;
    fillPresets();
    $('imp-title-list-text').value = state.titleListText;
    showTitleListSource();
    await fillTargets();
    $('imp-target').value = state.target;
    updateStrictMatchRow();
    showDecodeInfo(true);
    buildLineRows();
    go(2, { detect: true });
  }

  // ---------- 1. ファイル ----------

  async function fillTargets() {
    const sel = $('imp-target');
    const projects = (await ctx.db.all()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sel.replaceChildren(new Option('新しい作品として取り込む', 'new'),
      ...projects.map((p) => {
        const ids = [p.narouNcode && `なろう ${p.narouNcode}`, p.kakuyomuWorkId && `カクヨム ${p.kakuyomuWorkId}`, p.alphaWorkId && `アルファ ${p.alphaWorkId}`].filter(Boolean).join('／');
        return new Option(`既存の作品：${p.title || '（無題）'}${ids ? `（${ids}）` : ''}`, p.id);
      }));
    sel.value = projects.some((p) => p.id === state.target) ? state.target : 'new';
    state.target = sel.value;
    updateStrictMatchRow();
  }

  function updateStrictMatchRow() {
    const existing = state.target !== 'new';
    $('imp-mode-row').hidden = !existing;
    document.querySelectorAll('input[name="imp-mode"]').forEach((r) => { r.checked = r.value === state.mode; });
    // 対応付けは「作り直す」以外で使う
    $('imp-strict-match-row').hidden = !existing || state.mode === 'rebuild';
    $('imp-strict-match').checked = state.strictMatch !== false;
  }

  function showDecodeInfo(fromSession = false) {
    const box = $('imp-decode-info');
    const d = state.decode;
    if (!state.text) { box.hidden = true; return; }
    const conf = { high: '高い', medium: 'ふつう', low: '低い' }[d?.confidence] || '―';
    let text = `ファイル：${state.fileName}（${state.lines.length.toLocaleString()}行・${countChars(state.text).all.toLocaleString()}文字）\n`
      + `文字コード：${d?.note || d?.encoding || '不明'}${d?.confidence ? `（判定の確かさ：${conf}）` : ''}`;
    if (d?.bad) {
      text += `\n⚠ 読めない文字（�）が ${d.bad}個あります${d.badLines?.length ? `（${d.badLines.join('・')}行目など）` : ''}。文字コードを変えてみてください。このまま取り込むと「�」が入ります。`;
    }
    if (fromSession) text += '\n（前回の作業から再開しました。文字コードを変えるときは、ファイルを選び直してください）';
    box.textContent = text;
    box.classList.toggle('warn', !!d?.bad);
    box.hidden = false;
  }

  function decodeAndShow() {
    if (!state.buffer) return;
    state.decode = I.decodeText(state.buffer, state.encoding);
    state.text = state.decode.text;
    state.lines = I.splitLines(state.text);
    state.manual = new Map();
    state.auto = new Map();
    // ファイルを選び直したら、作品名も新しいファイルから読み直す
    state.workTitle = '';
    state.workTitleEdited = false;
    showDecodeInfo();
    buildLineRows();
    updateNextButton();
    saveSession();
  }

  function resetZipSelection() {
    state.archiveName = '';
    state.archiveBuffer = null;
    state.zipEntries = [];
    state.zipEntryIndex = 0;
    $('imp-zip-entry-list').replaceChildren();
    $('imp-zip-entry-row').hidden = true;
  }

  async function selectZipEntry(index) {
    const entry = state.zipEntries[index];
    state.zipEntryIndex = index;
    state.buffer = await extractZipEntry(state.archiveBuffer, entry);
    state.fileName = `${state.archiveName} ／ ${entry.name}`;
    decodeAndShow();
  }

  async function loadImportFile(file) {
    if (file.size > 50 * 1024 * 1024) throw new ZipError('ファイルが大きすぎます（50MBまで）。');
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
    const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip'
      || (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2]));
    resetZipSelection();
    if (!isZip && isKakuyomu()) throw new ZipError('カクヨムは、「作品データをダウンロード」で作った ZIP を選んでください（TXT は読めません）');
    if (!isZip) {
      state.fileName = file.name;
      state.buffer = buffer;
      decodeAndShow();
      return;
    }
    const entries = listZipTextEntries(buffer);
    if (!entries.length) throw new ZipError('ZIP内にTXTファイルが見つかりません。');
    // カクヨムの公式バックアップ（about.txt と episode_NNNN.txt）は、中のファイルをまとめて読む（v4）
    if (looksLikeBackup(entries.map((e) => e.name))) { await loadKakuyomuZip(file, buffer, entries); return; }
    if (isKakuyomu()) throw new ZipError('カクヨムの「作品データをダウンロード」で作った ZIP ではありません（about.txt と episode_0001.txt などが入っている ZIP を選んでください）');
    state.archiveName = file.name;
    state.archiveBuffer = buffer;
    state.zipEntries = entries;
    state.zipEntryIndex = -1;
    state.fileName = file.name;
    state.buffer = null;
    state.text = '';
    state.lines = [];
    state.decode = null;
    const list = $('imp-zip-entry-list');
    list.replaceChildren(...entries.map((entry, i) => {
      const label = document.createElement('label');
      const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'imp-zip-entry', value: String(i) });
      label.append(radio,
        Object.assign(document.createElement('span'), { className: 'zip-name', textContent: entry.name }),
        Object.assign(document.createElement('span'), { className: 'zip-size', textContent: `${entry.size.toLocaleString()}バイト` }));
      return label;
    }));
    $('imp-zip-entry-row').hidden = false;
    const info = $('imp-decode-info');
    info.textContent = `ZIP：${file.name}（TXT ${entries.length.toLocaleString()}件）\n取り込むTXTを一覧から選んでください。`;
    info.classList.remove('warn');
    info.hidden = false;
    updateNextButton();
  }

  // カクヨムのバックアップ ZIP を読む。インポート元がカクヨムでなければ、カクヨムに切り替える
  async function loadKakuyomuZip(file, buffer, entries) {
    const files = [];
    for (const entry of entries) {
      const bytes = await extractZipEntry(buffer, entry);
      files.push({ name: entry.name, text: new TextDecoder('utf-8').decode(bytes) });
    }
    const parsed = parseBackup(files);
    if (!parsed.episodes.length) throw new ZipError('ZIP の中に話（episode_0001.txt など）がありません。');
    if (!isKakuyomu()) {
      applyFormat(KAKUYOMU_FORMAT.format, KAKUYOMU_FORMAT.id);
      ctx.prefs.set('importSite', 'kakuyomu');
    }
    const about = files.find((f) => /(^|\/)about\.txt$/.test(f.name));
    state.kakuyomu = parsed;
    state.kakuyomuInfo = true;
    state.shortStory = parsed.episodes.length === 1;
    // 小見出しのある ZIP は、カクヨムだけの作品として取り込む（なろう・アルファは章が1段だけ：0.97）
    state.kakuyomuOnly = parsed.chapters.some((c) => c.level === 2);
    state.fileName = file.name;
    state.buffer = null;
    state.text = about.text.replace(/^﻿/, '');
    state.lines = I.splitLines(state.text);
    state.decode = { encoding: 'utf-8', note: 'UTF-8（カクヨムのバックアップ）', confidence: 'high', bad: 0 };
    state.workTitle = '';
    state.workTitleEdited = false;
    showDecodeInfo();
    updateNextButton();
  }

  // ---------- 2. 区切り ----------

  function fillPresets() {
    const def = defaultPreset().id;
    const mark = (id) => (id === def ? '（既定）' : '');
    const builtInFormats = I.PRESETS.filter((p) => (p.type || 'rules') === state.type);
    const savedFormats = userFormats()
      .filter((p) => (p.type || 'rules') === state.type)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    for (const sel of [$('imp-preset-edit')]) {
      sel.replaceChildren(
        ...builtInFormats.map((p) => new Option(p.name + mark('b:' + p.id), 'b:' + p.id)),
        ...savedFormats.map((p) => new Option(p.name + mark('u:' + p.id), 'u:' + p.id)));
      const current = formatOf(state.presetId);
      if (![...sel.options].some((o) => o.value === state.presetId)
        && (!current || (current.type || 'rules') === state.type)) {
        sel.append(new Option('（いまの書式）', state.presetId));
      }
      sel.value = state.presetId;
    }
    const custom = state.presetId.startsWith('u:');
    $('imp-preset-delete').disabled = !custom;
    $('imp-preset-overwrite').disabled = !custom;
  }

  function applyFormat(format, id) {
    if (!format) return;
    state.presetId = id;
    state.type = format.type || 'rules';
    state.rules = completeRules(format.rules);
    state.template = format.template || I.ALPHA_TITLE_LIST_TEMPLATE;
    state.auto = new Map();
    state.manual = new Map();
    // 取り込む原稿は、読み取り方法（インポート元）で決まる
    state.site = siteOfType(state.type);
    $('imp-source').value = state.site;
    if (state.type !== 'kakuyomu-zip') state.kakuyomu = null;
    showTitleListSource();
  }

  function showTitleListSource() {
    const on = state.type === 'title-list';
    $('imp-title-list-source').hidden = !on;
    $('imp-step-label-titles').hidden = !on;
    // カクヨムのバックアップは区切りの確認がない（ファイル → プレビュー）
    $('imp-step-label-rules').hidden = isKakuyomu();
    $('imp-step-label-rules').textContent = on ? '3 区切り確認' : '2 区切り確認';
    $('imp-step-label-preview').textContent = on ? '4 プレビュー' : isKakuyomu() ? '2 プレビュー' : '3 プレビュー';
    $('imp-to-2').textContent = on ? '次へ：タイトル一覧' : isKakuyomu() ? '次へ：プレビュー' : '次へ：区切り確認';
    $('imp-detect').textContent = on ? 'タイトル一覧と照合' : 'この条件で自動検出';
    $('imp-pending').textContent = on
      ? '書式を変えました。全文に反映するには「タイトル一覧と照合」を押してください（プレビューへ進むときにも反映されます）'
      : '条件を変えました。全文に反映するには「この条件で自動検出」を押してください（プレビューへ進むときにも反映されます）';
    updateNextButton();
  }

  function updateNextButton() {
    // ファイルを選ぶと自動で次へ進むので、「次へ」は読み込み済みのファイルがあるとき（戻ってきたとき）だけ出す
    $('imp-to-2').disabled = !state.text;
    $('imp-to-2').hidden = !state.text;
    $('imp-title-to-rules').disabled = !state.titleListText.trim();
  }

  function renderRuleForm() {
    const titleMode = state.type === 'title-list';
    $('imp-rules-editor').hidden = titleMode;
    $('imp-title-list-editor').hidden = !titleMode;
    $('imp-keep-manual').closest('label').hidden = titleMode;
    $('imp-title-list-template').value = state.template || '';
    if (titleMode) {
      validateRules();
      return;
    }
    const grid = $('imp-rule-grid');
    grid.replaceChildren();
    for (const [kind, label] of KINDS) {
      const r = state.rules[kind] || (state.rules[kind] = { enabled: false, pattern: '', position: 'start', method: 'prefix', title: 'include' });
      const row = Object.assign(document.createElement('div'), { className: 'imp-rule' });
      row.dataset.kind = kind;
      const en = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!r.enabled });
      const enLabel = Object.assign(document.createElement('label'), { className: 'inline' });
      enLabel.append(en, label);
      const pat = Object.assign(document.createElement('input'), { type: 'text', value: r.pattern || '', className: 'imp-pattern', placeholder: '区切りの文字列（例：◆ や ^第[0-9]+話）', spellcheck: false });
      pat.setAttribute('aria-label', label + 'の文字列');
      const sel = (opts, value, aria) => {
        const s = document.createElement('select');
        s.setAttribute('aria-label', aria);
        for (const [v, t] of opts) s.append(new Option(t, v));
        s.value = value;
        return s;
      };
      const pos = sel([['start', '行頭'], ['any', '行内']], r.position || 'start', '検索位置');
      const method = sel([['exact', '完全一致'], ['prefix', '前方一致'], ['regex', '正規表現']], r.method || 'prefix', '判定方法');
      const title = kind === 'separator'
        ? Object.assign(document.createElement('span'), { className: 'hint', textContent: '区切り行は取り込まない' })
        : sel([
          ['include', '区切り行をタイトルに'],
          ['exclude', '区切り行を除き次の行をタイトルに'],
          ['combine', '区切り行と次の行をつなげてタイトルに'],
        ], r.title || 'include', '区切り行の扱い');
      const update = () => {
        state.rules[kind] = { enabled: en.checked, pattern: pat.value, position: pos.value, method: method.value, title: title.value || 'include' };
        validateRules();
        saveSession();
      };
      for (const x of [en, pat, pos, method, title]) x.addEventListener?.('input', update);
      for (const x of [en, pos, method, title]) x.addEventListener?.('change', update);
      row.append(enLabel, pat, pos, method, title);
      grid.append(row);
    }
    renderCleanupForm();
    validateRules();
  }

  // 見出し（【…】など）の扱い：見出しとみなす条件・既定の扱い・見出しごとの扱い
  function renderCleanupForm() {
    const c = state.rules.cleanup;
    const box = $('imp-cleanup');
    const actionSelect = (value, aria) => {
      const s = document.createElement('select');
      s.setAttribute('aria-label', aria);
      for (const [v, t] of I.CLEANUP_ACTIONS) s.append(new Option(t, v));
      s.value = value || 'line';
      return s;
    };
    // 入力のたびに全文を判定し直すと重いので、ここでは条件を覚えるだけ。全文への反映は「この条件で自動検出」で行う
    const changed = () => { validateRules(); markPending(); saveSession(); };

    const en = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!c.enabled });
    const enLabel = Object.assign(document.createElement('label'), { className: 'inline' });
    enLabel.append(en, '見出しの行を処理する');
    const pat = Object.assign(document.createElement('input'), { type: 'text', value: c.pattern || '', className: 'imp-pattern', placeholder: '見出しとみなす行（正規表現）', spellcheck: false });
    pat.setAttribute('aria-label', '見出しとみなす行の条件（正規表現）');
    const def = actionSelect(c.defaultAction, '見出しの既定の扱い');
    en.addEventListener('change', () => { c.enabled = en.checked; changed(); });
    pat.addEventListener('input', () => { c.pattern = pat.value; changed(); });
    def.addEventListener('change', () => { c.defaultAction = def.value; changed(); });
    const head = Object.assign(document.createElement('div'), { className: 'imp-cleanup-head' });
    head.append(enLabel, pat, Object.assign(document.createElement('span'), { textContent: '既定の扱い' }), def);

    const rulesBox = Object.assign(document.createElement('div'), { className: 'imp-cleanup-rules' });
    c.rules.forEach((r, i) => {
      const row = Object.assign(document.createElement('div'), { className: 'imp-cleanup-rule' });
      const text = Object.assign(document.createElement('input'), { type: 'text', value: r.text || '', className: 'imp-pattern', placeholder: '見出し（例：【リアクション】）', spellcheck: false });
      text.setAttribute('aria-label', '見出しの文字列');
      const method = document.createElement('select');
      method.setAttribute('aria-label', '判定方法');
      for (const [v, t] of [['exact', '完全一致'], ['prefix', '前方一致'], ['regex', '正規表現']]) method.append(new Option(t, v));
      method.value = r.method || 'exact';
      const act = actionSelect(r.action, '扱い');
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'tool danger', textContent: '削除' });
      text.addEventListener('input', () => { r.text = text.value; changed(); });
      method.addEventListener('change', () => { r.method = method.value; changed(); });
      act.addEventListener('change', () => { r.action = act.value; changed(); });
      del.addEventListener('click', () => { c.rules.splice(i, 1); renderCleanupForm(); changed(); });
      row.append(text, method, act, del);
      rulesBox.append(row);
    });
    const add = Object.assign(document.createElement('button'), { type: 'button', className: 'tool', textContent: '＋ 見出しごとの扱いを追加' });
    add.addEventListener('click', () => {
      c.rules.push({ text: '', method: 'exact', action: 'block' });
      renderCleanupForm();
      box.querySelector('.imp-cleanup-rule:last-of-type input')?.focus();
    });
    box.replaceChildren(head, rulesBox, add,
      Object.assign(document.createElement('p'), {
        className: 'hint',
        textContent: '見出しごとの扱いが、既定の扱いより優先されます。「塊ごと消す」「前書き／後書きにする」は、次の見出しか次の話の区切りまでが対象です。消える行は左の全文に取り消し線で表示されます。',
      }));
  }

  function validateRules() {
    const errors = [];
    if (state.type === 'title-list') {
      const input = $('imp-title-list-template');
      try {
        I.parseTitleListTemplate(state.template);
        input.classList.remove('invalid');
      } catch (e) {
        input.classList.add('invalid');
        errors.push(e.message);
      }
      $('imp-rule-error').textContent = errors.join('　');
      return !errors.length;
    }
    for (const [kind, label] of KINDS) {
      const input = document.querySelector(`.imp-rule[data-kind="${kind}"] .imp-pattern`);
      try {
        I.compileRule(state.rules[kind]);
        input?.classList.remove('invalid');
      } catch (e) {
        input?.classList.add('invalid');
        errors.push(`${label}：${e.message}`);
      }
    }
    // 見出しの扱い
    const c = state.rules.cleanup;
    const inputs = [...document.querySelectorAll('#imp-cleanup .imp-pattern')];
    const checks = [{ pattern: c.pattern, method: 'regex', input: inputs[0], label: '見出しとみなす行' },
      ...c.rules.map((r, i) => ({ pattern: r.text, method: r.method || 'exact', input: inputs[i + 1], label: `見出し「${r.text}」` }))];
    for (const ch of checks) {
      try {
        if (c.enabled && ch.pattern) I.compileRule({ enabled: true, pattern: ch.pattern, method: ch.method });
        ch.input?.classList.remove('invalid');
      } catch (e) {
        ch.input?.classList.add('invalid');
        errors.push(`${ch.label}：${e.message}`);
      }
    }
    $('imp-rule-error').textContent = errors.join('　');
    return !errors.length;
  }

  // 条件を変えたが、まだ全文に反映していないことを示す
  function markPending(on = true) {
    $('imp-pending').hidden = !on;
  }

  // 見出しの扱いによる、行ごとの扱い（消す・前書き・後書き）
  function currentMask() {
    if (state.type === 'title-list') return [];
    try { return I.headingMask(state.lines, state.rules.cleanup, merged()); } catch { return []; }
  }

  async function detect({ confirmFirst = true } = {}) {
    if (!validateRules()) return false;
    if (state.type === 'title-list') {
      try {
        const found = I.detectMarksFromTitleList(state.lines, state.titleListText, state.template);
        state.auto = found.marks;
        state.manual.clear();
      } catch (e) {
        $('imp-rule-error').textContent = e.message;
        return false;
      }
      renderMarks();
      markPending(false);
      saveSession();
      return true;
    }
    if (!$('imp-keep-manual').checked && state.manual.size) {
      if (confirmFirst && !(await ask(`手動で指定した区切り ${state.manual.size}件を消して、検出し直しますか？`))) return false;
      state.manual.clear();
    }
    try {
      state.auto = I.detectMarks(state.lines, state.rules);
    } catch (e) {
      $('imp-rule-error').textContent = e.message;
      return false;
    }
    renderMarks();
    markPending(false);
    saveSession();
    return true;
  }

  const merged = () => I.mergeMarks(state.auto, state.manual);

  function buildLineRows() {
    const box = $('imp-lines');
    const frag = document.createDocumentFragment();
    rowEls = state.lines.map((line, i) => {
      const row = Object.assign(document.createElement('div'), { className: 'ln' });
      row.dataset.i = i;
      const mark = Object.assign(document.createElement('button'), { type: 'button', className: 'ln-mark tool', textContent: '−' });
      mark.setAttribute('aria-label', `${i + 1}行目の区切り`);
      row.append(mark,
        Object.assign(document.createElement('span'), { className: 'ln-no', textContent: i + 1 }),
        Object.assign(document.createElement('span'), { className: 'ln-tag' }),
        Object.assign(document.createElement('span'), { className: 'ln-text', textContent: line || ' ' }));
      frag.append(row);
      return row;
    });
    box.replaceChildren(frag);
  }

  const MASK_CLASS = { line: ' cut-line', block: ' cut-block', foreword: ' to-foreword', afterword: ' to-afterword', synopsis: ' to-foreword', title: ' to-title' };
  const MASK_TAG = { line: '消す', block: '消す', foreword: '前書き', afterword: '後書き', synopsis: 'あらすじ', title: '題名' };

  function renderMarks() {
    const m = merged();
    const mask = currentMask();
    for (let i = 0; i < rowEls.length; i++) {
      const kind = m.get(i);
      const row = rowEls[i];
      const cls = 'ln' + (kind ? ' ' + kind : '') + (state.manual.has(i) ? ' manual' : '') + (MASK_CLASS[mask[i]] || '');
      if (row.className !== cls) {
        row.className = cls;
        row.firstChild.textContent = MARK_LABEL[kind] || (state.manual.get(i) === 'none' ? '解除' : '−');
        row.children[2].textContent = MASK_TAG[mask[i]] || '';
      }
    }
    renderDetectedList();
  }

  // 行の区切りを「話 → 章 → 解除」の順に切り替える
  function cycleMark(i) {
    const now = merged().get(i) || 'none';
    const next = now === 'none' ? 'episode' : now === 'episode' ? 'chapter' : 'none';
    const autoKind = state.auto.get(i) || 'none';
    if (next === autoKind) state.manual.delete(i);
    else state.manual.set(i, next);
    renderMarks();
    saveSession();
  }

  function buildResult() {
    // カクヨムのバックアップ：話はファイルの番号順。目次の大見出し・小見出しを章の level 1・2 にする（0.97）
    if (isKakuyomu()) {
      const k = state.kakuyomu;
      return {
        head: { title: k.title, lines: k.synopsis ? k.synopsis.split('\n') : [] },
        chapters: (k.chapters || []).map((c) => ({ title: c.title, level: c.level, line: -1 })),
        episodes: k.episodes.map((e, i) => ({
          title: e.title, body: e.body, foreword: '', afterword: '', chapter: e.chapter ?? null, line: i,
          warnings: e.status && e.status !== '公開済' ? [e.status] : [],
        })),
      };
    }
    if (state.type === 'title-list') {
      return I.buildEpisodes(state.lines, merged(), { episodeTitle: 'include', chapterTitle: 'include', mask: [] });
    }
    const r = state.rules;
    const prefixOf = (rule) => (rule?.enabled && rule.method === 'prefix' && rule.position !== 'any' ? rule.pattern : '');
    return I.buildEpisodes(state.lines, merged(), {
      episodeTitle: r.episode?.title,
      chapterTitle: r.chapter?.title,
      episodePrefix: prefixOf(r.episode),
      chapterPrefix: prefixOf(r.chapter),
      separator: r.separator?.enabled ? r.separator : null,
      mask: currentMask(),
      workTitleFromEpisode: r.workTitle === 'episode',
    });
  }

  function renderDetectedList() {
    let result;
    try { result = buildResult(); } catch (e) { $('imp-rule-error').textContent = e.message; return; }
    state.result = result;
    const list = $('imp-episodes');
    const items = [];
    const item = (kind, line, title, n = '') => {
      const b = Object.assign(document.createElement('button'), { type: 'button' });
      b.dataset.line = line;
      b.append(
        Object.assign(document.createElement('span'), { className: 'kind', textContent: kind === 'chapter' ? '章' : '話' }),
        Object.assign(document.createElement('span'), { className: 't', textContent: title || '（タイトルなし）' }),
        Object.assign(document.createElement('span'), { className: 'n', textContent: n }));
      const li = Object.assign(document.createElement('li'), { className: kind });
      li.append(b);
      items.push(li);
    };
    // 章 → その章の話 の順に並べる（区切り線のあとに章の見出しがある形式でも、章が先に見えるように）
    let shown = -1;
    const showChaptersUpTo = (index) => {
      while (shown < index) { shown++; item('chapter', result.chapters[shown].line, result.chapters[shown].title); }
    };
    for (const ep of result.episodes) {
      if (ep.chapter !== null) showChaptersUpTo(ep.chapter);
      item('episode', ep.line, ep.title, `${[...ep.body].length.toLocaleString()}字`);
    }
    showChaptersUpTo(result.chapters.length - 1);
    list.replaceChildren(...items);
    const s = I.summarize(result);
    const cut = currentMask().filter((x) => x === 'line' || x === 'block').length;
    $('imp-count').textContent = `章 ${s.chapters}・話 ${s.episodes}・本文 ${s.chars.toLocaleString()}字`
      + (cut ? `・消す行 ${cut}` : '')
      + (s.headLines ? `・先頭の未解析 ${s.headLines}行` : '') + (s.warnings ? `・注意 ${s.warnings}件` : '');
  }

  function jumpToLine(line) {
    const row = rowEls[line];
    if (!row) return;
    row.scrollIntoView({ block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1200);
  }

  // ---------- 3. プレビュー ----------

  async function targetProject() {
    if (state.target === 'new') return null;
    const current = ctx.getProject();
    const src = current && current.id === state.target ? current : await ctx.db.get(state.target);
    return src ? normalize(clone(src)) : null;
  }

  async function buildRows() {
    const result = state.result || buildResult();
    state.result = result;
    const target = await targetProject();
    const items = result.episodes.map((e) => ({ ...e, chapterTitle: e.chapter === null ? '' : result.chapters[e.chapter]?.title || '' }));
    let dups = items.map((it) => ({ kind: 'none', target: null, action: 'add', hash: I.textHash(it.body) }));
    // 別サイト版を足すときか（取り込み先に、もう一方のサイトの原稿だけがある話がある）。
    // 同じサイトの TXT で更新するとき（なろう版の作品になろうの TXT など）は、増えた話はふつうに追加する
    // 作り直す（rebuild）：既存のエピソード・章はすべて消すので、照合しないで全部を新しい話として入れる
    state.replacing = !!target && state.mode === 'rebuild';
    state.crossSite = !!target && !state.replacing && target.episodes.some((e) => otherSiteOf(e) && !hasDraftOf(e, state.site));
    if (target && !state.replacing) {
      // 既存のエピソードと TXT の話を、タイトルで対にする（0.70）。
      // 取り込むサイト側のタイトル（前に取り込んだもの）を先に、もう一方のサイトのタイトルでも探す
      // （なろうがメインの作品にアルファの TXT なら、アルファのタイトル → なろうのタイトルの順）
      const entry = (e, title) => ({
        id: e.id,
        title,
        chapterTitle: target.chapters.find((c) => c.id === e.chapterId)?.title || '',
        body: draftOf(e, state.site).body,
        importKey: e.importKeys?.[state.site],
      });
      const existing = [
        ...target.episodes.map((e) => entry(e, draftOf(e, state.site).title || otherTitleOf(e))),
        // ほかのサイトのタイトルでも探す（取り込むサイトのタイトルと違うものだけ）
        ...target.episodes.flatMap((e) => {
          const mine = draftOf(e, state.site).title;
          const firstTitle = mine || otherTitleOf(e);
          return [...new Set(otherSites().map((s) => draftOf(e, s).title).filter((t) => t && t !== firstTitle))].map((t) => entry(e, t));
        }),
      ];
      // 対になった話は、そのエピソードのこのサイトの原稿へ入れる（すでに入っていれば、取り込み方に合わせて上書き／新しい稿）。
      // 本文がまったく同じ話だけはスキップ。各行の「扱い」で、追加・スキップ・取り込み先の指定に変えられる
      dups = I.findDuplicates(items, existing).map((d) => (d.kind === 'title' || d.kind === 'similar' ? { ...d, action: 'overwrite' } : d));
    }
    // 対にならない話を勝手に新しい話として足さない（エラーにして、各行で手動で決める）のは、
    // 別サイト版を足すとき・メインでない投稿先の原稿を取り込むとき。メインの原稿の更新では、増えた話はふつうに追加する
    const strict = !!target && !state.replacing && state.strictMatch && (state.crossSite || (target.site || 'narou') !== state.site);
    state.reorder = false; // ファイルの順に並べ替える（選んだときだけ。0.97）
    state.rows = items.map((it, i) => {
      const dup = dups[i];
      const action = strict && dup.kind === 'none' ? 'unmatched' : dup.action;
      return { it, dup, include: true, action, target: dup.target };
    });
    state.targetProject = target;
    // TXT の【ユーザ情報】【Nコード】と、設定に登録したアカウント・取り込み先の作品の Nコードを照合する
    state.siteInfo = I.extractSiteInfo(state.lines);
    // 作品名：TXT から読み取った作品名（従来どおり。読めなければファイル名）。
    // 取り込み先が新しい作品でも既存の作品でも、プレビューの欄にある名前をそのまま作品名として登録する
    state.txtTitle = result.head.title || state.fileName.replace(/^.*／\s*/, '').replace(/\.[^.]+$/, '');
    // 別サイト版を足すとき（なろう版の作品にアルファの TXT など）は、名前のある作品なら今の作品名のままにする
    // （作品の投稿先と違うサイトの原稿を取り込むとき。2回目以降の更新も同じ）
    const keepName = !!target && !state.replacing && !!(target.title || '').trim() && (state.crossSite || (target.site || 'narou') !== state.site);
    if (!state.workTitleEdited) state.workTitle = keepName ? target.title : state.txtTitle;
    const account = (ctx.prefs.get('accounts', {}) || {})[state.site] || {};
    state.mismatches = I.checkSiteInfo(state.siteInfo, account, state.site === 'narou' ? target?.narouNcode : '');
    // TXT の Nコードが対応付けられている作品（取り込み先とは別のとき）
    const code = state.siteInfo.ncode;
    state.ncodeOwner = code && target?.narouNcode !== code
      ? (await ctx.db.all()).find((p) => p.id !== target?.id && (p.narouNcode || '').toLowerCase() === code) || null
      : null;
    // 同じ Nコードの作品があるときは、続行を選ぶまで取り込まない（別の小説として登録する余地は残す）
    state.ncodeAck = false;
    // TXT の見た目と「取り込む原稿」が食い違うとき（なろうの TXT をアルファ用に、など）は、選び直すか続行を選ぶまで取り込まない
    const looks = txtSite();
    state.siteMismatch = looks && looks !== state.site ? looks : null;
    state.siteAck = false;
  }

  // TXT がどのサイトのものに見えるか：'narou'／'alpha'／'kakuyomu'／null（分からない）
  function txtSite() {
    if (isKakuyomu()) return 'kakuyomu';
    if (state.type === 'title-list') return 'alpha';
    const labels = state.siteInfo?.labels || [];
    if (state.siteInfo?.ncode || labels.some((l) => /^(Nコード|エピソードタイトル|ユーザ情報)$/.test(l))) return 'narou';
    return null;
  }

  function mismatchText() {
    return state.mismatches.map((m) => `・${m.label}：登録「${m.registered}」／TXT「${m.found}」`).join('\n');
  }

  function correspondenceError(row) {
    return `既存エピソードに、${SITES[state.site].short}用タイトル「${row.it.title || '（タイトルなし）'}」と対応するものがありませんでした。`;
  }

  function updateCorrespondenceErrors() {
    const box = $('imp-correspondence-errors');
    if (!box) return;
    const rows = state.rows.filter((row) => row.include && row.action === 'unmatched');
    box.hidden = !rows.length;
    box.textContent = rows.length
      ? `⚠ 対応付けできなかったエピソード ${rows.length}件\n${rows.map((row) => `・${correspondenceError(row)}`).join('\n')}\n\n各行の「扱い」で、取り込み先の指定・新しい話として追加・スキップを選べます。`
      : '';
  }

  function renderPreview() {
    const result = state.result;
    const target = state.targetProject;
    const s = I.summarize(result);
    const sum = $('imp-summary');
    sum.replaceChildren();
    // 作品名（この欄の名前で登録する）
    const l = Object.assign(document.createElement('label'), { className: 'imp-work-title', textContent: `作品名（${srcWord()} から読み込み。この欄の名前で登録します。書き換えられます）` });
    const input = Object.assign(document.createElement('input'), { type: 'text', value: state.workTitle, placeholder: '（無題）' });
    input.addEventListener('input', () => { state.workTitle = input.value; state.workTitleEdited = true; });
    l.append(input);
    sum.append(l);
    if (target) {
      sum.append(Object.assign(document.createElement('div'), { className: 'stat', textContent: `取り込み先：${target.title || '（無題）'}（${SITES[state.site].short}用の原稿${state.replacing ? '・作り直す' : ''}）` }));
      if (state.replacing) {
        const lost = otherLostText(target);
        sum.append(Object.assign(document.createElement('div'), {
          className: 'imp-info warn imp-replace-note',
          textContent: `⚠ 作り直す：取り込み先の今のエピソード ${target.episodes.length}話・章 ${target.chapters.length}件をすべて削除して、この ${srcWord()} の内容に入れ替えます。`
            + (lost ? `\n${lost}も一緒に消えます。対にして取り込む投稿先の原稿だけを変えるときは、最初の画面で「置き換える」を選んでください。` : '')
            + ((target.site || 'narou') !== state.site ? `\n作品のメインの投稿先も「${SITES[target.site || 'narou'].short}用」から「${SITES[state.site].short}用」に変わります。` : '')
            + '\n（取り込む前の状態は「バックアップ版」に残すので、あとから戻せます。設定資料・メモはそのままです）',
        }));
      }
      // 取り込み先に名前があって TXT と違うときは、どちらの名前にするかをボタンでも選べる（決めるのは登録する人）
      if ((target.title || '').trim() && state.txtTitle && target.title !== state.txtTitle) {
        const pickName = (text, value) => {
          const b = Object.assign(document.createElement('button'), { type: 'button', className: 'tool', textContent: text });
          b.addEventListener('click', () => { input.value = value; state.workTitle = value; state.workTitleEdited = true; });
          return b;
        };
        sum.append(pickName(`取り込み先の今の作品名「${target.title}」にする`, target.title), ' ',
          pickName(`${srcWord()} の作品名「${state.txtTitle}」にする`, state.txtTitle));
      }
    }
    if (state.mismatches.length) {
      sum.append(Object.assign(document.createElement('div'), {
        className: 'imp-info warn imp-mismatch',
        textContent: `⚠ TXT の情報が、設定（投稿サイト）に登録した内容と違います。別のアカウント・別の作品の TXT かもしれません。\n${mismatchText()}`,
      }));
    }
    if (state.siteMismatch) {
      const looks = SITES[state.siteMismatch].short;
      const now = SITES[state.site].short;
      const box = Object.assign(document.createElement('div'), {
        className: 'imp-info warn imp-site-mismatch',
        textContent: `⚠ この TXT は${looks}の TXT に見えますが、「インポート元」が「${now}」になっています。\n`,
      });
      const fix = Object.assign(document.createElement('button'), { type: 'button', className: 'tool primary', textContent: `${looks}用に切り替える` });
      fix.addEventListener('click', () => ctx.withBusy('プレビューを作り直しています…', async () => {
        const sf = sourceFormat(state.siteMismatch);
        applyFormat(sf.format, sf.id);
        ctx.prefs.set('importSite', state.site);
        fillPresets();
        renderRuleForm();
        await go(state.type === 'title-list' ? 2 : 3, { detect: true });
      }).catch(ctx.fail));
      const keep = Object.assign(document.createElement('button'), { type: 'button', className: 'tool', textContent: `このまま${now}用として取り込む` });
      keep.addEventListener('click', () => {
        state.siteAck = true;
        fix.disabled = true;
        keep.disabled = true;
        keep.textContent = `このまま${now}用として取り込む（選びました）`;
        updateCommitSummary();
      });
      box.append(fix, ' ', keep);
      sum.append(box);
    }
    if (state.ncodeOwner) {
      const label = target ? `「${target.title || '（無題）'}」への取り込みを続行` : '別の小説として登録を続行';
      const box = Object.assign(document.createElement('div'), {
        className: 'imp-info warn imp-ncode-owner',
        textContent: `⚠ この TXT の Nコード（${state.siteInfo.ncode}）は、作品「${state.ncodeOwner.title || '（無題）'}」に対応付けられています。その作品に取り込むなら、最初の画面で取り込み先を選び直してください。${target ? 'このまま選んだ作品に取り込むなら' : '同じ小説をもう一つ別の作品として登録するなら'}、「${label}」を押してください。\n`,
      });
      const go = Object.assign(document.createElement('button'), { type: 'button', className: 'tool', textContent: label });
      go.addEventListener('click', () => {
        state.ncodeAck = true;
        go.disabled = true;
        go.textContent = `${label}（選びました）`;
        updateCommitSummary();
      });
      box.append(go);
      sum.append(box);
    }
    if (target && !state.replacing && state.strictMatch) {
      sum.append(Object.assign(document.createElement('div'), {
        id: 'imp-correspondence-errors', className: 'imp-info warn imp-mismatch', hidden: true,
      }));
    }
    if (target && !state.replacing) {
      const filterLabel = Object.assign(document.createElement('label'), { className: 'imp-action-filter', textContent: '扱いを検索' });
      const filter = Object.assign(document.createElement('select'), { id: 'imp-action-filter', ariaLabel: '扱いを検索' });
      for (const [value, label] of [
        ['all', '全項目'], ['unmatched', '対応なし'], ['overwrite', '上書き'],
        ['add', '新しい話として追加'], ['skip', 'スキップ'], ['manual', '取り込み先を指定'],
      ]) filter.append(new Option(label, value));
      filter.value = state.actionFilter || 'all';
      filter.addEventListener('change', () => {
        state.actionFilter = filter.value;
        clearKeep();
        applyActionFilter();
      });
      filterLabel.append(filter);
      sum.append(filterLabel);
      // 対にならなかった話（と、似たタイトルで対にした話）だけを出す（0.70。どれが対応していないかを一目で見る）
      const onlyLabel = Object.assign(document.createElement('label'), { className: 'check imp-unpaired-only' });
      const only = Object.assign(document.createElement('input'), { type: 'checkbox', id: 'imp-unpaired-only', checked: !!state.unpairedOnly });
      only.addEventListener('change', () => { state.unpairedOnly = only.checked; clearKeep(); applyActionFilter(); });
      const nUnpaired = state.rows.filter((r) => r.dup.kind !== 'title' && r.dup.kind !== 'same').length;
      onlyLabel.append(only, ` 対になっていない話だけ表示（${nUnpaired}話。似たタイトルで対にした話も含む）`);
      sum.append(onlyLabel);
    }
    // 目次順とファイルの順が違うとき：ファイルの順に並べ替えるか選ぶ（目次順は3サイト共通。0.97）
    if (target && !state.replacing) {
      const l = Object.assign(document.createElement('label'), { id: 'imp-reorder', className: 'check', hidden: true });
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !!state.reorder });
      cb.addEventListener('change', () => { state.reorder = cb.checked; updateCommitSummary(); });
      l.append(cb, Object.assign(document.createElement('span'), { className: 'imp-reorder-text' }));
      sum.append(l);
    }
    if (isKakuyomu()) renderKakuyomuInfo(sum, target);
    const stat = (t) => sum.append(Object.assign(document.createElement('div'), { className: 'stat', textContent: t }));
    if (state.siteInfo?.ncode) stat(`TXT の Nコード ${state.siteInfo.ncode}`);
    stat(`章 ${s.chapters}`);
    stat(`話 ${s.episodes}`);
    stat(`本文 ${s.chars.toLocaleString()}字`);
    stat(`前書き ${s.forewords}・後書き ${s.afterwords}`);
    stat(`画像タグ ${s.images}`);
    if (s.warnings) stat(`⚠ 注意 ${s.warnings}件`);
    if (result.head.lines.length) {
      const d = document.createElement('details');
      d.append(Object.assign(document.createElement('summary'), { textContent: isKakuyomu() ? `紹介文 ${result.head.lines.length}行` : `先頭の未解析の行（作品情報など）${result.head.lines.length}行` }),
        Object.assign(document.createElement('pre'), { textContent: result.head.lines.join('\n') }));
      const l = Object.assign(document.createElement('label'), { className: 'inline' });
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: state.useHead && (!target || state.replacing || !target.synopsis) });
      state.useHead = cb.checked;
      cb.addEventListener('change', () => { state.useHead = cb.checked; });
      l.append(cb, target?.synopsis ? ' あらすじ欄に入れる（取り込み先のあらすじは空でないため、入れると上書きになります）' : isKakuyomu() ? ' 作品のあらすじ欄に入れる' : ' タイトル行以外を、作品のあらすじ欄に入れる');
      d.append(l);
      sum.append(d);
    }
    renderTable();
  }

  // 作り直すと消える、ほかのサイトの原稿（「なろう用 3話分・アルファ用 2話分」。なければ空）
  function otherLostText(target) {
    return otherSites().map((s) => [s, target.episodes.filter((e) => hasDraftOf(e, s)).length])
      .filter(([, n]) => n).map(([s, n]) => `${SITES[s].short}用の原稿（${n}話分）`).join('・');
  }

  // カクヨムのバックアップの作品情報（キャッチコピー・タグ・目次の注意）。v4
  function renderKakuyomuInfo(sum, target) {
    const k = state.kakuyomu;
    const box = Object.assign(document.createElement('div'), { className: 'imp-info imp-kakuyomu' });
    const lines = [
      `キャッチコピー：${k.catchphrase || '（なし）'}`,
      `タグ：${k.tags.length ? k.tags.join('・') : '（なし）'}`,
      ...k.info.map(([label, v]) => `${label}：${v}`),
    ];
    box.textContent = lines.join('\n');
    sum.append(box);
    if (k.warnings.length) {
      sum.append(Object.assign(document.createElement('div'), { className: 'imp-info warn', textContent: k.warnings.map((w) => `⚠ ${w}`).join('\n') }));
    }
    const check = (text, checked, onChange) => {
      const l = Object.assign(document.createElement('label'), { className: 'check imp-k-check' });
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked });
      cb.addEventListener('change', () => onChange(cb.checked));
      l.append(cb, ` ${text}`);
      sum.append(l);
    };
    const hasInfo = !!(target && (target.kakuyomu?.catchphrase || target.kakuyomu?.tags?.length));
    if (k.catchphrase || k.tags.length) {
      state.kakuyomuInfo = state.kakuyomuInfo && (!hasInfo || state.replacing);
      check(hasInfo ? 'キャッチコピー・タグを作品情報に入れる（今の内容は上書き）' : 'キャッチコピー・タグを作品情報に入れる', state.kakuyomuInfo, (v) => { state.kakuyomuInfo = v; });
    }
    // 短編：新しい作品・作り直すときだけ（1話のとき）
    if ((!target || state.replacing) && k.episodes.length === 1) {
      check('短編として登録', state.shortStory, (v) => { state.shortStory = v; });
    }
    // 大見出し・小見出しはカクヨムだけの作品で使う（0.97）。小見出しがあるかで自動で決める
    // （なろう・アルファは章が1段だけなので、小見出しのある作品はカクヨムだけの作品。大見出しだけなら3サイトの章と同じ）
    const info = (text) => sum.append(Object.assign(document.createElement('div'), { className: 'imp-info', textContent: text }));
    const hasSub = (k.chapters || []).some((c) => c.level === 2);
    if (hasSub && !target) info('小見出しがあるので、カクヨムだけの作品として取り込みます');
    else if (hasSub && target && !(target.sites?.length === 1 && target.sites[0] === 'kakuyomu')) info('この作品はほかのサイトも使うので、大見出し・小見出しは章として並びます');
  }

  function renderTable() {
    const target = state.targetProject;
    const table = $('imp-preview');
    const head = ['取込', '章', 'タイトル', '本文', '前書き', '後書き', '画像', '注意'];
    if (target && !state.replacing) head.push('既存との関係', '扱い');
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const h of head) tr.append(Object.assign(document.createElement('th'), { textContent: h }));
    thead.append(tr);
    const tbody = document.createElement('tbody');
    const targetEpName = (id) => {
      const e = target?.episodes.find((x) => x.id === id);
      if (!e) return '';
      const no = target.episodes.indexOf(e) + 1;
      return `第${no}話「${draftOf(e, state.site).title || SITE_KEYS.map((s) => draftOf(e, s).title).find(Boolean) || '（無題）'}」`;
    };
    // 対にした話への入れ方（取り込む投稿先の原稿がまだなければ「入れる」、あれば取り込み方に合わせて「置き換え」か「新しい稿」）
    const pairLabel = (id) => {
      const short = SITES[state.site].short;
      const e = target?.episodes.find((x) => x.id === id);
      if (!e || !siteHasDraft(e)) return `対にして${short}用に入れる`;
      return state.mode === 'edition' ? `${short}用の新しい稿として追加` : `${short}用の原稿を置き換え`;
    };
    state.rows.forEach((row, i) => {
      const { it, dup } = row;
      const r = document.createElement('tr');
      r.dataset.action = row.action;
      r.dataset.paired = dup.kind === 'title' || dup.kind === 'same' ? 'yes' : 'no';
      if (!row.include) r.className = 'excluded';
      const td = (content, cls = '') => {
        const c = Object.assign(document.createElement('td'), { className: cls });
        if (content instanceof Node) c.append(content); else c.textContent = content;
        r.append(c);
        return c;
      };
      const inc = Object.assign(document.createElement('input'), { type: 'checkbox', checked: row.include });
      inc.setAttribute('aria-label', `${it.title || i + 1}を取り込む`);
      inc.addEventListener('change', () => { row.include = inc.checked; r.classList.toggle('excluded', !row.include); updateCommitSummary(); });
      td(inc);
      td(it.chapterTitle || '未分類');
      // 話のタイトルは、ここで書き換えられる（取り込むときにこの値を使う）
      const title = Object.assign(document.createElement('input'), { type: 'text', value: it.title || '', placeholder: '（タイトルなし）', className: 'imp-title-input' });
      title.setAttribute('aria-label', `${i + 1}話目のタイトル`);
      title.addEventListener('input', () => { it.title = title.value.trim(); });
      td(title);
      td(`${[...it.body].length.toLocaleString()}字`);
      td(it.foreword ? 'あり' : '―');
      td(it.afterword ? 'あり' : '―');
      td(String(countImages(it.body) || '―'));
      td(it.warnings.join('／') || '―', it.warnings.length ? 'warn' : '');
      if (target && !state.replacing) {
        const relation = {
          same: `同じ本文：${targetEpName(dup.target)}`,
          title: `同じタイトル：${targetEpName(dup.target)}`,
          similar: `似たタイトル：${targetEpName(dup.target)}`,
        }[dup.kind] || (row.action === 'unmatched' ? correspondenceError(row) : '新しい話');
        const relCell = td(relation, relClass(row.action));
        const cell = td('');
        const act = document.createElement('select');
        act.setAttribute('aria-label', '扱い');
        const opts = [['add', '新しい話として追加'], ['skip', 'スキップ'], ['manual', '取り込み先を指定…']];
        if (row.action === 'unmatched') opts.unshift(['unmatched', '対応なし（エラー）']);
        if (dup.target) opts.unshift(['overwrite', pairLabel(dup.target)]);
        for (const [v, t] of opts) act.append(new Option(t, v));
        act.value = row.action;
        // 取り込み先を指定：別の画面でエピソードを選ぶ（0.93）。選んだ先は扱いの下に出し、「変える…」で選び直せる
        const picked = Object.assign(document.createElement('div'), { className: 'imp-picked' });
        const pickedName = document.createElement('span');
        const change = Object.assign(document.createElement('button'), { type: 'button', className: 'tool', textContent: '変える…' });
        picked.append(pickedName, change);
        const showPicked = () => {
          picked.hidden = row.action !== 'manual';
          pickedName.textContent = row.action === 'manual' ? `→ ${targetEpName(row.target)}` : '';
        };
        const setAction = (v) => {
          row.action = v;
          act.value = v;
          r.dataset.action = v;
          r.dataset.keep = '1'; // 扱いを変えた行は、絞り込みを選び直すまで出したままにする
          relCell.className = relClass(v);
          if (v === 'overwrite') row.target = dup.target;
          showPicked();
          updateCommitSummary();
        };
        const choosePair = async () => {
          const id = await pickTargetEpisode(row, targetEpName);
          if (!id) return false;
          row.target = id;
          setAction('manual');
          return true;
        };
        act.addEventListener('change', async () => {
          if (act.value !== 'manual') { setAction(act.value); return; }
          act.value = row.action; // 選ぶまでは元の扱いのまま
          await choosePair();
        });
        change.addEventListener('click', () => { choosePair(); });
        showPicked();
        cell.append(act, picked);
      }
      tbody.append(r);
    });
    table.replaceChildren(thead, tbody);
    updateCommitSummary();
  }

  // 「取り込み先を指定…」の画面。TXT の話と、取り込み先の作品のエピソードの一覧を出して一つ選ぶ。戻り値：エピソードの id（キャンセルは null）
  function pickTargetEpisode(row, targetEpName) {
    const target = state.targetProject;
    const dlg = $('imp-pair-dialog');
    const { it } = row;
    const head = (s) => [...(s || '').replace(/\s+/g, ' ').trim()].slice(0, 60).join('');
    // ほかの行ですでに取り込み先にしているエピソード
    const usedBy = new Map();
    state.rows.forEach((x, n) => {
      if (x !== row && x.include && (x.action === 'overwrite' || x.action === 'manual') && x.target) usedBy.set(x.target, n + 1);
    });
    const src = $('imp-pair-src');
    src.replaceChildren(
      Object.assign(document.createElement('div'), { className: 'imp-pair-src-title', textContent: `${SITES[state.site].short}用：${it.title || '（タイトルなし）'}（${[...it.body].length.toLocaleString()}字）` }),
      Object.assign(document.createElement('div'), { className: 'imp-pair-src-body', textContent: head(it.body) || '（本文なし）' }),
    );
    let chosen = row.action === 'manual' ? row.target : (row.dup.target || '');
    const list = $('imp-pair-list');
    const search = $('imp-pair-search');
    search.value = '';
    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren();
      target.episodes.forEach((e, n) => {
        const mine = draftOf(e, state.site);
        const other = otherSiteOf(e) || otherSites()[0];
        const theirs = draftOf(e, other);
        const titles = [mine.title && `${SITES[state.site].short}：${mine.title}`, ...otherSites().filter((s) => draftOf(e, s).title).map((s) => `${SITES[s].short}：${draftOf(e, s).title}`)].filter(Boolean).join('　') || '（無題）';
        if (q && !titles.toLowerCase().includes(q)) return;
        const label = Object.assign(document.createElement('label'), { className: 'imp-pair-item' + (e.id === chosen ? ' selected' : '') });
        const radio = Object.assign(document.createElement('input'), { type: 'radio', name: 'imp-pair', value: e.id, checked: e.id === chosen });
        radio.addEventListener('change', () => { chosen = e.id; render(); });
        const text = document.createElement('span');
        text.append(Object.assign(document.createElement('b'), { textContent: `第${n + 1}話　` }), titles);
        const meta = [
          `${SITES[other].short}用 ${[...(theirs.body || '')].length.toLocaleString()}字`,
          `${SITES[state.site].short}用 ${mine.body ? `${[...mine.body].length.toLocaleString()}字（置き換え）` : 'なし'}`,
          usedBy.has(e.id) ? `⚠ ${srcWord()} の${usedBy.get(e.id)}話目の取り込み先` : '',
        ].filter(Boolean).join('・');
        text.append(Object.assign(document.createElement('small'), { textContent: meta }));
        const peek = head(theirs.body || mine.body);
        if (peek) text.append(Object.assign(document.createElement('small'), { className: 'imp-pair-peek', textContent: peek }));
        label.append(radio, text);
        list.append(label);
      });
      if (!list.children.length) list.append(Object.assign(document.createElement('p'), { className: 'hint', textContent: '見つかりません' }));
      $('imp-pair-ok').disabled = !chosen;
    };
    return new Promise((resolve) => {
      let result = null;
      const ac = new AbortController();
      const opt = { signal: ac.signal };
      search.addEventListener('input', render, opt);
      $('imp-pair-ok').addEventListener('click', () => { result = chosen || null; dlg.close(); }, opt);
      $('imp-pair-cancel').addEventListener('click', () => dlg.close(), opt);
      dlg.addEventListener('close', () => { ac.abort(); resolve(result); }, opt);
      render();
      dlg.showModal();
      list.querySelector('.selected')?.scrollIntoView({ block: 'center' });
    });
  }

  // 既存との関係の文字色は「扱い」で決める（0.71）：上書き・取り込み先指定＝黒、スキップ＝灰色、新しい話として追加＝青、対応なし＝赤
  function relClass(action) {
    return { skip: 'rel-skip', add: 'rel-add', unmatched: 'rel-unmatched' }[action] || 'rel-overwrite';
  }

  // 絞り込みを選び直したときは、扱いを変えた行も絞り込みに従わせる
  function clearKeep() {
    document.querySelectorAll('#imp-preview tbody tr[data-keep]').forEach((row) => { delete row.dataset.keep; });
  }

  function applyActionFilter() {
    const wanted = state.actionFilter || 'all';
    document.querySelectorAll('#imp-preview tbody tr').forEach((row) => {
      if (row.dataset.keep) return; // 扱いを変えたばかりの行は消さない
      row.hidden = (wanted !== 'all' && row.dataset.action !== wanted) || (!!state.unpairedOnly && row.dataset.paired === 'yes');
    });
  }

  // 取り込み先のエピソードに、取り込む投稿先の原稿がもうあるか
  function siteHasDraft(e) {
    const d = draftOf(e, state.site);
    return !!((d.title || '').trim() || (d.body || '').trim());
  }

  // 対にした取り込み先のエピソード（追加・スキップの行は null）
  function pairTarget(row) {
    if (!(row.action === 'overwrite' || row.action === 'manual')) return null;
    return state.targetProject?.episodes.find((x) => x.id === row.target) || null;
  }

  // 件数の文（「追加 1話・対にして入れる 2話・置き換え 0話…」。0 の項目は「追加」「スキップ」以外は出さない）
  function countText(c, editionNote = '') {
    return [`追加 ${c.add}話`, c.pair && `対にして入れる ${c.pair}話`, (c.overwrite || !(c.pair + c.edition)) && `置き換え ${c.overwrite}話`,
      c.edition && `新しい稿 ${c.edition}話${editionNote}`, `スキップ ${c.skip}話`].filter(Boolean).join('・');
  }

  // 新しい稿にする話か（「新しい稿として追加」で、対にした話に取り込む投稿先の原稿がもうあるとき）
  function asEdition(row) {
    if (state.mode !== 'edition' || !(row.action === 'overwrite' || row.action === 'manual')) return false;
    const e = state.targetProject?.episodes.find((x) => x.id === row.target);
    return !!e && siteHasDraft(e);
  }

  function counts() {
    let add = 0;
    let overwrite = 0;
    let edition = 0;
    let pair = 0; // 対にして入れる（取り込む投稿先の原稿がまだない話）
    let skip = 0;
    let errors = 0;
    for (const row of state.rows) {
      if (!row.include || row.action === 'skip') skip++;
      else if (row.action === 'unmatched') { errors++; skip++; }
      else if (!state.targetProject || row.action === 'add') add++;
      else if (asEdition(row)) edition++;
      else if (pairTarget(row) && !siteHasDraft(pairTarget(row))) pair++;
      else overwrite++;
    }
    return { add, pair, overwrite, edition, skip, errors };
  }

  // ファイルの順に並べる話（対にした話。スキップも含む）。newIds（行 → 新しく足した話の ID）を渡すと、新しい話も入れる
  function fileOrderIds(newIds = null) {
    const out = [];
    for (const row of state.rows) {
      const paired = row.action === 'skip' || (row.include && (row.action === 'overwrite' || row.action === 'manual'));
      const id = paired ? row.target : newIds?.get(row);
      if (id && !out.includes(id)) out.push(id);
    }
    return out;
  }

  // ファイルの順にすると位置が変わる話の数（新しく足す話は数えない）
  function orderChanges() {
    const t = state.targetProject;
    if (!t || state.replacing) return 0;
    return episodeOrderFromFile(t, fileOrderIds()).changed;
  }

  function updateCommitSummary() {
    const c = counts();
    const moved = orderChanges();
    const box = $('imp-reorder');
    if (box) {
      box.hidden = !moved;
      box.querySelector('.imp-reorder-text').textContent = ` 目次順を${srcWord()}の順に並べ替える（${moved}話）`;
    }
    c.moved = state.reorder ? moved : 0;
    const siteWaiting = state.siteMismatch && !state.siteAck;
    const waiting = siteWaiting || (state.ncodeOwner && !state.ncodeAck);
    $('imp-commit-summary').textContent = (state.replacing ? `作り直す（今の ${state.targetProject.episodes.length}話を削除）・` : '') + countText(c) + (c.errors ? `・未対応 ${c.errors}話` : '')
      + (c.moved ? `・並べ替え ${c.moved}話` : '')
      + (siteWaiting ? '（「取り込む原稿」を確かめてください。上のボタンで選ぶと取り込めます）'
        : waiting ? '（同じ Nコードの作品があります。上の「続行」を押すと取り込めます）' : '');
    $('imp-commit').disabled = !(c.add + c.pair + c.overwrite + c.edition + c.moved) || waiting;
    updateCorrespondenceErrors();
    applyActionFilter();
  }

  // ---------- 確定 ----------

  // ---------- 画像の対応（0.94） ----------
  // 置き換える・新しい稿として追加で、取り込み先の話の原稿（取り込むサイト）に画像があるとき、
  // TXT の画像と前後の文で組み合わせ、今の画像タグを残したまま文章だけを入れ替える。
  // 枚数が同じで、どの組も前後の文が似ている話は自動。それ以外の話だけを「画像の確認」に出す。
  // 戻り値：Map（行 → Map（項目 → 組み合わせ））。キャンセルは null
  const IMAGE_FIELDS = ['body', 'foreword', 'afterword'];
  function imageFieldsOf(row) {
    const dest = pairTarget(row);
    if (!dest || state.replacing) return [];
    if (state.site === 'kakuyomu') return []; // カクヨムには挿絵がないので確かめない（0.97）
    const out = [];
    for (const f of IMAGE_FIELDS) {
      if (f !== 'body' && !row.it[f]) continue; // TXT に前書き・後書きがなければ、今のものがそのまま残る
      const destText = draftOf(dest, state.site)[f] || '';
      if (!imageSlots(destText).length) continue;
      const src = row.it[f] || '';
      const sc = imageSlots(src).map((s) => contextOf(src, s));
      const dc = imageSlots(destText).map((s) => contextOf(destText, s));
      const map = suggestPairs(sc, dc);
      const sure = sc.length === dc.length && map.every((j, k) => j >= 0 && pairScore(sc[k], dc[j]) >= PAIR_WEAK);
      out.push({ f, src, dest: destText, sc, dc, map, sure });
    }
    return out;
  }

  async function planImages() {
    const plans = new Map();
    const unsure = [];
    let auto = 0;
    for (const row of state.rows) {
      if (!row.include) continue;
      const fields = imageFieldsOf(row);
      if (!fields.length) continue;
      plans.set(row, new Map(fields.map((x) => [x.f, x.map])));
      if (fields.every((x) => x.sure)) auto++;
      else unsure.push({ row, fields, checked: false });
    }
    if (!unsure.length) return { plans, auto };
    const ok = await imageCheckList(unsure, plans, auto);
    return ok ? { plans, auto } : null;
  }

  // 「画像の確認」：自動で決められなかった話の一覧。「確かめる…」で話ごとに組み合わせを見る・直す
  function imageCheckList(unsure, plans, auto) {
    const dlg = $('imp-image-dialog');
    const fieldName = { body: '本文', foreword: '前書き', afterword: '後書き' };
    const epName = (row) => {
      const e = pairTarget(row);
      const no = state.targetProject.episodes.indexOf(e) + 1;
      return `第${no}話「${row.it.title || draftOf(e, state.site).title || '（無題）'}」`;
    };
    $('imp-image-info').textContent = `確かめる話 ${unsure.length}話${auto ? `（前後の文が同じ ${auto}話は、今の画像タグのまま自動で入れます）` : ''}`;
    const render = () => {
      const list = $('imp-image-list');
      list.replaceChildren();
      for (const u of unsure) {
        const item = Object.assign(document.createElement('div'), { className: 'imp-image-item' });
        const text = document.createElement('div');
        text.append(Object.assign(document.createElement('b'), { textContent: epName(u.row) }));
        const notes = u.fields.map((x) => {
          const map = plans.get(u.row).get(x.f);
          const weak = map.some((j, k) => j >= 0 && pairScore(x.sc[k], x.dc[j]) < PAIR_WEAK);
          const why = x.sc.length !== x.dc.length ? '⚠ 枚数が違います' : weak || map.includes(-1) ? '⚠ 前後の文が違います' : '';
          return `${fieldName[x.f]}：${srcWord()} ${x.sc.length}枚・今 ${x.dc.length}枚${why && !u.checked ? `　${why}` : ''}`;
        });
        for (const n of notes) text.append(Object.assign(document.createElement('small'), { textContent: n }));
        const side = Object.assign(document.createElement('div'), { className: 'imp-image-side' });
        if (u.checked) side.append(Object.assign(document.createElement('span'), { className: 'imp-image-done', textContent: '確認済み' }));
        const btn = Object.assign(document.createElement('button'), { type: 'button', textContent: '確かめる…' });
        btn.addEventListener('click', async () => {
          const maps = await ctx.imageMatchDialog(
            u.fields.map((x) => ({ f: x.f, src: x.src, dest: x.dest })), state.site,
            { title: `画像の対応：${epName(u.row)}`, src: srcWord(), dst: '今の原稿', srcNote: `${srcWord()} の画像をそのまま入れます` },
          );
          if (!maps) return;
          for (const [f, map] of maps) plans.get(u.row).set(f, map);
          u.checked = true;
          render();
        });
        side.append(btn);
        item.append(text, side);
        list.append(item);
      }
    };
    return new Promise((resolve) => {
      let result = false;
      const ac = new AbortController();
      const opt = { signal: ac.signal };
      $('imp-image-ok').addEventListener('click', () => { result = true; dlg.close(); }, opt);
      $('imp-image-cancel').addEventListener('click', () => dlg.close(), opt);
      dlg.addEventListener('close', () => { ac.abort(); resolve(result); }, opt);
      render();
      dlg.showModal();
    });
  }

  async function commit() {
    const c = counts();
    const moved = state.reorder ? orderChanges() : 0; // 並べ替えだけでも取り込める
    if (!(c.add + c.pair + c.overwrite + c.edition) && !moved) return;
    const target = state.targetProject;
    // 取り込み先の画像との対応（自動で決められない話だけ、先に確かめてもらう）
    const images = target ? await planImages() : { plans: new Map(), auto: 0 };
    if (!images) return;
    const title = (state.workTitle || '').trim();
    const rename = target && title && title !== (target.title || '');
    const name = (rename ? `${target.title || '（無題）'}（作品名を「${title}」に変更）` : target ? target.title : title) || '（無題）';
    // 登録と違う情報があれば、先に警告する（OK で続ける／キャンセルで中止）
    if (state.mismatches.length && !(await ask(`⚠ TXT の情報が、設定に登録した内容と違います。\n${mismatchText()}\n\n別のアカウント・別の作品の TXT かもしれません。このまま取り込みますか？`, { danger: true, ok: '取り込む' }))) return;
    // 作り直すと消える、ほかの投稿先の原稿（なろうがメインの作品をアルファの TXT で作り直すと、なろう用の原稿が消える）
    const otherLost = state.replacing ? otherLostText(target) : '';
    if (state.replacing && !(await ask(`「${name}」を作り直します。\n今のエピソード ${target.episodes.length}話・章 ${target.chapters.length}件をすべて削除して、この ${srcWord()} の ${c.add}話に入れ替えます。${otherLost ? `\n⚠ ${otherLost}もすべて消えます。ほかのサイトの話と対にしたいときは、キャンセルして「置き換える」を選んでください。` : ''}${(target.site || 'narou') !== state.site ? `\nメインの投稿先も「${SITES[state.site].short}用」に変わります。` : ''}\n（取り込む前の状態は「バックアップ版」に残します）\nよろしいですか？`, { danger: true, ok: '作り直す' }))) return;
    if (!state.replacing && !(await ask(`「${name}」に、${SITES[state.site].label}用の原稿として\n${countText(c, '（今の稿は残ります）')}${c.errors ? `（うち未対応 ${c.errors}話）` : ''}${moved ? `\n目次順を ${moved}話並べ替えます（3サイト共通）` : ''}\nで取り込みます。よろしいですか？`, { ok: '取り込む' }))) return;
    const btn = $('imp-commit');
    btn.disabled = true;
    try {
      await ctx.withBusy(`${srcWord()}を取り込んでいます…`, async () => {
      await ctx.flush();
      const now = new Date().toISOString();
      let p;
      const newIds = new Map(); // 行 → 新しく足した話の ID（ファイルの順に並べ替えるとき用）
      // 取り込み先が中身のない話だけの作品（無題の新しい作品など）なら、その空の話は取り込んだあと消す（0.92）。
      // 置き換えなので、空の「無題」の話が紛れ込まないようにする
      const blankIds = target && !state.replacing && target.episodes.every(isBlankEpisode) ? new Set(target.episodes.map((e) => e.id)) : null;
      if (target) {
        p = target; // 読み込み直した複製。保存するまで本物は変わらない
        // 取り込む前の状態を作品全体のバックアップ版に残す（取り消し用）
        await ctx.versions.put({
          id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
          kind: 'project', projectId: p.id, name: 'インポート前（自動）',
          memo: `${new Date().toLocaleString('ja-JP')} に「${state.fileName}」を取り込む前の状態`,
          auto: false, createdAt: now,
          chars: p.episodes.reduce((n, e) => n + countChars(draftOf(e, p.site).body).all, 0),
          episodes: p.episodes.length,
          data: JSON.parse(serialize(p)).project,
        });
        // 作り直す：今のエピソード・章をすべて消してから、TXT の話を入れる
        if (state.replacing) {
          p.chapters = [];
          p.episodes = [];
          // 別サイトの TXT で作り直すと、今のメインの原稿は空になるので、メインを TXT のサイトにする
          p.site = state.site;
        }
      } else {
        // 新しい作品は3サイトとも使う（取り込んだサイトがメイン。要らないサイトは「使う投稿サイト」で外せる：0.97）
        p = isKakuyomu() && state.kakuyomuOnly && state.result.chapters.length
          ? newProject({ title, site: 'kakuyomu', sites: ['kakuyomu'] })
          : newProject({ title, site: state.site });
        p.chapters = [];
        p.episodes = [];
      }
      // 取り込んだサイトを、作品で使う投稿サイトに加える（v4）
      p.sites = normalizeSites([...(p.sites || []), state.site], p.site);
      // 章：同じ名前の章があればそれを使い、なければ作る
      const chapterIds = new Map();
      const findOrCreateChapter = (index) => {
        if (index === null || index === undefined) return null;
        if (chapterIds.has(index)) return chapterIds.get(index);
        const src = state.result.chapters[index];
        const title = src?.title || '';
        // カクヨムの小見出しは、先にその大見出しを作る。大見出し・小見出しは level も合うものを使う（0.97）。
        // ただし大見出し・小見出しを使わない作品（ほかのサイトも使う作品）では章は1段なので、名前だけで今の章を探す
        // （なろうの「旅の空」とカクヨムの大見出し「旅の空」を別の章にしない）。話のない大見出しも足さない
        const headings = p.sites.length === 1 && p.sites[0] === 'kakuyomu';
        const level = (src?.level === 1 || src?.level === 2) && headings ? src.level : null;
        if (level === 2) {
          for (let j = index - 1; j >= 0; j--) {
            if (state.result.chapters[j]?.level === 1) { findOrCreateChapter(j); break; }
          }
        }
        // カクヨムの新しい作品・作り直しでは、目次の見出しを1つずつ作る（同じ名前の見出しが2つあっても別々に。なろう・アルファは今までどおり）
        let ch = (!isKakuyomu() || (target && !state.replacing)) && p.chapters.find((x) => I.normalizeTitle(x.title) === I.normalizeTitle(title)
          && (level === null || (x.level === 1 ? 1 : 2) === level));
        // 新しく作る章は、カクヨムの段（level）を残す（カクヨムだけの作品にしたとき、大見出し・小見出しで並ぶ）
        const keep = src?.level === 1 || src?.level === 2 ? src.level : null;
        if (!ch) { ch = newChapter(keep ? { title, level: keep } : { title }); p.chapters.push(ch); }
        chapterIds.set(index, ch.id);
        return ch.id;
      };
      // カクヨムの新しい作品・作り直し：話のない見出しも、目次のとおりに作る（0.97）
      if (isKakuyomu() && (!target || state.replacing)) state.result.chapters.forEach((_, i) => findOrCreateChapter(i));
      for (const row of state.rows) {
        if (!row.include || row.action === 'skip' || row.action === 'unmatched') continue;
        const { it, dup } = row;
        const dest = target && (row.action === 'overwrite' || row.action === 'manual') ? p.episodes.find((e) => e.id === row.target) : null;
        if (dest) {
          // 取り込む投稿先の原稿だけを変える（もう一方の投稿先の原稿・プロット・フリーメモはそのまま）
          const draft = { body: it.body };
          if (it.title) draft.title = it.title;
          if (it.foreword) draft.foreword = it.foreword;
          if (it.afterword) draft.afterword = it.afterword;
          // 今の原稿にある画像タグは残し、文章だけを入れ替える（0.94）
          for (const [f, map] of images.plans.get(row) || []) {
            draft[f] = applyImageMap(state.site, state.site, it[f] || '', draftOf(dest, state.site)[f] || '', map).text;
          }
          if (asEdition(row)) {
            // 新しい稿として追加：今の稿は今の内容のまま残し、取り込んだ内容を次の番号の稿にする
            await ctx.importAsNewEdition(p, dest, state.site, draft);
          } else {
            Object.assign(dest.drafts[state.site], draft); // 置き換える（まだ原稿がなければ、そのまま入れる）
            dest.siteUpdatedAt = { ...(dest.siteUpdatedAt || {}), [state.site]: now };
          }
          dest.importKeys = { ...(dest.importKeys || {}), [state.site]: dup.hash };
          dest.updatedAt = now;
        } else {
          const ep = newEpisode({ chapterId: findOrCreateChapter(it.chapter), importKeys: { [state.site]: dup.hash } });
          ep.drafts[state.site] = { title: it.title, foreword: it.foreword, body: it.body, afterword: it.afterword };
          p.episodes.push(ep);
          newIds.set(row, ep.id);
        }
      }
      if (blankIds && p.episodes.some((e) => !blankIds.has(e.id))) p.episodes = p.episodes.filter((e) => !blankIds.has(e.id) || !isBlankEpisode(e));
      if (!p.episodes.length) p.episodes.push(newEpisode());
      // 並びを「章の順 → 章の中の順 → 未分類」に揃える
      const pos = new Map(p.chapters.map((ch, i) => [ch.id, i]));
      p.episodes = p.episodes.map((e, i) => ({ e, i, k: pos.has(e.chapterId) ? pos.get(e.chapterId) : Infinity }))
        .sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.e);
      // 選んだときは、目次順をファイルの順にする（章の中だけ。ファイルにない話は今の位置のまま）
      if (target && !state.replacing && state.reorder) {
        const byId = new Map(p.episodes.map((e) => [e.id, e]));
        p.episodes = episodeOrderFromFile(p, fileOrderIds(newIds)).ids.map((id) => byId.get(id));
      }
      // プレビューで書き換えた作品名（既存の作品は、書き換えたときだけ変える）
      if (rename) p.title = title;
      // 先頭の未解析の行（タイトル行以外）をあらすじへ
      if (state.useHead && state.result.head.lines.length) {
        // カクヨムの紹介文には題名の行がないので、そのまま入れる
        const lines = isKakuyomu() ? state.result.head.lines
          : state.result.head.lines.filter((l, i) => !(i === state.result.head.lines.findIndex((x) => x.trim()) && l.trim() === state.result.head.title));
        const text = lines.join('\n').trim();
        if (text) p.synopsis = text;
      }
      // カクヨムの作品情報・短編（v4）
      if (isKakuyomu()) {
        const k = state.kakuyomu;
        if (state.kakuyomuInfo && (k.catchphrase || k.tags.length)) p.kakuyomu = { ...(p.kakuyomu || {}), catchphrase: k.catchphrase, tags: [...k.tags] };
        if ((!target || state.replacing) && p.episodes.length === 1) p.shortStory = !!state.shortStory;
      }
      // 作品の Nコードが空なら、TXT の Nコードを入れる（なろう用として取り込むとき）
      if (state.site === 'narou' && state.siteInfo?.ncode && !p.narouNcode) {
        p.narouNcode = state.siteInfo.ncode;
        if (!p.narouUrl) p.narouUrl = `https://ncode.syosetu.com/${p.narouNcode}/`;
      }
      p.updatedAt = now;
      await ctx.switchTo(p);
      await clearSession();
      close(true);
      ctx.closeSettings();
      ctx.returnToEditor();
      ctx.toast(`取り込みました：${countText(c)}${target ? '（取り込む前の状態は「バックアップ版」に残しました）' : ''}`);
      });
    } catch (e) {
      ctx.fail(e);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 画面の切り替え ----------

  async function go(step, { detect: doDetect = false } = {}) {
    if (step >= 2 && !state.text) { ctx.toast('先に TXT ファイルを選んでください'); return; }
    // カクヨムのバックアップ：ファイル → プレビュー（区切りの画面はない）
    if (isKakuyomu() && (step === 2 || step === 3)) step = step < state.step ? 1 : 4;
    if (step === 2 && state.type !== 'title-list') step = 3;
    if (step >= 3 && state.type === 'title-list' && !state.titleListText.trim()) { ctx.toast('タイトル一覧のファイルを選ぶか、一覧を貼り付けてください'); return; }
    if (step === 3) {
      autoNarouFormat();
      fillPresets();
      renderRuleForm();
      if (doDetect || !state.auto.size) detect({ confirmFirst: false });
      else renderMarks();
    }
    if (step === 4) {
      if (!isKakuyomu() && !$('imp-pending').hidden && !(await detect({ confirmFirst: false }))) return;
      if (!isKakuyomu() && !validateRules()) { ctx.toast('区切りの条件に誤りがあります', true); return; }
      state.result = buildResult();
      if (!state.result.episodes.length) { ctx.toast('話が1つも見つかりません。区切りの条件か、手動の区切りを確認してください', true); return; }
      await buildRows();
      renderPreview();
    }
    state.step = step;
    document.querySelectorAll('[data-istep]').forEach((s) => { s.hidden = Number(s.dataset.istep) !== step; });
    document.querySelectorAll('[data-step-label]').forEach((l) => l.classList.toggle('current', Number(l.dataset.stepLabel) === step));
    saveSession();
  }

  async function open() {
    state = fresh();
    // インポート元は前に選んだもの（なければ今の作品の投稿先）
    const last = ctx.prefs.get('importSite', ctx.getProject()?.site || 'narou');
    const sf = sourceFormat(SITE_KEYS.includes(last) ? last : 'narou');
    applyFormat(sf.format, sf.id);
    $('imp-advanced').open = false;
    fillPresets();
    $('imp-encoding').replaceChildren(...I.ENCODINGS.map((e) => new Option(e.label, e.value)));
    $('imp-file').value = '';
    $('imp-file-name').textContent = '';
    resetZipSelection();
    $('imp-title-list-file').value = '';
    $('imp-title-list-text').value = '';
    showTitleListSource();
    $('imp-decode-info').hidden = true;
    $('imp-to-2').disabled = true;
    $('imp-to-2').hidden = true;
    $('imp-lines').replaceChildren();
    rowEls = [];
    $('import-title').textContent = 'TXT インポート';
    $('import-dialog').classList.remove('format-settings');
    document.querySelector('.import-steps').hidden = false;
    $('imp-rule-actions').hidden = false;
    $('imp-split').hidden = false;
    $('imp-step2-foot').hidden = false;
    await fillTargets();
    await showResume();
    await go(1);
    dlg.showModal();
    // Android などの「戻る」でインポート画面を閉じる（作業は残る）
    history.pushState({ novelEditorImport: true }, '');
  }

  function close(fromCommit = false) {
    if (!dlg.open) return;
    dlg.close();
    if (history.state?.novelEditorImport) history.back();
    if (!fromCommit && state.text && !isKakuyomu()) ctx.toast('インポートを中断しました（作業内容は残っています。次に開いたときに再開できます）');
  }

  // ---------- イベント ----------

  $('imp-close').addEventListener('click', () => close());
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  window.addEventListener('popstate', () => { if (dlg.open) { dlg.close(); } });
  $('imp-source').addEventListener('change', (e) => {
    // カクヨムのバックアップと TXT は読み方が違うので、読み込んだファイルは選び直してもらう
    if ((e.target.value === 'kakuyomu') !== isKakuyomu() && state.text) {
      state.text = '';
      state.lines = [];
      state.buffer = null;
      resetZipSelection();
      $('imp-file-name').textContent = '';
      $('imp-decode-info').hidden = true;
    }
    const sf = sourceFormat(e.target.value);
    applyFormat(sf.format, sf.id);
    state.presetPicked = false;
    ctx.prefs.set('importSite', state.site);
    fillPresets();
    renderRuleForm();
    saveSession();
  });
  $('imp-target').addEventListener('change', (e) => {
    state.target = e.target.value;
    // 既存の作品を選び直したら、いつも「置き換える」（その投稿先の原稿だけ）から。「作り直す」は自分で選んだときだけ
    state.mode = 'overwrite';
    state.strictMatch = state.target !== 'new';
    updateStrictMatchRow();
    saveSession();
  });
  $('imp-strict-match').addEventListener('change', (e) => { state.strictMatch = e.target.checked; saveSession(); });
  $('imp-mode-row').addEventListener('change', (e) => {
    if (!e.target.matches('input[name="imp-mode"]')) return;
    state.mode = e.target.value;
    updateStrictMatchRow();
    saveSession();
  });
  $('imp-encoding').addEventListener('change', (e) => { state.encoding = e.target.value; decodeAndShow(); });
  // 1つ目の画面の次（書式あり：区切り設定／書式なし：タイトル一覧）へ進む
  const goNext = () => go(2, { detect: state.type !== 'title-list' });

  // ファイルを選んだら、読み込んでそのまま次の画面へ進む（終わるまで処理中の画面を出す）。
  // ZIP は、中の TXT を選んでから進む
  async function useImportFile(file) {
    try {
      await ctx.withBusy('TXT・ZIPファイルを読み込んでいます…', async () => {
        await loadImportFile(file);
        if (state.text) await goNext();
      });
    } catch (error) {
      state.buffer = null;
      state.text = '';
      state.lines = [];
      updateNextButton();
      ctx.toast(error?.message || 'ファイルを読み込めませんでした。', true);
    }
  }
  // 0.84：TXT／ZIP とタイトル一覧は、いつも端末のファイル選択で選ぶ（クラウドからは読み取らない。「設定」→「ファイル」とは関係なし）
  $('imp-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('imp-file-name').textContent = `選んだファイル：${file.name}`;
    e.target.value = ''; // 同じファイルを選び直しても読み込めるように
    await useImportFile(file);
  });
  $('imp-zip-entry-list').addEventListener('change', async (e) => {
    if (!e.target.matches('input[name="imp-zip-entry"]')) return;
    try {
      await ctx.withBusy('ZIP内のTXTを読み込んでいます…', async () => {
        await selectZipEntry(Number(e.target.value));
        if (state.text) await goNext();
      });
    }
    catch (error) { ctx.toast(error?.message || 'ZIP内のTXTを読み込めませんでした。', true); }
  });
  $('imp-title-list-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // 同じファイルを選び直しても読み込めるように
    if (file) await loadTitleListFile(file).catch(ctx.fail);
  });
  async function loadTitleListFile(file) {
    if (file.size > 10 * 1024 * 1024) { ctx.toast('タイトル一覧ファイルが大きすぎます（10MBまで）', true); return; }
    const decoded = await ctx.withBusy('タイトル一覧を読み込んでいます…', async () => I.decodeText(await file.arrayBuffer()));
    state.titleListFileName = file.name;
    state.titleListText = decoded.text;
    $('imp-title-list-text').value = state.titleListText;
    updateNextButton();
    saveSession();
  }
  // 「貼り付け」ボタン：クリップボードの文字を貼り付け欄へ入れる（欄の中身は入れ替え）
  $('imp-title-list-paste').addEventListener('click', async () => {
    const box = $('imp-title-list-text');
    let text = '';
    try {
      if (!navigator.clipboard?.readText) throw new Error('unsupported');
      text = await navigator.clipboard.readText();
    } catch {
      ctx.toast('クリップボードを読めませんでした。欄を長押し（パソコンは Ctrl+V）で貼り付けてください', true);
      box.focus();
      return;
    }
    if (!text.trim()) { ctx.toast('クリップボードに文字がありません', true); return; }
    if (box.value.trim() && box.value !== text && !(await ask('貼り付け欄の今の内容を、クリップボードの内容に入れ替えますか？', { ok: '入れ替える' }))) return;
    box.value = text;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    ctx.toast(`タイトル一覧を貼り付けました（${text.split(/\r\n|\r|\n/).length.toLocaleString()}行）`);
  });
  $('imp-title-list-text').addEventListener('input', (e) => {
    state.titleListText = e.target.value;
    state.titleListFileName = '';
    updateNextButton();
    saveSession();
  });
  $('imp-title-list-template').addEventListener('input', (e) => {
    state.template = e.target.value;
    validateRules();
    markPending();
    saveSession();
  });
  // 「次へ」：区切りの検出やプレビュー作りは時間がかかるので、終わるまで処理中の画面を出す
  // （押したボタンだけを処理中の色にし、二重には動かさない）
  async function busyGo(btn, message, work) {
    if (btn.classList.contains('task-running')) return;
    btn.classList.add('task-running');
    try { await ctx.withBusy(message, work); }
    catch (e) { ctx.fail(e); }
    finally { btn.classList.remove('task-running'); }
  }
  $('imp-to-2').addEventListener('click', (e) => busyGo(e.currentTarget, '読み込み中…', goNext));
  $('imp-title-to-rules').addEventListener('click', (e) => busyGo(e.currentTarget, '読み込み中…', () => go(3, { detect: true })));
  $('imp-rules-back').addEventListener('click', () => go(state.type === 'title-list' ? 2 : 1).catch(ctx.fail));
  $('imp-resume-btn').addEventListener('click', () => resume().catch(ctx.fail));
  $('imp-resume-discard').addEventListener('click', async () => {
    if (!(await ask('前回のインポート作業を破棄しますか？（作品には影響しません）'))) return;
    await clearSession();
    $('imp-resume').hidden = true;
  });
  document.querySelectorAll('[data-imp-go]').forEach((b) => b.addEventListener('click', () => {
    const step = Number(b.dataset.impGo);
    // 戻るときはすぐ。先へ進むとき（プレビューを作る）は処理中の画面を出す
    if (step <= state.step) go(step).catch(ctx.fail);
    else busyGo(b, step === 4 ? 'プレビューを作成中…' : '読み込み中…', () => go(step));
  }));
  $('imp-detect').addEventListener('click', () => detect());
  $('imp-narou-help').addEventListener('click', () => $('import-narou-help-dialog').showModal());
  $('imp-alpha-help').addEventListener('click', () => $('import-alpha-help-dialog').showModal());

  function setTemplateValue(value, caret = null) {
    const input = $('imp-title-list-template');
    input.value = value;
    if (caret !== null) input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  function insertTemplateLine(line) {
    const input = $('imp-title-list-template');
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const add = (before && !before.endsWith('\n') ? '\n' : '') + line + (after && !after.startsWith('\n') ? '\n' : '');
    setTemplateValue(before + add + after, before.length + add.length);
  }

  document.querySelectorAll('[data-template-line]').forEach((button) => {
    button.addEventListener('click', () => insertTemplateLine(button.dataset.templateLine));
  });
  $('imp-template-basic').addEventListener('click', async () => {
    const current = $('imp-title-list-template').value.trim();
    if (current && current !== I.ALPHA_TITLE_LIST_TEMPLATE.trim()
      && !(await ask('現在の書式を、アルファポリスの基本形に置き換えますか？', { ok: '置き換える' }))) return;
    setTemplateValue(I.ALPHA_TITLE_LIST_TEMPLATE);
  });
  $('imp-template-delete-line').addEventListener('click', () => {
    const input = $('imp-title-list-template');
    const start = input.value.lastIndexOf('\n', Math.max(0, input.selectionStart - 1)) + 1;
    let end = input.value.indexOf('\n', input.selectionEnd);
    if (end < 0) end = input.value.length; else end += 1;
    setTemplateValue(input.value.slice(0, start) + input.value.slice(end), start);
  });
  $('imp-template-clear').addEventListener('click', async () => {
    if ($('imp-title-list-template').value && !(await ask('タイトル一覧の書式をすべて消しますか？'))) return;
    setTemplateValue('');
  });
  const changeFormat = (e) => {
    const format = formatOf(e.target.value);
    if (!format) return;
    applyFormat(format, e.target.value);
    state.presetPicked = true;
    fillPresets();
    renderRuleForm();
    if (state.text && (state.type !== 'title-list' || state.titleListText.trim())) detect({ confirmFirst: false });
    saveSession();
  };
  $('imp-preset-edit').addEventListener('change', changeFormat);

  function formatData(id, name) {
    return {
      id, name, type: state.type,
      ...(state.type === 'title-list' ? { template: state.template } : { rules: clone(state.rules) }),
      updatedAt: new Date().toISOString(),
    };
  }

  // 今の書式に名前を付けて保存する。戻り値：保存した書式の ID（やめたら null）
  async function saveAsPreset() {
    if (!validateRules()) return null;
    const current = formatOf(state.presetId);
    const name = await askText('この書式に名前を付けて保存します', state.presetId.startsWith('u:') ? current?.name || '' : '', { ok: '保存' });
    if (!name || !name.trim()) return null;
    const list = userFormats();
    const same = list.find((p) => p.name === name.trim());
    if (same && !(await ask(`同じ名前の書式「${name.trim()}」があります。上書きしますか？`, { ok: '上書き' }))) return null;
    const id = same?.id || (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    const next = list.filter((p) => p.id !== id);
    next.push(formatData(id, name.trim()));
    ctx.prefs.set('importFormats', next);
    state.presetId = 'u:' + id;
    fillPresets();
    ctx.toast(`書式「${name.trim()}」を保存しました`);
    return state.presetId;
  }

  $('imp-format-new').addEventListener('click', async () => {
    // 0.82：方式は今のインポート元のまま（なろう＝書式あり／アルファ＝書式なし）
    state.presetId = 'draft:' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    state.presetPicked = true;
    state.rules = completeRules({
      chapter: { enabled: true, pattern: '', position: 'start', method: 'prefix', title: 'include' },
      episode: { enabled: true, pattern: '', position: 'start', method: 'prefix', title: 'include' },
      separator: { enabled: false, pattern: '', position: 'start', method: 'prefix' },
      cleanup: clone(I.NO_CLEANUP),
    });
    state.template = I.ALPHA_TITLE_LIST_TEMPLATE;
    state.auto = new Map();
    state.manual = new Map();
    fillPresets();
    showTitleListSource();
    renderRuleForm();
    renderMarks();
    markPending();
  });
  $('imp-preset-save').addEventListener('click', () => saveAsPreset().catch(ctx.fail));
  $('imp-preset-overwrite').addEventListener('click', async () => {
    const old = formatOf(state.presetId);
    if (!old || !state.presetId.startsWith('u:') || !validateRules()) return;
    const list = userFormats().filter((p) => p.id !== old.id);
    list.push(formatData(old.id, old.name));
    ctx.prefs.set('importFormats', list);
    fillPresets();
    ctx.toast(`書式「${old.name}」を上書き保存しました`);
  });
  $('imp-preset-default').addEventListener('click', async () => {
    let id = state.presetId;
    const saved = formatOf(id);
    const currentData = state.type === 'title-list' ? state.template : completeRules(state.rules);
    const savedData = saved && (state.type === 'title-list' ? saved.template : completeRules(saved.rules));
    if (!saved || saved.type !== state.type || JSON.stringify(savedData) !== JSON.stringify(currentData)) {
      if (!(await ask('書式を変更しています。名前を付けて保存してから、既定にしますか？'))) return;
      id = await saveAsPreset();
      if (!id) return;
    }
    ctx.prefs.set('importDefaultPreset', id);
    fillPresets();
    ctx.toast('次からは、この条件で始まります');
  });
  $('imp-preset-delete').addEventListener('click', async () => {
    const id = state.presetId;
    const p = userFormats().find((x) => 'u:' + x.id === id);
    if (!p || !(await ask(`保存した書式「${p.name}」を削除しますか？`))) return;
    ctx.prefs.set('importFormats', userFormats().filter((x) => x.id !== p.id));
    if (ctx.prefs.get('importDefaultPreset', null) === id) ctx.prefs.set('importDefaultPreset', null);
    const def = defaultPreset();
    applyFormat(def.format, def.id);
    fillPresets();
    renderRuleForm();
  });
  $('imp-lines').addEventListener('click', (e) => {
    const b = e.target.closest('.ln-mark');
    if (b) cycleMark(Number(b.parentElement.dataset.i));
  });
  $('imp-episodes').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-line]');
    if (b) jumpToLine(Number(b.dataset.line));
  });
  $('imp-commit').addEventListener('click', () => commit());

  return { open };
}
