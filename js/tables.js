// 分類つきの表（設定・登場人物）と、章ごとの全体プロット
import { makeId, countChars } from './format.js';
import { ask, askText, choose } from './dialogs.js';
import { prefs } from './db.js';

// kind のない列は文字の列。kind のある列は、ほかの行とのつながり
//   orgs    … 登場人物の所属。「設定」の項目を選ぶ（item.orgs = [{ id: 設定の項目ID, note: 立場・役職 }]）
//   alias   … 同一人物（名前を変えた同じ人物）。同じ item.identityId を持つ行どうしが同一人物
//   members … 設定の項目に所属している登場人物（表示だけ。登場人物の「所属」から作られる）
export const CHARACTER_COLUMNS = [
  { key: 'name', label: '名前', width: '9em' },
  { key: 'reading', label: '読み', width: '8em' },
  { key: 'age', label: '年齢', width: '4.5em' },
  { key: 'gender', label: '性別', width: '4.5em' },
  { key: 'role', label: '役割・立場', width: '10em' },
  { key: 'orgs', label: '所属', width: '11em', kind: 'orgs' },
  { key: 'identityId', label: '同一人物（別名）', width: '10em', kind: 'alias' },
  { key: 'traits', label: '特徴（外見・性格）', wide: true },
  { key: 'notes', label: 'メモ', wide: true },
];

export const WORLD_COLUMNS = [
  { key: 'name', label: '項目', width: '10em' },
  { key: 'reading', label: '読み', width: '8em' },
  { key: 'detail', label: '説明', wide: true },
  { key: 'notes', label: 'メモ', wide: true },
  { key: 'members', label: '所属する人物', width: '10em', kind: 'members' },
];

// 「テキストに書き出す」で最初から選んでおく列
const EXPORT_DEFAULT = {
  characters: ['name', 'reading', 'age', 'gender', 'role', 'orgs', 'traits'],
  world: ['name', 'reading', 'detail'],
};

function h(tag, props = {}, ...children) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
}

function btn(text, onClick, className = 'tool') {
  const b = h('button', { type: 'button', textContent: text, className });
  b.addEventListener('click', onClick);
  return b;
}

// 中身に合わせて高さを伸ばす
export function autosize(t) {
  t.style.height = 'auto';
  t.style.height = t.scrollHeight + 2 + 'px';
}

