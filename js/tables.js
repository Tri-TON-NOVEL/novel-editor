// 分類つきの表（設定・登場人物）と、章ごとの全体プロット
import { makeId, newChapter, countChars } from './format.js';

export const CHARACTER_COLUMNS = [
  { key: 'name', label: '名前', width: '9em' },
  { key: 'reading', label: '読み', width: '8em' },
  { key: 'age', label: '年齢', width: '4.5em' },
  { key: 'gender', label: '性別', width: '4.5em' },
  { key: 'role', label: '役割・立場', width: '10em' },
  { key: 'traits', label: '特徴（外見・性格）', wide: true },
  { key: 'notes', label: 'メモ', wide: true },
];

export const WORLD_COLUMNS = [
  { key: 'name', label: '項目', width: '10em' },
  { key: 'reading', label: '読み', width: '8em' },
  { key: 'detail', label: '説明', wide: true },
  { key: 'notes', label: 'メモ', wide: true },
];

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
 * @param opts      { columns, itemLabel, onChange, toast, copy }
 */
export function categorizedTable(container, getData, opts) {
  const { columns, itemLabel, onChange, toast, copy } = opts;

  function addCategory() {
    const data = getData();
    data.categories.push({ id: makeId(), name: '新しい分類' });
    onChange();
    render();
    const inputs = container.querySelectorAll('.cat-name');
    const last = inputs[inputs.length - 1];
    last.focus();
    last.select();
  }

  function removeCategory(cat) {
    const data = getData();
    const items = data.items.filter((i) => i.categoryId === cat.id);
    const name = cat.name || '（名前なし）';
    if (items.length) {
      if (data.categories.length === 1) { toast('最後の分類は削除できません。中の行を消すか、別の分類を作って移してください'); return; }
      const dest = data.categories.find((c) => c !== cat);
      if (!confirm(`分類「${name}」を削除しますか？\n中の${items.length}件は「${dest.name}」に移ります。`)) return;
      for (const i of items) i.categoryId = dest.id;
    } else if (!confirm(`分類「${name}」を削除しますか？`)) {
      return;
    }
    data.categories.splice(data.categories.indexOf(cat), 1);
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
    for (const c of columns) item[c.key] = '';
    getData().items.push(item);
    onChange();
    render();
    container.querySelector(`tr[data-id="${item.id}"] textarea`)?.focus();
  }

  function removeItem(item) {
    const label = item[columns[0].key] || '（名前なし）';
    if (!confirm(`「${label}」を削除しますか？`)) return;
    const items = getData().items;
    items.splice(items.indexOf(item), 1);
    onChange();
    render();
  }

  function copyCategory(cat) {
    const rows = getData().items.filter((i) => i.categoryId === cat.id);
    if (!rows.length) { toast('この分類は空です'); return; }
    const lines = [columns.map((c) => c.label).join('\t'), ...rows.map((r) => columns.map((c) => cellText(r[c.key])).join('\t'))];
    copy(lines.join('\n'), `「${cat.name}」の表（${rows.length}件）`);
  }

  function renderRow(item, data) {
    const tr = h('tr');
    tr.dataset.id = item.id;
    for (const c of columns) {
      const ta = h('textarea', { rows: 1, value: item[c.key] ?? '', spellcheck: false });
      ta.setAttribute('aria-label', c.label);
      ta.addEventListener('input', () => { item[c.key] = ta.value; autosize(ta); onChange(); });
      const td = h('td', { className: c.wide ? 'wide' : '' }, ta);
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

  function renderCategory(cat, data) {
    const items = data.items.filter((i) => i.categoryId === cat.id);
    const name = h('input', { type: 'text', className: 'cat-name', value: cat.name, autocomplete: 'off' });
    name.setAttribute('aria-label', '分類名');
    name.addEventListener('input', () => {
      cat.name = name.value;
      container.querySelectorAll(`option[value="${cat.id}"]`).forEach((o) => { o.textContent = cat.name || '（名前なし）'; });
      onChange();
    });
    const head = h('div', { className: 'cat-head' },
      name,
      h('span', { className: 'count', textContent: `${items.length}件` }),
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
    if (items.length) for (const i of items) tbody.append(renderRow(i, data));
    else tbody.append(h('tr', { className: 'empty-row' }, h('td', { colSpan: columns.length + 2, textContent: `まだ${itemLabel}がありません` })));

    return h('section', { className: 'cat' },
      head,
      h('div', { className: 'table-wrap' }, h('table', { className: 'grid' }, thead, tbody)),
      btn(`＋ ${itemLabel}を追加`, () => addItem(cat), 'tool add-row'));
  }

  function render() {
    const data = getData();
    container.replaceChildren(...data.categories.map((c) => renderCategory(c, data)), btn('＋ 分類を追加', addCategory, 'add-cat'));
    requestAnimationFrame(() => container.querySelectorAll('.grid textarea').forEach(autosize));
  }

  return { render };
}

/**
 * 章ごとの全体プロット
 * @param getChapters () => chapters 配列
 */
// 章はプルダウンで1つずつ切り替えて編集する
export function chapterList(container, getChapters, { onChange, toast, copy }) {
  let current = 0;
  const chapterName = (ch) => ch.title || '（無題の章）';

  function render(focusTitle = false) {
    const chapters = getChapters();
    current = Math.max(0, Math.min(current, chapters.length - 1));
    const ch = chapters[current];

    const select = h('select');
    select.setAttribute('aria-label', '章を選ぶ');
    chapters.forEach((c, i) => select.append(new Option(chapterName(c), String(i))));
    select.value = String(current);
    select.addEventListener('change', () => { current = Number(select.value); render(); });

    const move = (d) => {
      const j = current + d;
      if (j < 0 || j >= chapters.length) return;
      [chapters[current], chapters[j]] = [chapters[j], chapters[current]];
      current = j;
      onChange();
      render();
    };
    const add = () => {
      chapters.splice(current + 1, 0, newChapter());
      current += 1;
      onChange();
      render(true);
    };
    const remove = () => {
      const name = chapterName(ch);
      if (!confirm(`章「${name}」を削除しますか？`)) return;
      if (ch.plot && !confirm(`【最終確認】「${name}」のプロット ${countChars(ch.plot).all.toLocaleString()}字が消え、元に戻せません。削除しますか？`)) return;
      chapters.splice(current, 1);
      if (!chapters.length) chapters.push(newChapter());
      onChange();
      render();
      toast(`章「${name}」を削除しました`);
    };

    const title = h('input', { type: 'text', className: 'chapter-title', value: ch.title, placeholder: '章タイトル', autocomplete: 'off' });
    title.setAttribute('aria-label', '章タイトル');
    title.addEventListener('input', () => {
      ch.title = title.value;
      select.options[current].textContent = chapterName(ch);
      onChange();
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
        h('span', { className: 'count', textContent: `${current + 1} / ${chapters.length}章` }),
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
  return { render };
}
