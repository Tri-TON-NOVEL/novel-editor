// 伏線の画面：エピソードの「伏線」「回収」タブと、作品の「伏線一覧」
import {
  FS_STATUS, FS_STATUS_KEYS, PAYOFF_KIND, newForeshadow, newPayoff, applyAutoStatus,
  episodeNumbers, episodeRef, episodeLabel, foreshadowRows, byOrigin, matchesQuery, inRange, payoffCandidates,
} from './foreshadow.js';

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
const statusBadge = (s) => h('span', { class: `fs-badge fs-st-${s}`, text: FS_STATUS[s] || s });

/**
 * opts:
 *   getProject(), getEpisode(), changed(), ask(msg, opts), toast(msg), prefs,
 *   openEpisode(episodeId, sideTab)：そのエピソードを開き、指定のタブを出す
 */
export function initForeshadow(opts) {
  const { getProject, getEpisode, changed, ask, toast, prefs } = opts;
  let editingId = ''; // 「伏線」タブで編集中の伏線
  let draft = null; // 「回収」タブで開いている記録欄 { fsId, eventId, kind, body }

  const list = () => {
    const p = getProject();
    if (!Array.isArray(p.foreshadows)) p.foreshadows = [];
    return p.foreshadows;
  };
  const touch = (fs) => { fs.updatedAt = new Date().toISOString(); };
  const currentRef = () => {
    const p = getProject();
    const ep = getEpisode();
    return { ep, ref: episodeRef(p, ep.id, null) };
  };
  const refText = (ref) => (ref.deleted ? episodeLabel(ref) : `${episodeLabel(ref)}「${ref.title}」`);

  // ---------- 「伏線」タブ：この話で張った伏線 ----------
  const form = $('fs-form');

  function resetForm() {
    editingId = '';
    form.reset();
    $('fs-form-head').textContent = '伏線を登録';
    $('fs-form-submit').textContent = '登録';
    $('fs-form-cancel').hidden = true;
  }

  function startEdit(fs) {
    editingId = fs.id;
    form.elements.title.value = fs.title;
    form.elements.body.value = fs.body;
    $('fs-form-head').textContent = `「${fs.title || '名前なし'}」を編集`;
    $('fs-form-submit').textContent = '更新';
    $('fs-form-cancel').hidden = false;
    form.elements.title.focus();
  }

  async function removeForeshadow(fs) {
    const n = fs.events.length;
    const msg = `伏線「${fs.title || '名前なし'}」を削除しますか？` + (n ? `\n回収の記録（${n}件）も一緒に消えます。` : '') + '\n元に戻せません。';
    if (!(await ask(msg, { danger: true, ok: '削除する' }))) return false;
    const all = list();
    const i = all.indexOf(fs);
    if (i < 0) return false;
    all.splice(i, 1);
    if (editingId === fs.id) resetForm();
    changed();
    toast(`伏線「${fs.title || '名前なし'}」を削除しました`);
    return true;
  }

  function payoffSummary(project, fs, nums) {
    if (!fs.events.length) return null;
    return h('ul', { class: 'fs-events' }, fs.events
      .map((ev) => ({ ev, ref: episodeRef(project, ev.episodeId, ev.recordedNo, nums) }))
      .sort((a, b) => (a.ref.no ?? Infinity) - (b.ref.no ?? Infinity))
      .map(({ ev, ref }) => h('li', {},
        h('span', { class: `fs-kind fs-kind-${ev.kind}`, text: `${episodeLabel(ref)} ${PAYOFF_KIND[ev.kind]}` }),
        ev.body ? h('span', { class: 'fs-event-body', text: ev.body }) : null)));
  }

  function renderHere() {
    const project = getProject();
    const { ep, ref } = currentRef();
    $('fs-epno').textContent = refText(ref);
    const nums = episodeNumbers(project);
    const mine = list().filter((f) => f.episodeId === ep.id);
    if (editingId && !mine.some((f) => f.id === editingId)) resetForm();
    const box = $('fs-here');
    box.replaceChildren(...(mine.length ? mine.map((fs) => h('li', { class: 'fs-card' + (fs.id === editingId ? ' editing' : '') },
      h('div', { class: 'fs-card-head' },
        h('strong', { class: 'fs-name', text: fs.title || '（名前なし）' }),
        statusBadge(fs.status)),
      fs.body ? h('p', { class: 'fs-body', text: fs.body }) : null,
      payoffSummary(project, fs, nums),
      h('div', { class: 'fs-card-foot' },
        h('button', { type: 'button', class: 'tool', text: '編集', onclick: () => { startEdit(fs); renderHere(); } }),
        h('button', { type: 'button', class: 'tool danger', text: '削除', onclick: () => removeForeshadow(fs).then((ok) => ok && renderEpisode()) })),
    )) : [h('li', { class: 'fs-empty', text: 'この話で張った伏線はまだありません。下の欄から登録できます。' })]));
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const title = form.elements.title.value.trim();
    const body = form.elements.body.value.trim();
    if (!title) { form.elements.title.focus(); return; }
    const { ep, ref } = currentRef();
    if (editingId) {
      const fs = list().find((f) => f.id === editingId);
      if (fs) { fs.title = title; fs.body = body; touch(fs); toast(`伏線「${title}」を更新しました`); }
    } else {
      list().push(newForeshadow({ title, body, episodeId: ep.id, recordedNo: ref.no }));
      toast(`伏線「${title}」を${episodeLabel(ref)}に登録しました`);
    }
    changed();
    resetForm();
    renderEpisode();
  });
  $('fs-form-cancel').addEventListener('click', () => { resetForm(); renderHere(); });

  // ---------- 「回収」タブ：この話までの伏線と、この話での回収 ----------
  const PAYOFF_DEFAULT = ['open', 'partial'];
  const payoffStatuses = () => {
    const saved = prefs.get('payoff.filter', PAYOFF_DEFAULT);
    return Array.isArray(saved) ? saved.filter((s) => FS_STATUS_KEYS.includes(s)) : PAYOFF_DEFAULT;
  };
  document.querySelectorAll('[data-payoff-status]').forEach((c) => {
    c.addEventListener('change', () => {
      prefs.set('payoff.filter', [...document.querySelectorAll('[data-payoff-status]:checked')].map((x) => x.dataset.payoffStatus));
      renderPayoff();
    });
  });
  $('payoff-search').addEventListener('input', () => renderPayoff());

  function payoffForm(fs) {
    const kindName = `payoff-kind-${fs.id}`;
    const ta = h('textarea', { rows: '3', spellcheck: 'false', placeholder: 'どのように回収したか', 'aria-label': '回収内容' });
    ta.value = draft.body;
    ta.addEventListener('input', () => { draft.body = ta.value; });
    const radio = (kind) => {
      const r = h('input', { type: 'radio', name: kindName, value: kind });
      r.checked = draft.kind === kind;
      r.addEventListener('change', () => { draft.kind = kind; });
      return h('label', {}, r, ` ${PAYOFF_KIND[kind]}`);
    };
    const save = () => {
      const { ep, ref } = currentRef();
      const target = list().find((f) => f.id === draft.fsId);
      if (!target) { draft = null; renderPayoff(); return; }
      if (draft.eventId) {
        const ev = target.events.find((x) => x.id === draft.eventId);
        if (ev) { ev.kind = draft.kind; ev.body = draft.body.trim(); }
      } else {
        target.events.push(newPayoff({ kind: draft.kind, body: draft.body.trim(), episodeId: ep.id, recordedNo: ref.no }));
      }
      applyAutoStatus(target);
      touch(target);
      changed();
      toast(`「${target.title || '名前なし'}」の${PAYOFF_KIND[draft.kind]}を${episodeLabel(ref)}に記録しました`);
      draft = null;
      renderEpisode();
    };
    setTimeout(() => ta.focus(), 0);
    return h('div', { class: 'fs-payoff-form' },
      h('div', { class: 'fs-radios' }, radio('partial'), radio('resolved')),
      ta,
      h('div', { class: 'fs-form-foot' },
        h('button', { type: 'button', text: 'やめる', onclick: () => { draft = null; renderPayoff(); } }),
        h('button', { type: 'button', class: 'primary', text: draft.eventId ? '更新' : 'この話で記録', onclick: save })));
  }

  async function removeEvent(fs, ev) {
    if (!(await ask(`「${fs.title || '名前なし'}」の${PAYOFF_KIND[ev.kind]}の記録を削除しますか？`, { danger: true, ok: '削除する' }))) return;
    const i = fs.events.indexOf(ev);
    if (i < 0) return;
    fs.events.splice(i, 1);
    applyAutoStatus(fs);
    touch(fs);
    changed();
    renderEpisode();
  }

  function renderPayoff() {
    const project = getProject();
    const { ep, ref } = currentRef();
    $('payoff-epno').textContent = refText(ref);
    const statuses = payoffStatuses();
    document.querySelectorAll('[data-payoff-status]').forEach((c) => { c.checked = statuses.includes(c.dataset.payoffStatus); });
    const q = $('payoff-search').value;
    const rows = payoffCandidates(project, ep.id, statuses).filter((r) => matchesQuery(r, q, 'all'));
    if (draft && !rows.some((r) => r.fs.id === draft.fsId)) draft = null;
    const box = $('payoff-list');
    if (!rows.length) {
      const none = !list().length ? 'まだ伏線がありません。「伏線」タブで、張った伏線を登録します。'
        : 'この話までに張った伏線で、条件に合うものはありません（上のチェックで「回収済み」なども出せます）。';
      box.replaceChildren(h('li', { class: 'fs-empty', text: none }));
      return;
    }
    box.replaceChildren(...rows.map(({ fs, origin, payoffs }) => {
      const open = draft?.fsId === fs.id;
      return h('li', { class: 'fs-card' },
        h('div', { class: 'fs-card-head' },
          h('button', { type: 'button', class: 'fs-ep-link', text: episodeLabel(origin), title: origin.title || '', disabled: origin.deleted || undefined,
            onclick: () => opts.openEpisode(fs.episodeId, 'foreshadow') }),
          h('strong', { class: 'fs-name', text: fs.title || '（名前なし）' }),
          statusBadge(fs.status)),
        fs.body ? h('p', { class: 'fs-body', text: fs.body }) : null,
        payoffs.length ? h('ul', { class: 'fs-events' }, payoffs.map(({ ev, ref: r }) => {
          const here = ev.episodeId === ep.id;
          return h('li', { class: here ? 'here' : '' },
            h('span', { class: `fs-kind fs-kind-${ev.kind}`, text: `${episodeLabel(r)} ${PAYOFF_KIND[ev.kind]}` }),
            ev.body ? h('span', { class: 'fs-event-body', text: ev.body }) : null,
            here ? h('span', { class: 'fs-event-tools' },
              h('button', { type: 'button', class: 'tool', text: '編集', onclick: () => { draft = { fsId: fs.id, eventId: ev.id, kind: ev.kind, body: ev.body }; renderPayoff(); } }),
              h('button', { type: 'button', class: 'tool danger', text: '削除', onclick: () => removeEvent(fs, ev) })) : null);
        })) : null,
        open ? payoffForm(fs) : h('div', { class: 'fs-card-foot' },
          h('button', { type: 'button', class: 'tool', text: `この話（${episodeLabel(ref)}）で回収を記録`,
            onclick: () => { draft = { fsId: fs.id, eventId: '', kind: 'partial', body: '' }; renderPayoff(); } })));
    }));
  }

  function renderEpisode() {
    if (!getProject()) return;
    renderHere();
    renderPayoff();
  }

  // ---------- 伏線一覧 ----------
  const STATUS_ORDER = { open: 0, partial: 1, resolved: 2, dropped: 3 };
  const listStatuses = () => [...document.querySelectorAll('[data-fsl-status]:checked')].map((c) => c.dataset.fslStatus);
  {
    const saved = prefs.get('fsl.filter', null);
    if (Array.isArray(saved)) document.querySelectorAll('[data-fsl-status]').forEach((c) => { c.checked = saved.includes(c.dataset.fslStatus); });
    const sort = prefs.get('fsl.sort', 'origin');
    if ([...$('fsl-sort').options].some((o) => o.value === sort)) $('fsl-sort').value = sort;
  }
  document.querySelectorAll('[data-fsl-status]').forEach((c) => c.addEventListener('change', () => { prefs.set('fsl.filter', listStatuses()); renderList(); }));
  $('fsl-sort').addEventListener('change', () => { prefs.set('fsl.sort', $('fsl-sort').value); renderList(); });
  for (const id of ['fsl-search', 'fsl-from', 'fsl-to']) $(id).addEventListener('input', () => renderList());
  $('fsl-field').addEventListener('change', () => renderList());

  const lastNo = (r) => (r.payoffs.length ? r.payoffs.at(-1).ref.no ?? 0 : -1);
  const SORTS = {
    origin: byOrigin,
    status: (a, b) => STATUS_ORDER[a.fs.status] - STATUS_ORDER[b.fs.status] || byOrigin(a, b),
    last: (a, b) => lastNo(b) - lastNo(a) || byOrigin(a, b),
    title: (a, b) => a.fs.title.localeCompare(b.fs.title, 'ja') || byOrigin(a, b),
  };

  function statusSelect(fs) {
    const s = h('select', { 'aria-label': `「${fs.title}」の状態` }, FS_STATUS_KEYS.map((k) => h('option', { value: k, text: FS_STATUS[k] })));
    s.value = fs.status;
    s.className = `fs-status-select fs-st-${fs.status}`;
    s.addEventListener('change', () => {
      fs.status = s.value;
      touch(fs);
      changed();
      renderList();
    });
    return s;
  }

  function renderList() {
    const project = getProject();
    if (!project) return;
    const num = (id) => { const v = parseInt($(id).value, 10); return v > 0 ? v : null; };
    const statuses = listStatuses();
    const all = foreshadowRows(project);
    const rows = all
      .filter((r) => statuses.includes(r.fs.status) && matchesQuery(r, $('fsl-search').value, $('fsl-field').value) && inRange(r, num('fsl-from'), num('fsl-to')))
      .sort(SORTS[$('fsl-sort').value] || byOrigin);
    $('fsl-count').textContent = `${rows.length}件` + (rows.length !== all.length ? `（全${all.length}件）` : '');
    const empty = $('fsl-empty');
    empty.hidden = rows.length > 0;
    empty.textContent = all.length ? '条件に合う伏線はありません。' : 'まだ伏線がありません。エピソードの「伏線」タブで登録します。';
    $('fsl-table').hidden = !rows.length;
    const epLink = (ref, episodeId, tab) => h('button', { type: 'button', class: 'fs-ep-link', text: episodeLabel(ref), disabled: ref.deleted || undefined,
      onclick: () => opts.openEpisode(episodeId, tab) });
    $('fsl-body').replaceChildren(...rows.map(({ fs, origin, payoffs }) => h('tr', {},
      h('td', { 'data-label': '状態' }, statusSelect(fs)),
      h('td', { 'data-label': '発生', class: 'fs-origin' }, epLink(origin, fs.episodeId, 'foreshadow'), origin.title ? h('span', { class: 'fs-ep-title', text: origin.title }) : null),
      h('td', { 'data-label': '名前', class: 'fs-name' }, fs.title || '（名前なし）'),
      h('td', { 'data-label': '内容', class: 'fs-body' }, fs.body),
      h('td', { 'data-label': '回収・部分回収' }, payoffs.length ? h('ul', { class: 'fs-events' }, payoffs.map(({ ev, ref }) => h('li', {},
        epLink(ref, ev.episodeId, 'payoff'),
        h('span', { class: `fs-kind fs-kind-${ev.kind}`, text: PAYOFF_KIND[ev.kind] }),
        ev.body ? h('span', { class: 'fs-event-body', text: ev.body }) : null))) : h('span', { class: 'fs-none', text: '—' })),
      h('td', { class: 'fs-actions' }, h('button', { type: 'button', class: 'tool', text: '編集', onclick: () => openEditDialog(fs) })),
    )));
  }

  // ---------- 編集ダイアログ（一覧から。削除した話の伏線もここで直せる） ----------
  const dlg = $('fs-edit-dialog');
  const dform = $('fs-edit-form');
  dform.elements.status.replaceChildren(...FS_STATUS_KEYS.map((k) => h('option', { value: k, text: FS_STATUS[k] })));
  let editing = null; // { fs, events（作業用の写し）, statusTouched }

  function renderDialogEvents() {
    const project = getProject();
    const nums = episodeNumbers(project);
    const box = $('fs-edit-events');
    if (!editing.events.length) { box.replaceChildren(h('p', { class: 'hint', text: '回収の記録はまだありません（エピソードの「回収」タブで記録します）。' })); return; }
    box.replaceChildren(h('div', { class: 'fs-edit-events-head', text: '回収の記録' }), ...editing.events.map((ev) => {
      const ref = episodeRef(project, ev.episodeId, ev.recordedNo, nums);
      const kind = h('select', { 'aria-label': '種類' }, Object.entries(PAYOFF_KIND).map(([k, v]) => h('option', { value: k, text: v })));
      kind.value = ev.kind;
      kind.addEventListener('change', () => { ev.kind = kind.value; syncDialogStatus(); });
      const body = h('textarea', { rows: '2', spellcheck: 'false', 'aria-label': '回収内容' });
      body.value = ev.body;
      body.addEventListener('input', () => { ev.body = body.value; });
      return h('div', { class: 'fs-edit-event' },
        h('div', { class: 'fs-edit-event-head' },
          h('span', { class: 'fs-ep-label', text: refText(ref) }), kind,
          h('button', { type: 'button', class: 'tool danger', text: '削除', onclick: () => {
            editing.events = editing.events.filter((x) => x !== ev);
            syncDialogStatus();
            renderDialogEvents();
          } })),
        body);
    }));
  }

  // 状態を自分で選んでいなければ、回収の記録に合わせる
  function syncDialogStatus() {
    if (editing.statusTouched) return;
    const tmp = applyAutoStatus({ status: editing.fs.status, events: editing.events });
    dform.elements.status.value = tmp.status;
  }

  function openEditDialog(fs) {
    const project = getProject();
    editing = { fs, events: fs.events.map((e) => ({ ...e })), statusTouched: false };
    dform.elements.title.value = fs.title;
    dform.elements.body.value = fs.body;
    dform.elements.status.value = fs.status;
    $('fs-edit-origin').textContent = `発生：${refText(episodeRef(project, fs.episodeId, fs.recordedNo))}`;
    renderDialogEvents();
    dlg.showModal();
  }

  dform.elements.status.addEventListener('change', () => { if (editing) editing.statusTouched = true; });
  $('fs-edit-cancel').addEventListener('click', () => dlg.close());
  $('fs-edit-delete').addEventListener('click', async () => {
    if (!editing) return;
    dlg.close();
    if (await removeForeshadow(editing.fs)) { editing = null; renderList(); renderEpisode(); }
    else openEditDialog(editing.fs);
  });
  dform.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!editing) return;
    const title = dform.elements.title.value.trim();
    if (!title) { dform.elements.title.focus(); return; }
    const { fs } = editing;
    if (!list().includes(fs)) { dlg.close(); return; }
    fs.title = title;
    fs.body = dform.elements.body.value.trim();
    fs.events = editing.events.map((ev) => ({ ...ev, body: ev.body.trim() }));
    fs.status = dform.elements.status.value;
    touch(fs);
    changed();
    editing = null;
    dlg.close();
    toast(`伏線「${title}」を保存しました`);
    renderList();
    renderEpisode();
  });

  return {
    renderEpisode,
    renderList,
    // 作品を替えたときなど：編集中の状態を消す
    reset() { resetForm(); draft = null; },
  };
}