function cellText(v) {
  const s = String(v ?? '');
  return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// 行の先頭が「＃」（半角 # も可）の行は非公開。公開用に書き出すときは除く
const PRIVATE_LINE = /^[ \t　]*[#＃]/;
export function publicText(s) {
  return String(s ?? '').split('\n').filter((l) => !PRIVATE_LINE.test(l)).join('\n').trim();
}

// 検索用：全角・半角、大文字・小文字、カタカナ・ひらがなの違いを無視する
function norm(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}

const nameOf = (i) => i?.name || '（名前なし）';

// 前後の同じ分類の行と入れ替える
function swapWithin(items, item, delta) {
  const same = items.filter((i) => i.categoryId === item.categoryId);
  const k = same.indexOf(item) + delta;
  if (k < 0 || k >= same.length) return false;
  const a = items.indexOf(item);
  const b = items.indexOf(same[k]);
  [items[a], items[b]] = [items[b], items[a]];
  return true;
}

/**
 * 分類つきの表
 * @param container 描画先
 * @param getData   () => { categories, items }
 * @param opts      { columns, itemLabel, title, exportKey, onChange, toast, copy,
 *                    orgSource?: () => 設定の表（所属に選ぶ項目）, memberSource?: () => 登場人物の表,
 *                    save?: (text, fileName, what) => 保存, fileBase?: () => ファイル名の頭 }
 */
export function categorizedTable(container, getData, opts) {
  const { columns, itemLabel, onChange, toast, copy } = opts;
  const textColumns = columns.filter((c) => !c.kind);
  const hasAlias = columns.some((c) => c.kind === 'alias');

  // ---- つながり（所属・同一人物・所属する人物） ----
  const orgTable = () => opts.orgSource?.() || { categories: [], items: [] };
  function orgList(item) {
    const by = new Map(orgTable().items.map((o) => [o.id, o]));
    return (Array.isArray(item.orgs) ? item.orgs : []).filter((r) => by.has(r.id)).map((r) => ({ ref: r, org: by.get(r.id) }));
  }
  function aliasList(item) {
    if (!item.identityId) return [];
    return getData().items.filter((i) => i !== item && i.identityId === item.identityId);
  }
  function memberList(item) {
    const people = opts.memberSource?.().items || [];
    return people.flatMap((c) => {
      const r = Array.isArray(c.orgs) ? c.orgs.find((x) => x.id === item.id) : null;
      return r ? [{ person: c, note: r.note || '' }] : [];
    });
  }
  // 列の中身を文字にする（pub：公開用。＃で始まる行を除く）
  function valueText(item, c, pub = false) {
    const t = (s) => (pub ? publicText(s) : String(s ?? '').trim());
    const named = (name, note) => { const n = t(name); const m = t(note); return n ? n + (m ? `（${m}）` : '') : ''; };
    switch (c.kind) {
      case 'orgs': return orgList(item).map(({ ref, org }) => named(org.name, ref.note)).filter(Boolean).join('、');
      case 'alias': return aliasList(item).map((i) => t(i.name)).filter(Boolean).join('、');
      case 'members': return memberList(item).map((m) => named(m.person.name, m.note)).filter(Boolean).join('、');
      default: return pub ? publicText(item[c.key]) : String(item[c.key] ?? '');
    }
  }

  // ---- 検索 ----
  let query = '';
  let field = '';     // '' = 全項目
  let catFilter = ''; // '' = すべての分類
  let withAliases = true;
  const words = () => norm(query).split(/\s+/).filter(Boolean);
  const searching = () => words().length > 0;
  const filtering = () => searching() || !!catFilter;
  function hitColumns(item) {
    const ws = words();
    const cols = field ? columns.filter((c) => c.key === field) : columns;
    const texts = cols.map((c) => [c.key, norm(valueText(item, c))]);
    const all = texts.map((x) => x[1]).join('\n');
    if (!ws.every((w) => all.includes(w))) return null;
    return new Set(texts.filter(([, s]) => ws.some((w) => s.includes(w))).map(([k]) => k));
  }
  // 表示する行と、どの列が当たったか
  function visibleRows(data) {
    const shown = new Map();
    for (const i of data.items) {
      if (catFilter && i.categoryId !== catFilter) continue;
      if (!searching()) { shown.set(i, null); continue; }
      const hit = hitColumns(i);
      if (hit) shown.set(i, hit);
    }
    // 同一人物も一緒に出す（分類の絞り込みにかかわらず）
    if (searching() && hasAlias && withAliases) {
      for (const i of [...shown.keys()]) for (const a of aliasList(i)) if (!shown.has(a)) shown.set(a, new Set());
    }
    return shown;
  }

  const searchInput = h('input', { type: 'search', className: 'table-search', placeholder: `${opts.title || ''}を検索`, autocomplete: 'off', spellcheck: false, enterKeyHint: 'search' });
  searchInput.setAttribute('aria-label', `${opts.title || ''}を検索`);
  const fieldSelect = h('select', { className: 'table-field' });
  fieldSelect.setAttribute('aria-label', '検索する列');
  fieldSelect.append(new Option('全項目', ''), ...columns.map((c) => new Option(c.label, c.key)));
  const catSelect = h('select', { className: 'table-cat' });
  catSelect.setAttribute('aria-label', '分類で絞り込む');
  const aliasCheck = h('input', { type: 'checkbox', checked: true });
  const aliasLabel = h('label', { className: 'check table-alias', title: '見つかった人物の、名前を変えた同一人物も表示します' }, aliasCheck, '同一人物も表示');
  const hitCount = h('span', { className: 'count table-hits' });
  const clearBtn = btn('×', () => { clearFilter(); searchInput.focus(); }, 'tool table-clear');
  clearBtn.title = '検索をやめる';
  clearBtn.setAttribute('aria-label', '検索をやめる');
  let timer = 0;
  searchInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { query = searchInput.value; render(); }, 200); });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape' && searchInput.value) { e.preventDefault(); clearFilter(); } });
  fieldSelect.addEventListener('change', () => { field = fieldSelect.value; render(); });
  catSelect.addEventListener('change', () => { catFilter = catSelect.value; render(); });
  aliasCheck.addEventListener('change', () => { withAliases = aliasCheck.checked; render(); });
  const tools = h('div', { className: 'table-tools' },
    h('span', { className: 'table-search-box' }, searchInput, clearBtn),
    fieldSelect, catSelect,
    ...(hasAlias ? [aliasLabel] : []),
    hitCount,
    h('span', { className: 'spacer' }),
    btn('テキストに書き出す…', () => openExport(), 'tool'));
  const body = h('div', { className: 'tables' });
  container.classList.add('table-host');
  container.replaceChildren(tools, body);

  function clearFilter() {
    clearTimeout(timer);
    query = ''; catFilter = '';
    searchInput.value = ''; catSelect.value = '';
    render();
  }

  // ---- 分類・行の操作 ----
  function addCategory() {
    const data = getData();
    data.categories.push({ id: makeId(), name: '新しい分類' });
    onChange();
    render();
    const inputs = body.querySelectorAll('.cat-name');
    const last = inputs[inputs.length - 1];
    last.focus();
    last.select();
  }

  async function removeCategory(cat) {
    const data = getData();
    const items = data.items.filter((i) => i.categoryId === cat.id);
    const name = cat.name || '（名前なし）';
    if (items.length) {
      if (data.categories.length === 1) { toast('最後の分類は削除できません。中の行を消すか、別の分類を作って移してください'); return; }
      const dest = data.categories.find((c) => c !== cat);
      if (!(await ask(`分類「${name}」を削除しますか？\n中の${items.length}件は「${dest.name}」に移ります。`))) return;
      for (const i of data.items) if (i.categoryId === cat.id) i.categoryId = dest.id;
    } else if (!(await ask(`分類「${name}」を削除しますか？`))) {
      return;
    }
    data.categories.splice(data.categories.indexOf(cat), 1);
    if (catFilter === cat.id) catFilter = '';
    onChange();
    render();
  }

  function moveCategory(cat, delta) {
    const cats = getData().categories;
    const i = cats.indexOf(cat);
    const j = i + delta;
    if (j < 0 || j >= cats.length) return;
    [cats[i], cats[j]] = [cats[j], cats[i]];
    onChange();
    render();
  }

  function addItem(cat) {
    const item = { id: makeId(), categoryId: cat.id };
    for (const c of textColumns) item[c.key] = '';
    getData().items.push(item);
    onChange();
    render();
    body.querySelector(`tr[data-id="${item.id}"] textarea`)?.focus();
  }

  async function removeItem(item) {
    const label = item[columns[0].key] || '（名前なし）';
    const used = opts.memberSource ? memberList(item).length : 0;
    const extra = used ? `\n${used}人の登場人物の「所属」からも外れます。` : '';
    if (!(await ask(`「${label}」を削除しますか？${extra}`))) return;
    const data = getData();
    data.items.splice(data.items.indexOf(item), 1);
    // 同一人物が1人だけ残ったら、つながりを消す
    const rest = item.identityId ? data.items.filter((i) => i.identityId === item.identityId) : [];
    if (rest.length === 1) rest[0].identityId = '';
    if (used) for (const c of opts.memberSource().items) if (Array.isArray(c.orgs)) c.orgs = c.orgs.filter((r) => r.id !== item.id);
    onChange();
    render();
  }

  function copyCategory(cat) {
    const rows = getData().items.filter((i) => i.categoryId === cat.id);
    if (!rows.length) { toast('この分類は空です'); return; }
    const lines = [columns.map((c) => c.label).join('\t'), ...rows.map((r) => columns.map((c) => cellText(valueText(r, c))).join('\t'))];
    copy(lines.join('\n'), `「${cat.name}」の表（${rows.length}件）`);
  }

  // 行へ移動する（検索で隠れていたら検索をやめる）
  function focusRow(target) {
    let tr = body.querySelector(`tr[data-id="${target.id}"]`);
    if (!tr) { clearFilter(); tr = body.querySelector(`tr[data-id="${target.id}"]`); }
    if (!tr) return;
    tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
    tr.classList.remove('flash');
    void tr.offsetWidth;
    tr.classList.add('flash');
    tr.querySelector('textarea')?.focus({ preventScroll: true });
  }

  // ---- 所属（登場人物 → 設定の項目） ----
  async function createOrg() {
    const world = orgTable();
    if (!world.categories.length) return null;
    const name = (await askText('「設定」に新しく追加する項目の名前（国・種族・組織など）', ''))?.trim();
    if (!name) return null;
    const guess = world.categories.find((c) => /組織|国|地名|種族/.test(c.name)) || world.categories[0];
    const r = await choose(`「${name}」を「設定」のどの分類に入れますか？`, [{ value: 'add', label: '追加', primary: true }],
      { select: { label: '分類', options: world.categories.map((c) => ({ value: c.id, label: c.name || '（名前なし）' })), value: guess.id } });
    if (!r) return null;
    const org = { id: makeId(), categoryId: r.value, name, reading: '', detail: '', notes: '' };
    world.items.push(org);
    return org;
  }

  function orgsCell(item) {
    const wrap = h('div', { className: 'chips' });
    const fill = () => {
      const list = orgList(item);
      const chips = list.map(({ ref, org }) => {
        const label = nameOf(org) + (ref.note ? `（${ref.note}）` : '');
        const edit = btn(label, async () => {
          const v = await askText(`「${nameOf(org)}」での立場・役職など（空でもかまいません）`, ref.note || '');
          if (v === null) return;
          ref.note = v.trim();
          onChange();
          fill();
        }, 'chip-text');
        edit.title = '押すと立場・役職を書けます';
        const del = btn('×', () => { item.orgs = item.orgs.filter((r) => r !== ref); onChange(); fill(); }, 'chip-x');
        del.setAttribute('aria-label', `「${nameOf(org)}」から外す`);
        return h('span', { className: 'chip' }, edit, del);
      });
      const sel = h('select', { className: 'chip-add' });
      sel.setAttribute('aria-label', '所属を追加');
      sel.append(new Option('＋ 所属', ''));
      const linked = new Set(list.map((x) => x.org.id));
      const world = orgTable();
      for (const cat of world.categories) {
        const items = world.items.filter((o) => o.categoryId === cat.id && !linked.has(o.id));
        if (!items.length) continue;
        const g = h('optgroup', { label: cat.name || '（名前なし）' });
        for (const o of items) g.append(new Option(nameOf(o), o.id));
        sel.append(g);
      }
      sel.append(new Option('（「設定」に新しく追加…）', '__new'));
      sel.addEventListener('change', async () => {
        const v = sel.value;
        sel.value = '';
        const org = v === '__new' ? await createOrg() : orgTable().items.find((o) => o.id === v);
        if (!org) return;
        if (!Array.isArray(item.orgs)) item.orgs = [];
        item.orgs.push({ id: org.id, note: '' });
        onChange();
        fill();
        if (v === '__new') toast(`「設定」に「${org.name}」を追加しました`);
      });
      wrap.replaceChildren(...chips, sel);
    };
    fill();
    return wrap;
  }

  // ---- 同一人物（名前を変えた同じ人物） ----
  function linkSame(a, b) {
    const data = getData();
    const ga = a.identityId;
    const gb = b.identityId;
    const id = ga || gb || makeId();
    for (const i of data.items) if ((ga && i.identityId === ga) || (gb && i.identityId === gb)) i.identityId = id;
    a.identityId = id;
    b.identityId = id;
  }
  function unlinkSame(other) {
    const g = other.identityId;
    other.identityId = '';
    const rest = getData().items.filter((i) => i.identityId === g);
    if (rest.length === 1) rest[0].identityId = '';
  }

  function aliasCell(item, data) {
    const list = aliasList(item);
    const chips = list.map((o) => {
      const go = btn(nameOf(o), () => focusRow(o), 'chip-text');
      go.title = 'この人物の行へ移動';
      const del = btn('×', () => { unlinkSame(o); onChange(); render(); }, 'chip-x');
      del.setAttribute('aria-label', `「${nameOf(o)}」とのつながりを外す`);
      return h('span', { className: 'chip' }, go, del);
    });
    const sel = h('select', { className: 'chip-add' });
    sel.setAttribute('aria-label', '同一人物をつなげる');
    sel.append(new Option('＋ 同一人物', ''));
    const inGroup = new Set([item, ...list]);
    for (const cat of data.categories) {
      const items = data.items.filter((i) => i.categoryId === cat.id && !inGroup.has(i));
      if (!items.length) continue;
      const g = h('optgroup', { label: cat.name || '（名前なし）' });
      for (const i of items) g.append(new Option(nameOf(i), i.id));
      sel.append(g);
    }
    sel.addEventListener('change', () => {
      const other = data.items.find((i) => i.id === sel.value);
      if (!other) return;
      linkSame(item, other);
      onChange();
      render();
      toast(`「${nameOf(item)}」と「${nameOf(other)}」を同一人物としてつなげました`);
    });
    return h('div', { className: 'chips' }, ...chips, sel);
  }

  // ---- 所属する人物（設定の項目。表示だけ） ----
  function membersCell(item) {
    const list = memberList(item);
    const wrap = h('div', { className: 'chips readonly', title: '登場人物の「所属」で選ぶと、ここに出ます' });
    if (!list.length) wrap.append(h('span', { className: 'chip-none', textContent: '—' }));
    for (const m of list) wrap.append(h('span', { className: 'chip' }, h('span', { className: 'chip-text', textContent: nameOf(m.person) + (m.note ? `（${m.note}）` : '') })));
    return wrap;
  }

  // ---- 描画 ----
  function renderRow(item, data, hits) {
    const tr = h('tr');
    tr.dataset.id = item.id;
    for (const c of columns) {
      let content;
      if (c.kind === 'orgs') content = orgsCell(item);
      else if (c.kind === 'alias') content = aliasCell(item, data);
      else if (c.kind === 'members') content = membersCell(item);
      else {
        const ta = h('textarea', { rows: 1, value: item[c.key] ?? '', spellcheck: false });
        ta.setAttribute('aria-label', c.label);
        ta.addEventListener('input', () => { item[c.key] = ta.value; autosize(ta); onChange(); });
        content = ta;
      }
      const td = h('td', { className: (c.wide ? 'wide' : '') + (c.kind ? ' link-cell' : '') + (hits?.has(c.key) ? ' hit' : '') }, content);
      td.dataset.label = c.label;
      tr.append(td);
    }
    // 分類の移動
    const sel = h('select', { className: 'cat-select' });
    sel.setAttribute('aria-label', '分類');
    for (const c of data.categories) sel.append(new Option(c.name || '（名前なし）', c.id));
    sel.value = item.categoryId;
    sel.addEventListener('change', () => {
      const dest = data.categories.find((c) => c.id === sel.value);
      item.categoryId = sel.value;
      // 移動先の分類の末尾に並べる
      data.items.splice(data.items.indexOf(item), 1);
      data.items.push(item);
      onChange();
      render();
      toast(`「${item[columns[0].key] || '（名前なし）'}」を「${dest.name}」に移しました`);
    });
    const tdCat = h('td', { className: 'cat-cell' }, sel);
    tdCat.dataset.label = '分類';
    const ops = h('td', { className: 'ops' },
      btn('↑', () => { if (swapWithin(data.items, item, -1)) { onChange(); render(); } }),
      btn('↓', () => { if (swapWithin(data.items, item, 1)) { onChange(); render(); } }),
      btn('削除', () => removeItem(item), 'tool danger'));
    tr.append(tdCat, ops);
    return tr;
  }

  function renderCategory(cat, data, shown) {
    const all = data.items.filter((i) => i.categoryId === cat.id);
    const items = all.filter((i) => shown.has(i));
    if (filtering() && !items.length) return null;
    const name = h('input', { type: 'text', className: 'cat-name', value: cat.name, autocomplete: 'off' });
    name.setAttribute('aria-label', '分類名');
    name.addEventListener('input', () => {
      cat.name = name.value;
      container.querySelectorAll(`option[value="${cat.id}"]`).forEach((o) => { o.textContent = cat.name || '（名前なし）'; });
      onChange();
    });
    const head = h('div', { className: 'cat-head' },
      name,
      h('span', { className: 'count', textContent: filtering() ? `${items.length} / ${all.length}件` : `${all.length}件` }),
      h('span', { className: 'spacer' }),
      btn('↑', () => moveCategory(cat, -1)),
      btn('↓', () => moveCategory(cat, 1)),
      btn('分類を削除', () => removeCategory(cat), 'tool danger'),
      btn('コピー', () => copyCategory(cat), 'copy'));

    const thead = h('thead', {}, h('tr', {},
      ...columns.map((c) => {
        const th = h('th', { textContent: c.label });
        if (c.width) th.style.width = c.width;
        return th;
      }),
      h('th', { textContent: '分類', className: 'cat-cell' }),
      h('th', { className: 'ops' })));
    const tbody = h('tbody');
    if (items.length) for (const i of items) tbody.append(renderRow(i, data, shown.get(i)));
    else tbody.append(h('tr', { className: 'empty-row' }, h('td', { colSpan: columns.length + 2, textContent: `まだ${itemLabel}がありません` })));

    return h('section', { className: 'cat' },
      head,
      h('div', { className: 'table-wrap' }, h('table', { className: 'grid' + (columns.length > 6 ? ' many' : '') }, thead, tbody)),
      ...(searching() ? [] : [btn(`＋ ${itemLabel}を追加`, () => addItem(cat), 'tool add-row')]));
  }

  function render() {
    const data = getData();
    if (catFilter && !data.categories.some((c) => c.id === catFilter)) catFilter = '';
    catSelect.replaceChildren(new Option('すべての分類', ''), ...data.categories.map((c) => new Option(c.name || '（名前なし）', c.id)));
    catSelect.value = catFilter;
    if (searchInput.value !== query && document.activeElement !== searchInput) searchInput.value = query;
    const shown = visibleRows(data);
    const sections = data.categories.map((c) => renderCategory(c, data, shown)).filter(Boolean);
    clearBtn.hidden = !query;
    hitCount.textContent = searching() ? `${shown.size}件` : '';
    if (filtering() && !sections.length) {
      body.replaceChildren(h('p', { className: 'hint', textContent: searching() ? '見つかりませんでした。' : 'この分類はありません。' }));
    } else {
      body.replaceChildren(...sections, ...(filtering() ? [] : [btn('＋ 分類を追加', addCategory, 'add-cat')]));
    }
    requestAnimationFrame(() => body.querySelectorAll('.grid textarea').forEach(autosize));
  }

  // ---- テキストに書き出す ----
  const picked = new WeakMap(); // 表のデータ → 前回選んだ行の id
  const prefKey = `tableExport.${opts.exportKey}`;

  function openExport() {
    const data = getData();
    const saved = prefs.get(prefKey, {}) || {};
    const st = {
      cols: new Set((saved.cols || EXPORT_DEFAULT[opts.exportKey] || columns.map((c) => c.key)).filter((k) => columns.some((c) => c.key === k))),
      pub: saved.pub ?? true,
      style: saved.style || 'heading',
      catHeads: saved.catHeads ?? true,
      skipEmpty: saved.skipEmpty ?? true,
    };
    const shownNow = filtering() ? new Set([...visibleRows(data).keys()].map((i) => i.id)) : null;
    const before = picked.get(data);
    const rows = new Set(shownNow || (before ? [...before].filter((id) => data.items.some((i) => i.id === id)) : data.items.map((i) => i.id)));

    const dlg = h('dialog', { className: 'export-dialog' });
    const form = h('form', { method: 'dialog', className: 'dialog' });
    form.addEventListener('submit', (e) => e.preventDefault());

    // 列
    const colBox = h('div', { className: 'export-cols' });
    for (const c of columns) {
      const cb = h('input', { type: 'checkbox', checked: st.cols.has(c.key) });
      cb.addEventListener('change', () => { if (cb.checked) st.cols.add(c.key); else st.cols.delete(c.key); update(); });
      colBox.append(h('label', { className: 'check' }, cb, c.label));
    }

    // 行
    const rowBox = h('div', { className: 'export-rows' });
    const rowChecks = new Map();
    const catChecks = [];
    for (const cat of data.categories) {
      const items = data.items.filter((i) => i.categoryId === cat.id);
      if (!items.length) continue;
      const catCb = h('input', { type: 'checkbox' });
      const list = h('div', { className: 'export-row-list' });
      for (const i of items) {
        const cb = h('input', { type: 'checkbox', checked: rows.has(i.id) });
        cb.addEventListener('change', () => { if (cb.checked) rows.add(i.id); else rows.delete(i.id); syncCats(); update(); });
        rowChecks.set(i.id, cb);
        const sub = i.reading ? `（${i.reading}）` : '';
        list.append(h('label', { className: 'check' }, cb, nameOf(i) + sub));
      }
      catCb.addEventListener('change', () => {
        for (const i of items) { if (catCb.checked) rows.add(i.id); else rows.delete(i.id); rowChecks.get(i.id).checked = catCb.checked; }
        catCb.indeterminate = false;
        update();
      });
      catChecks.push({ cb: catCb, items });
      rowBox.append(h('div', { className: 'export-cat' }, h('label', { className: 'check export-cat-name' }, catCb, cat.name || '（名前なし）'), list));
    }
    function syncCats() {
      for (const { cb, items } of catChecks) {
        const n = items.filter((i) => rows.has(i.id)).length;
        cb.checked = n === items.length;
        cb.indeterminate = n > 0 && n < items.length;
      }
    }
    const setRows = (ids) => {
      rows.clear();
      for (const id of ids) rows.add(id);
      for (const [id, cb] of rowChecks) cb.checked = rows.has(id);
      syncCats();
      update();
    };
    const rowTools = h('div', { className: 'button-row' },
      btn('すべて選ぶ', () => setRows(data.items.map((i) => i.id))),
      btn('すべて外す', () => setRows([])),
      ...(shownNow ? [btn('今の検索結果だけ', () => setRows(shownNow))] : []));

    // 書式
    const pubCb = h('input', { type: 'checkbox', checked: st.pub });
    pubCb.addEventListener('change', () => { st.pub = pubCb.checked; update(); });
    const styleSel = h('select');
    styleSel.append(new Option('見出し形式（■名前 ＋ 項目ごとに改行）', 'heading'), new Option('1人1行（項目を「／」で区切る）', 'line'), new Option('表（タブ区切り。表計算ソフト用）', 'table'));
    styleSel.value = st.style;
    styleSel.addEventListener('change', () => { st.style = styleSel.value; update(); });
    const catCb = h('input', { type: 'checkbox', checked: st.catHeads });
    catCb.addEventListener('change', () => { st.catHeads = catCb.checked; update(); });
    const emptyCb = h('input', { type: 'checkbox', checked: st.skipEmpty });
    emptyCb.addEventListener('change', () => { st.skipEmpty = emptyCb.checked; update(); });

    const preview = h('textarea', { className: 'export-preview', readOnly: true, spellcheck: false });
    preview.setAttribute('aria-label', '書き出す内容');
    const count = h('span', { className: 'count' });

    function update() {
      preview.value = buildText(data, st, rows);
      count.textContent = `${countChars(preview.value).all.toLocaleString()}字・${rows.size}件`;
      prefs.set(prefKey, { cols: [...st.cols], pub: st.pub, style: st.style, catHeads: st.catHeads, skipEmpty: st.skipEmpty });
    }

    const done = () => {
      if (!dlg.isConnected) return;
      picked.set(data, new Set(rows));
      if (dlg.open) dlg.close();
      dlg.remove();
    };
    const closeBtn = btn('閉じる', done, '');
    const saveBtn = btn('ファイルに保存…', () => {
      if (!preview.value.trim()) { toast('書き出す内容がありません', true); return; }
      opts.save?.(preview.value, `${opts.fileBase?.() || '作品'}_${opts.title}.txt`, opts.title);
    }, '');
    const copyBtn = btn('コピー', () => {
      if (!preview.value.trim()) { toast('書き出す内容がありません', true); return; }
      copy(preview.value, `${opts.title}（${rows.size}件）`);
    }, 'primary');
    saveBtn.hidden = !opts.save;

    form.append(
      h('h2', { textContent: `${opts.title}をテキストに書き出す` }),
      h('div', { className: 'export-body' },
        h('section', {}, h('h3', { textContent: '書き出す項目（列）' }), colBox),
        h('section', {}, h('h3', { textContent: `書き出す${itemLabel}（行）` }), rowTools, rowBox),
        h('section', {}, h('h3', { textContent: '書式' }),
          h('label', { className: 'check' }, pubCb, '公開用（先頭が「＃」の行は書き出さない）'),
          h('label', { className: 'check' }, catCb, '分類名を見出しにする'),
          h('label', { className: 'check' }, emptyCb, '空の項目は書き出さない'),
          h('label', { className: 'export-style' }, '形式 ', styleSel)),
        h('section', { className: 'export-preview-box' },
          h('div', { className: 'field-head' }, h('h3', { textContent: 'プレビュー' }), h('span', { className: 'spacer' }), count),
          preview)),
      h('div', { className: 'dialog-foot' }, closeBtn, saveBtn, copyBtn));
    dlg.append(form);
    document.body.append(dlg);
    dlg.addEventListener('close', done); // Esc で閉じたとき
    syncCats();
    update();
    dlg.showModal();
    copyBtn.focus();
  }

  function buildText(data, st, rows) {
    const cols = columns.filter((c) => st.cols.has(c.key));
    if (!cols.length) return '';
    const titleCol = cols.find((c) => c.key === columns[0].key);
    const readingCol = titleCol && cols.find((c) => c.key === 'reading');
    const v = (item, c) => valueText(item, c, st.pub).trim();
    const out = [];
    if (st.style === 'table') out.push([...(st.catHeads ? ['分類'] : []), ...cols.map((c) => c.label)].join('\t'));
    for (const cat of data.categories) {
      // 公開用で名前が空（名前の行が「＃」だけ）の行は、まるごと書き出さない
      const items = data.items.filter((i) => i.categoryId === cat.id && rows.has(i.id) && (!st.pub || !titleCol || v(i, titleCol)));
      if (!items.length) continue;
      if (st.style === 'table') {
        for (const i of items) out.push([...(st.catHeads ? [cellText(cat.name)] : []), ...cols.map((c) => cellText(v(i, c)))].join('\t'));
        continue;
      }
      if (st.catHeads) out.push(`【${cat.name || '（名前なし）'}】`, '');
      for (const i of items) {
        let head = titleCol ? v(i, titleCol) : '';
        if (head && readingCol && v(i, readingCol)) head += `（${v(i, readingCol)}）`;
        const rest = cols.filter((c) => c !== titleCol && !(head && c === readingCol))
          .map((c) => [c.label, v(i, c)])
          .filter(([, s]) => s || !st.skipEmpty);
        if (st.style === 'line') {
          out.push([...(head ? [`■${head}`] : []), ...rest.map(([l, s]) => `${l}：${s.replace(/\s*\n\s*/g, ' ')}`)].join('／'));
          continue;
        }
        if (head) out.push(`■${head}`);
        for (const [l, s] of rest) {
          if (s.includes('\n')) out.push(`${l}：`, ...s.split('\n'));
          else out.push(`${l}：${s}`);
        }
        out.push('');
      }
      if (st.style === 'line') out.push('');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }

  return { render };
}

