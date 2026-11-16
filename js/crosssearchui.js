// 串刺し検索の画面（0.74）。検索そのものは crosssearch.js
import { SEARCH_TARGETS, SEARCH_TARGET_KEYS, crossSearch } from './crosssearch.js';

const $ = (id) => document.getElementById(id);

// 小さな要素づくり（textContent だけを入れるので、利用者の文字は HTML として解釈されない）
function h(tag, props = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

const SITES = [['narou', 'なろう用'], ['alpha', 'アルファ用']];
const TARGET_LABEL = Object.fromEntries(SEARCH_TARGETS.map((t) => [t.key, t.label]));

/**
 * opts: getProject(), prefs, openHit(ref, first)：当たった場所を開く
 */
export function initCrossSearch(opts) {
  const { prefs } = opts;
  const form = $('cs-form');
  const input = $('cs-query');
  const out = $('cs-results');
  const summary = $('cs-summary');
  let lastQuery = '';

  // ---- 対象のチェック（端末ごとに覚える） ----
  const savedTargets = prefs.get('cs.targets', SEARCH_TARGET_KEYS);
  const savedSites = prefs.get('cs.sites', SITES.map(([s]) => s));
  const box = (group) => SEARCH_TARGETS.filter((t) => t.group === group).map((t) =>
    h('label', {}, Object.assign(h('input', { type: 'checkbox', dataset: { csTarget: t.key } }), { checked: savedTargets.includes(t.key) }), ` ${t.label}`));
  $('cs-targets-work').append(...box('work'));
  $('cs-targets-episode').append(...box('episode'));
  $('cs-sites').append(...SITES.map(([s, label]) =>
    h('label', {}, Object.assign(h('input', { type: 'checkbox', dataset: { csSite: s } }), { checked: savedSites.includes(s) }), ` ${label}`)));
  const mode = prefs.get('cs.mode', 'and');
  form.querySelectorAll('[name="cs-mode"]').forEach((r) => { r.checked = r.value === mode; });

  const targets = () => [...form.querySelectorAll('[data-cs-target]:checked')].map((c) => c.dataset.csTarget);
  const sites = () => [...form.querySelectorAll('[data-cs-site]:checked')].map((c) => c.dataset.csSite);
  const currentMode = () => form.querySelector('[name="cs-mode"]:checked')?.value || 'and';
  const save = () => {
    prefs.set('cs.targets', targets());
    prefs.set('cs.sites', sites());
    prefs.set('cs.mode', currentMode());
  };
  // 条件を変えたら覚える。一度検索したあとは、そのまま検索し直す
  form.addEventListener('change', () => { save(); if (lastQuery) run(); });
  $('cs-all').addEventListener('click', () => { form.querySelectorAll('[data-cs-target]').forEach((c) => { c.checked = true; }); save(); if (lastQuery) run(); });
  $('cs-none').addEventListener('click', () => { form.querySelectorAll('[data-cs-target]').forEach((c) => { c.checked = false; }); save(); if (lastQuery) run(); });
  form.addEventListener('submit', (e) => { e.preventDefault(); lastQuery = input.value; run(); });

  function markText(sn) {
    const parts = [];
    let pos = 0;
    for (const [a, b] of sn.marks) {
      if (a > pos) parts.push(sn.text.slice(pos, a));
      parts.push(h('mark', { text: sn.text.slice(a, b) }));
      pos = b;
    }
    parts.push(sn.text.slice(pos));
    return h('div', { class: 'cs-snippet' }, sn.cut[0] ? '…' : '', ...parts, sn.cut[1] ? '…' : '');
  }

  function run() {
    const project = opts.getProject();
    if (!project) return;
    const q = lastQuery;
    const t = targets();
    const needSite = t.some((k) => SEARCH_TARGETS.find((x) => x.key === k)?.site);
    if (!q.trim()) { summary.textContent = '検索する言葉を入れてください。'; out.replaceChildren(); return; }
    if (!t.length) { summary.textContent = '検索する対象にチェックを入れてください。'; out.replaceChildren(); return; }
    if (needSite && !sites().length && t.every((k) => SEARCH_TARGETS.find((x) => x.key === k)?.site)) {
      summary.textContent = '「なろう用」「アルファ用」のどちらかにチェックを入れてください。'; out.replaceChildren(); return;
    }
    const r = crossSearch(project, { query: q, mode: currentMode(), targets: t, sites: sites() });
    const places = r.results.reduce((n, x) => n + x.count, 0);
    summary.textContent = r.total
      ? `${r.total.toLocaleString()}件${r.truncated ? `（多いので、最初の${r.results.length}件を表示）` : `・${places.toLocaleString()}か所`}`
        + `　${currentMode() === 'or' ? 'どれかを含む' : 'すべてを含む'}：${r.words.map((w) => `「${w}」`).join(' ')}`
      : `見つかりませんでした（${currentMode() === 'or' ? 'どれかを含む' : 'すべてを含む'}：${r.words.map((w) => `「${w}」`).join(' ')}）`;
    // 対象ごとにまとめる（並びは対象のチェックの順）
    const groups = new Map(SEARCH_TARGET_KEYS.map((k) => [k, []]));
    for (const x of r.results) groups.get(x.target).push(x);
    const sections = [];
    for (const [key, list] of groups) {
      if (!list.length) continue;
      sections.push(h('section', { class: 'cs-group' },
        h('h2', { class: 'cs-group-title', text: `${TARGET_LABEL[key]}（${list.length}件）` }),
        h('ul', { class: 'cs-list' }, list.map((x) => h('li', { class: 'cs-item' },
          h('button', { type: 'button', class: 'cs-open', title: 'この場所を開く', onclick: () => opts.openHit(x.ref, x.first) },
            h('span', { class: 'cs-title', text: x.title }),
            x.sub ? h('span', { class: 'cs-sub', text: x.sub }) : null,
            h('span', { class: 'cs-count', text: `${x.count}か所` })),
          ...x.snippets.map(markText))))));
    }
    out.replaceChildren(...sections);
  }

  return {
    // 画面を開いたとき：前に検索していれば、今の内容で検索し直す（ほかの画面で書き換えた分を反映）
    show() {
      if (lastQuery) run();
      else if (!matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus({ preventScroll: true }), 0); // スマホではキーボードを勝手に出さない
    },
    // 作品を替えたら結果を消す
    reset() { lastQuery = ''; input.value = ''; summary.textContent = ''; out.replaceChildren(); },
  };
}
