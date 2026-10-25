// TXT インポートの画面（設定 →「インポート／エクスポート」→「TXT をインポート…」）
// 解析は importer.js。この画面は、確定するまで作品データを一切変更しない。
// 途中の作業は IndexedDB の meta.importSession に自動で残し、あとから再開できる。
import * as I from './importer.js';
import { normalize, newProject, newEpisode, newChapter, draftOf, serialize, countChars, SITE_KEYS } from './format.js';
import { SITES, countImages } from './notation.js';
import { ask, askText, choose } from './dialogs.js';

const KINDS = [
  ['chapter', '章の区切り'],
  ['episode', '話の区切り'],
  ['separator', '前書き・後書きの区切り'],
];
const MARK_LABEL = { episode: '話', chapter: '章' };
const clone = (x) => structuredClone(x);

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

  function fresh() {
    const preset = defaultPreset();
    const type = preset.format.type || 'rules';
    return {
      fileName: '', buffer: null, text: '', lines: [], decode: null,
      encoding: 'auto', site: preset.format.site || 'narou', target: 'new',
      presetId: preset.id, type, rules: completeRules(preset.format.rules), template: preset.format.template || I.ALPHA_TITLE_LIST_TEMPLATE,
      titleListText: '', titleListFileName: '',
      configureOnly: false,
      auto: new Map(), manual: new Map(),
      result: null, rows: [], workTitle: '', useHead: true, step: 1, siteInfo: null, mismatches: [],
    };
  }

  // ---------- 途中の作業の保存・再開（オプション C） ----------

  function saveSession() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!state.text) return;
      ctx.meta.set('importSession', {
        savedAt: new Date().toISOString(),
        fileName: state.fileName, text: state.text, decode: state.decode && { encoding: state.decode.encoding, note: state.decode.note, bad: state.decode.bad },
        site: state.site, target: state.target, presetId: state.presetId, type: state.type, rules: state.rules, template: state.template,
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
      presetId: s.presetId, type: s.type || 'rules', rules: completeRules(s.rules), template: s.template || I.ALPHA_TITLE_LIST_TEMPLATE,
      titleListText: s.titleListText || '', titleListFileName: s.titleListFileName || '', manual: new Map(s.manual) };
    $('imp-site').value = state.site;
    fillPresets();
    $('imp-preset').value = state.presetId;
    $('imp-title-list-text').value = state.titleListText;
    showTitleListSource();
    await fillTargets();
    $('imp-target').value = state.target;
    showDecodeInfo(true);
    buildLineRows();
    go(2, { detect: true });
  }

  // ---------- 1. ファイル ----------

  async function fillTargets() {
    const sel = $('imp-target');
    const projects = (await ctx.db.all()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sel.replaceChildren(new Option('新しい作品として取り込む', 'new'),
      ...projects.map((p) => new Option(`既存の作品：${p.title || '（無題）'}${p.narouNcode ? `（${p.narouNcode}）` : ''}`, p.id)));
    sel.value = projects.some((p) => p.id === state.target) ? state.target : 'new';
    state.target = sel.value;
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
    showDecodeInfo();
    buildLineRows();
    updateNextButton();
    saveSession();
  }

  // ---------- 2. 区切り ----------

  function fillPresets() {
    const def = defaultPreset().id;
    const mark = (id) => (id === def ? '（既定）' : '');
    const savedFormats = userFormats().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    for (const sel of [$('imp-preset'), $('imp-preset-edit')]) {
      sel.replaceChildren(
        ...I.PRESETS.map((p) => new Option(p.name + mark('b:' + p.id), 'b:' + p.id)),
        ...savedFormats.map((p) => new Option(p.name + mark('u:' + p.id), 'u:' + p.id)));
      if (![...sel.options].some((o) => o.value === state.presetId)) sel.append(new Option('（いまの書式）', state.presetId));
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
    if (format.site) {
      state.site = format.site;
      $('imp-site').value = state.site;
    }
    state.auto = new Map();
    state.manual = new Map();
    showTitleListSource();
  }

  function showTitleListSource() {
    const on = state.type === 'title-list';
    $('imp-title-list-source').hidden = !on;
    $('imp-detect').textContent = on ? 'タイトル一覧と照合' : 'この条件で自動検出';
    $('imp-pending').textContent = on
      ? '書式を変えました。全文に反映するには「タイトル一覧と照合」を押してください（プレビューへ進むときにも反映されます）'
      : '条件を変えました。全文に反映するには「この条件で自動検出」を押してください（プレビューへ進むときにも反映されます）';
    updateNextButton();
  }

  function updateNextButton() {
    $('imp-to-2').disabled = !state.text || (state.type === 'title-list' && !state.titleListText.trim());
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

  const MASK_CLASS = { line: ' cut-line', block: ' cut-block', foreword: ' to-foreword', afterword: ' to-afterword', title: ' to-title' };
  const MASK_TAG = { line: '消す', block: '消す', foreword: '前書き', afterword: '後書き', title: '題名' };

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
    if (target) {
      const other = SITE_KEYS.find((s) => s !== state.site);
      const existing = target.episodes.map((e) => ({
        id: e.id,
        // 取り込むサイト側のタイトルがなければ、もう一方のタイトルで照合する（なろう版にアルファ版を足すときなど）
        title: draftOf(e, state.site).title || draftOf(e, other).title,
        chapterTitle: target.chapters.find((c) => c.id === e.chapterId)?.title || '',
        body: draftOf(e, state.site).body,
        importKey: e.importKeys?.[state.site],
      }));
      dups = I.findDuplicates(items, existing);
    }
    state.rows = items.map((it, i) => ({ it, dup: dups[i], include: true, action: dups[i].action, target: dups[i].target }));
    state.targetProject = target;
    if (!state.workTitle || state.target !== 'new') state.workTitle = result.head.title || state.fileName.replace(/\.[^.]+$/, '');
    // TXT の【ユーザ情報】【Nコード】と、設定に登録したアカウント・取り込み先の作品の Nコードを照合する
    state.siteInfo = I.extractSiteInfo(state.lines);
    const account = (ctx.prefs.get('accounts', {}) || {})[state.site] || {};
    state.mismatches = I.checkSiteInfo(state.siteInfo, account, state.site === 'narou' ? target?.narouNcode : '');
    // TXT の Nコードが対応付けられている作品（取り込み先とは別のとき）
    const code = state.siteInfo.ncode;
    state.ncodeOwner = code && target?.narouNcode !== code
      ? (await ctx.db.all()).find((p) => p.id !== target?.id && (p.narouNcode || '').toLowerCase() === code) || null
      : null;
  }

  function mismatchText() {
    return state.mismatches.map((m) => `・${m.label}：登録「${m.registered}」／TXT「${m.found}」`).join('\n');
  }

  function renderPreview() {
    const result = state.result;
    const target = state.targetProject;
    const s = I.summarize(result);
    const sum = $('imp-summary');
    sum.replaceChildren();
    if (!target) {
      const l = Object.assign(document.createElement('label'), { textContent: '作品名' });
      const input = Object.assign(document.createElement('input'), { type: 'text', value: state.workTitle });
      input.addEventListener('input', () => { state.workTitle = input.value; });
      l.append(input);
      sum.append(l);
    } else {
      sum.append(Object.assign(document.createElement('div'), { className: 'stat', textContent: `取り込み先：${target.title || '（無題）'}（${SITES[state.site].short}用の原稿）` }));
    }
    if (state.mismatches.length) {
      sum.append(Object.assign(document.createElement('div'), {
        className: 'imp-info warn imp-mismatch',
        textContent: `⚠ TXT の情報が、設定（投稿サイト）に登録した内容と違います。別のアカウント・別の作品の TXT かもしれません。\n${mismatchText()}`,
      }));
    }
    if (state.ncodeOwner) {
      sum.append(Object.assign(document.createElement('div'), {
        className: 'imp-info warn',
        textContent: `⚠ この TXT の Nコード（${state.siteInfo.ncode}）は、作品「${state.ncodeOwner.title || '（無題）'}」に対応付けられています。その作品に取り込むなら、最初の画面で取り込み先を選び直してください。`,
      }));
    }
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
      d.append(Object.assign(document.createElement('summary'), { textContent: `先頭の未解析の行（作品情報など）${result.head.lines.length}行` }),
        Object.assign(document.createElement('pre'), { textContent: result.head.lines.join('\n') }));
      const l = Object.assign(document.createElement('label'), { className: 'inline' });
      const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: state.useHead && (!target || !target.synopsis) });
      state.useHead = cb.checked;
      cb.addEventListener('change', () => { state.useHead = cb.checked; });
      l.append(cb, target?.synopsis ? ' あらすじ欄に入れる（取り込み先のあらすじは空でないため、入れると上書きになります）' : ' タイトル行以外を、作品のあらすじ欄に入れる');
      d.append(l);
      sum.append(d);
    }
    renderTable();
  }

  function renderTable() {
    const target = state.targetProject;
    const table = $('imp-preview');
    const head = ['取込', '章', 'タイトル', '本文', '前書き', '後書き', '画像', '注意'];
    if (target) head.push('既存との関係', '扱い');
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const h of head) tr.append(Object.assign(document.createElement('th'), { textContent: h }));
    thead.append(tr);
    const tbody = document.createElement('tbody');
    const targetEpName = (id) => {
      const e = target?.episodes.find((x) => x.id === id);
      if (!e) return '';
      return draftOf(e, state.site).title || SITE_KEYS.map((s) => draftOf(e, s).title).find(Boolean) || '（無題）';
    };
    state.rows.forEach((row, i) => {
      const { it, dup } = row;
      const r = document.createElement('tr');
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
      td(it.title || '（タイトルなし）');
      td(`${[...it.body].length.toLocaleString()}字`);
      td(it.foreword ? 'あり' : '―');
      td(it.afterword ? 'あり' : '―');
      td(String(countImages(it.body) || '―'));
      td(it.warnings.join('／') || '―', it.warnings.length ? 'warn' : '');
      if (target) {
        const relation = {
          same: `同じ本文：${targetEpName(dup.target)}`,
          title: `同じタイトル：${targetEpName(dup.target)}`,
          similar: `似たタイトル：${targetEpName(dup.target)}`,
        }[dup.kind] || '新しい話';
        td(relation, dup.kind === 'same' ? 'dup-same' : dup.kind !== 'none' ? 'dup-title' : '');
        const cell = td('');
        const act = document.createElement('select');
        act.setAttribute('aria-label', '扱い');
        const opts = [['add', '別の話として追加'], ['skip', 'スキップ'], ['manual', '取り込み先を指定…']];
        if (dup.target) opts.unshift(['overwrite', `上書き（${SITES[state.site].short}用の原稿）`]);
        for (const [v, t] of opts) act.append(new Option(t, v));
        act.value = row.action;
        const pick = document.createElement('select');
        pick.setAttribute('aria-label', '取り込み先のエピソード');
        for (const e of target.episodes) pick.append(new Option(targetEpName(e.id), e.id));
        pick.value = row.target || target.episodes[0]?.id || '';
        pick.hidden = row.action !== 'manual';
        act.addEventListener('change', () => {
          row.action = act.value;
          pick.hidden = row.action !== 'manual';
          if (row.action === 'manual') row.target = pick.value;
          if (row.action === 'overwrite') row.target = dup.target;
          updateCommitSummary();
        });
        pick.addEventListener('change', () => { row.target = pick.value; });
        cell.append(act, pick);
      }
      tbody.append(r);
    });
    table.replaceChildren(thead, tbody);
    updateCommitSummary();
  }

  function counts() {
    let add = 0;
    let overwrite = 0;
    let skip = 0;
    for (const row of state.rows) {
      if (!row.include || row.action === 'skip') skip++;
      else if (!state.targetProject || row.action === 'add') add++;
      else overwrite++;
    }
    return { add, overwrite, skip };
  }

  function updateCommitSummary() {
    const c = counts();
    $('imp-commit-summary').textContent = `追加 ${c.add}話・上書き ${c.overwrite}話・スキップ ${c.skip}話`;
    $('imp-commit').disabled = !(c.add + c.overwrite);
  }

  // ---------- 確定 ----------

  async function commit() {
    const c = counts();
    if (!(c.add + c.overwrite)) return;
    const target = state.targetProject;
    const name = target ? (target.title || '（無題）') : (state.workTitle || '（無題）');
    // 登録と違う情報があれば、先に警告する（OK で続ける／キャンセルで中止）
    if (state.mismatches.length && !(await ask(`⚠ TXT の情報が、設定に登録した内容と違います。\n${mismatchText()}\n\n別のアカウント・別の作品の TXT かもしれません。このまま取り込みますか？`, { danger: true, ok: '取り込む' }))) return;
    if (!(await ask(`「${name}」に、${SITES[state.site].label}用の原稿として\n追加 ${c.add}話・上書き ${c.overwrite}話・スキップ ${c.skip}話\nで取り込みます。よろしいですか？`, { ok: '取り込む' }))) return;
    const btn = $('imp-commit');
    btn.disabled = true;
    try {
      await ctx.flush();
      const now = new Date().toISOString();
      let p;
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
      } else {
        p = newProject({ title: state.workTitle, site: state.site });
        p.chapters = [];
        p.episodes = [];
      }
      // 章：同じ名前の章があればそれを使い、なければ作る
      const chapterIds = new Map();
      const findOrCreateChapter = (index) => {
        if (index === null || index === undefined) return null;
        if (chapterIds.has(index)) return chapterIds.get(index);
        const title = state.result.chapters[index]?.title || '';
        let ch = p.chapters.find((x) => I.normalizeTitle(x.title) === I.normalizeTitle(title));
        if (!ch) { ch = newChapter({ title }); p.chapters.push(ch); }
        chapterIds.set(index, ch.id);
        return ch.id;
      };
      for (const row of state.rows) {
        if (!row.include || row.action === 'skip') continue;
        const { it, dup } = row;
        const dest = target && (row.action === 'overwrite' || row.action === 'manual') ? p.episodes.find((e) => e.id === row.target) : null;
        if (dest) {
          const d = dest.drafts[state.site];
          if (it.title) d.title = it.title;
          d.body = it.body;
          if (it.foreword) d.foreword = it.foreword;
          if (it.afterword) d.afterword = it.afterword;
          dest.importKeys = { ...(dest.importKeys || {}), [state.site]: dup.hash };
          dest.updatedAt = now;
        } else {
          const ep = newEpisode({ chapterId: findOrCreateChapter(it.chapter), importKeys: { [state.site]: dup.hash } });
          ep.drafts[state.site] = { title: it.title, foreword: it.foreword, body: it.body, afterword: it.afterword };
          p.episodes.push(ep);
        }
      }
      if (!p.episodes.length) p.episodes.push(newEpisode());
      // 並びを「章の順 → 章の中の順 → 未分類」に揃える
      const pos = new Map(p.chapters.map((ch, i) => [ch.id, i]));
      p.episodes = p.episodes.map((e, i) => ({ e, i, k: pos.has(e.chapterId) ? pos.get(e.chapterId) : Infinity }))
        .sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.e);
      // 先頭の未解析の行（タイトル行以外）をあらすじへ
      if (state.useHead && state.result.head.lines.length) {
        const lines = state.result.head.lines.filter((l, i) => !(i === state.result.head.lines.findIndex((x) => x.trim()) && l.trim() === state.result.head.title));
        const text = lines.join('\n').trim();
        if (text) p.synopsis = text;
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
      ctx.toast(`取り込みました：追加 ${c.add}話・上書き ${c.overwrite}話${target ? '（取り込む前の状態は「バックアップ版」に残しました）' : ''}`);
    } catch (e) {
      ctx.fail(e);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 画面の切り替え ----------

  async function go(step, { detect: doDetect = false } = {}) {
    if (step >= 2 && !state.text) { ctx.toast('先に TXT ファイルを選んでください'); return; }
    if (step >= 2 && state.type === 'title-list' && !state.titleListText.trim()) { ctx.toast('タイトル一覧のファイルを選ぶか、一覧を貼り付けてください'); return; }
    if (step === 2) {
      fillPresets();
      renderRuleForm();
      if (doDetect || !state.auto.size) detect({ confirmFirst: false });
      else renderMarks();
    }
    if (step === 3) {
      if (!$('imp-pending').hidden && !(await detect({ confirmFirst: false }))) return;
      if (!validateRules()) { ctx.toast('区切りの条件に誤りがあります', true); return; }
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
    state.site = formatOf(state.presetId)?.site || ctx.getProject()?.site || 'narou';
    $('imp-site').value = state.site;
    fillPresets();
    $('imp-encoding').replaceChildren(...I.ENCODINGS.map((e) => new Option(e.label, e.value)));
    $('imp-file').value = '';
    $('imp-title-list-file').value = '';
    $('imp-title-list-text').value = '';
    showTitleListSource();
    $('imp-decode-info').hidden = true;
    $('imp-to-2').disabled = true;
    $('imp-lines').replaceChildren();
    rowEls = [];
    $('import-title').textContent = 'TXT インポート';
    $('import-dialog').classList.remove('format-settings');
    document.querySelector('.import-steps').hidden = false;
    $('imp-rule-actions').hidden = false;
    $('imp-split').hidden = false;
    $('imp-step2-foot').hidden = false;
    $('imp-manual-hint').hidden = false;
    await fillTargets();
    await showResume();
    await go(1);
    dlg.showModal();
    // Android などの「戻る」でインポート画面を閉じる（作業は残る）
    history.pushState({ novelEditorImport: true }, '');
  }

  async function openFormats() {
    state = fresh();
    state.configureOnly = true;
    fillPresets();
    $('import-title').textContent = '読み込み書式の設定';
    $('import-dialog').classList.add('format-settings');
    document.querySelector('.import-steps').hidden = true;
    $('imp-rule-actions').hidden = true;
    $('imp-split').hidden = true;
    $('imp-step2-foot').hidden = true;
    $('imp-manual-hint').hidden = true;
    renderRuleForm();
    document.querySelectorAll('[data-istep]').forEach((s) => { s.hidden = Number(s.dataset.istep) !== 2; });
    dlg.showModal();
    history.pushState({ novelEditorImport: true }, '');
  }

  function close(fromCommit = false) {
    if (!dlg.open) return;
    dlg.close();
    if (history.state?.novelEditorImport) history.back();
    if (!fromCommit && state.text) ctx.toast('インポートを中断しました（作業内容は残っています。次に開いたときに再開できます）');
  }

  // ---------- イベント ----------

  $('imp-close').addEventListener('click', () => close());
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  window.addEventListener('popstate', () => { if (dlg.open) { dlg.close(); } });
  $('imp-site').addEventListener('change', (e) => { state.site = e.target.value; saveSession(); });
  $('imp-target').addEventListener('change', (e) => { state.target = e.target.value; saveSession(); });
  $('imp-encoding').addEventListener('change', (e) => { state.encoding = e.target.value; decodeAndShow(); });
  $('imp-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { ctx.toast('ファイルが大きすぎます（50MB まで）', true); return; }
    state.fileName = file.name;
    state.buffer = await file.arrayBuffer();
    decodeAndShow();
  });
  $('imp-title-list-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { ctx.toast('タイトル一覧ファイルが大きすぎます（10MBまで）', true); return; }
    const decoded = I.decodeText(await file.arrayBuffer());
    state.titleListFileName = file.name;
    state.titleListText = decoded.text;
    $('imp-title-list-text').value = state.titleListText;
    updateNextButton();
    saveSession();
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
  $('imp-to-2').addEventListener('click', () => go(2, { detect: true }).catch(ctx.fail));
  $('imp-resume-btn').addEventListener('click', () => resume().catch(ctx.fail));
  $('imp-resume-discard').addEventListener('click', async () => {
    if (!(await ask('前回のインポート作業を破棄しますか？（作品には影響しません）'))) return;
    await clearSession();
    $('imp-resume').hidden = true;
  });
  document.querySelectorAll('[data-imp-go]').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.impGo)).catch(ctx.fail)));
  $('imp-detect').addEventListener('click', () => detect());
  $('imp-rules-help').addEventListener('click', () => $('import-rules-help-dialog').showModal());
  const changeFormat = (e) => {
    const format = formatOf(e.target.value);
    if (!format) return;
    applyFormat(format, e.target.value);
    fillPresets();
    renderRuleForm();
    if (state.text && (state.type !== 'title-list' || state.titleListText.trim())) detect({ confirmFirst: false });
    saveSession();
  };
  $('imp-preset').addEventListener('change', changeFormat);
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
    const type = await choose('どの方法でTXTを分けますか？', [
      { value: 'rules', label: '区切り条件で分ける', primary: true },
      { value: 'title-list', label: 'タイトル一覧で分ける' },
    ]);
    if (!type) return;
    state.presetId = 'draft:' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    state.type = type;
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

  return { open, openFormats };
}