/**
 * 全体プロット：章をプルダウンで1つずつ切り替えて、章タイトルと章プロットを編集する。
 * 章そのものの追加・移動・削除は、目次（章とエピソードの階層）と同じ処理を使う（ops で受け取る）。
 * @param getChapters () => chapters 配列
 * @param ops { onChange, toast, copy, addChapter(afterIndex) → 章, moveChapter(章, ±1) → 動いたか, removeChapter(章) → 削除したか, episodeCount(章) }
 */
export function chapterList(container, getChapters, ops) {
  const { onChange, toast, copy } = ops;
  let current = 0;
  const chapterName = (ch) => ch.title || '（無題の章）';

  function render(focusTitle = false) {
    const chapters = getChapters();
    if (!chapters.length) {
      container.replaceChildren(
        h('p', { className: 'hint', textContent: 'まだ章がありません。' }),
        btn('＋ 章を追加', () => { ops.addChapter(-1); current = 0; render(true); }));
      return;
    }
    current = Math.max(0, Math.min(current, chapters.length - 1));
    const ch = chapters[current];

    const select = h('select');
    select.setAttribute('aria-label', '章を選ぶ');
    chapters.forEach((c, i) => select.append(new Option(chapterName(c), String(i))));
    select.value = String(current);
    select.addEventListener('change', () => { current = Number(select.value); render(); });

    const move = (d) => {
      if (!ops.moveChapter(ch, d)) return;
      current = getChapters().indexOf(ch);
      render();
    };
    const add = () => {
      const created = ops.addChapter(current);
      current = getChapters().indexOf(created);
      render(true);
    };
    const remove = async () => {
      if (!(await ops.removeChapter(ch))) return;
      render();
    };

    const title = h('input', { type: 'text', className: 'chapter-title', value: ch.title, placeholder: '章タイトル', autocomplete: 'off' });
    title.setAttribute('aria-label', '章タイトル');
    title.addEventListener('input', () => {
      ch.title = title.value;
      select.options[current].textContent = chapterName(ch);
      onChange({ chapterTitle: true });
    });
    const count = h('span', { className: 'count' });
    const plot = h('textarea', { className: 'chapter-plot', value: ch.plot, placeholder: 'この章のプロット', spellcheck: false });
    plot.setAttribute('aria-label', '章のプロット');
    const updateCount = () => { count.textContent = `${countChars(plot.value).all.toLocaleString()}字`; };
    updateCount();
    plot.addEventListener('input', () => { ch.plot = plot.value; updateCount(); onChange(); });

    container.replaceChildren(
      h('div', { className: 'chapter-bar' },
        select,
        h('span', { className: 'count', textContent: `${current + 1} / ${chapters.length}章 ・ ${ops.episodeCount(ch)}話` }),
        btn('＋ 章を追加', add),
        btn('↑', () => move(-1)),
        btn('↓', () => move(1)),
        btn('削除', remove, 'tool danger')),
      h('div', { className: 'field-head' },
        h('label', { textContent: '章タイトル' }),
        h('span', { className: 'spacer' }),
        count,
        btn('コピー', () => (ch.plot ? copy(ch.plot, `「${chapterName(ch)}」のプロット`) : toast('プロットは空です')), 'copy')),
      title,
      plot);
    if (focusTitle) title.focus();
  }

  // 目次から「この章のプロット」を開くとき
  function select(chapterId) {
    const i = getChapters().findIndex((c) => c.id === chapterId);
    if (i >= 0) current = i;
  }

  return { render, select };
}
