// 伏線の発生・回収（作品ごと）。画面に関係しないデータの処理だけをここに置く
//
// project.foreshadows = [{
//   id, title（名前）, body（内容）,
//   episodeId（張ったエピソード）, recordedNo（登録したときの話数。エピソードを削除したあとの表示用）,
//   status: 'open'（未回収）| 'partial'（部分回収済み）| 'resolved'（回収済み）| 'dropped'（取りやめ）,
//   events: [{ id, kind: 'partial' | 'resolved', episodeId, recordedNo, body（回収内容）, createdAt }],
//   createdAt, updatedAt,
// }]
// 話数は「作品のエピソードの並び順＋1」（活動報告・ひな型の {話数} と同じ数え方）。
// 並べ替えても追いかけられるよう、エピソードの id で持ち、表示するときに今の話数を出す。
import { makeId, episodeName } from './format.js';

export const FS_STATUS = { open: '未回収', partial: '部分回収済み', resolved: '回収済み', dropped: '取りやめ' };
export const FS_STATUS_KEYS = Object.keys(FS_STATUS);
export const PAYOFF_KIND = { partial: '部分回収', resolved: '回収' };

const now = () => new Date().toISOString();
const str = (v) => String(v ?? '');
const noOrNull = (v) => (Number.isInteger(v) && v > 0 ? v : null);

export function newForeshadow(content = {}) {
  const t = now();
  return { id: makeId(), title: '', body: '', episodeId: '', recordedNo: null, status: 'open', events: [], createdAt: t, updatedAt: t, ...content };
}

export function newPayoff(content = {}) {
  return { id: makeId(), kind: 'partial', episodeId: '', recordedNo: null, body: '', createdAt: now(), ...content };
}

// 読み込んだデータを整える（知らない項目は残す。id がなければ決まった id にする＝読むたびに変わらない）
export function normalizeForeshadows(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((f) => f && typeof f === 'object').map((f, i) => {
    const id = str(f.id || 'fs-' + (i + 1));
    const events = (Array.isArray(f.events) ? f.events : []).filter((e) => e && typeof e === 'object').map((e, j) => ({
      ...e,
      id: str(e.id || `${id}-ev-${j + 1}`),
      kind: e.kind === 'resolved' ? 'resolved' : 'partial',
      episodeId: str(e.episodeId),
      recordedNo: noOrNull(e.recordedNo),
      body: str(e.body),
    }));
    return {
      ...f,
      id,
      title: str(f.title),
      body: str(f.body),
      episodeId: str(f.episodeId),
      recordedNo: noOrNull(f.recordedNo),
      status: FS_STATUS_KEYS.includes(f.status) ? f.status : autoStatus(events),
      events,
    };
  });
}

// 回収の記録から決まる状態（回収が1つでもあれば回収済み、部分回収だけなら部分回収済み）
export function autoStatus(events = []) {
  if (events.some((e) => e.kind === 'resolved')) return 'resolved';
  if (events.some((e) => e.kind === 'partial')) return 'partial';
  return 'open';
}

// 回収の記録を足した・消したあとに状態を合わせる（「取りやめ」にしたものは、自分で戻すまでそのまま）
export function applyAutoStatus(fs) {
  if (fs.status !== 'dropped') fs.status = autoStatus(fs.events);
  return fs;
}

// エピソード id → 今の話数
export function episodeNumbers(project) {
  return new Map((project.episodes || []).map((e, i) => [e.id, i + 1]));
}

// 話の表示に使う情報。エピソードを削除していれば、登録したときの話数を使う
export function episodeRef(project, episodeId, recordedNo, nums = episodeNumbers(project)) {
  const no = nums.get(episodeId);
  if (no) {
    const ep = project.episodes[no - 1];
    return { no, title: episodeName(ep, project.site), deleted: false };
  }
  return { no: recordedNo || null, title: '', deleted: true };
}

export function episodeLabel(ref) {
  if (ref.deleted) return ref.no ? `第${ref.no}話（削除済み）` : '（削除済みの話）';
  return `第${ref.no}話`;
}

// エピソードを削除する前に、その話を指している記録へ今の話数を書いておく
export function stampEpisodeNo(project, episodeId, no) {
  for (const fs of project.foreshadows || []) {
    if (fs.episodeId === episodeId) fs.recordedNo = no;
    for (const e of fs.events || []) if (e.episodeId === episodeId) e.recordedNo = no;
  }
}

// 一覧・回収タブで使う形にする（並べ替え用の話数つき）
export function foreshadowRows(project) {
  const nums = episodeNumbers(project);
  return (project.foreshadows || []).map((fs, index) => {
    const origin = episodeRef(project, fs.episodeId, fs.recordedNo, nums);
    const payoffs = (fs.events || []).map((ev) => ({ ev, ref: episodeRef(project, ev.episodeId, ev.recordedNo, nums) }))
      .sort((a, b) => (a.ref.no ?? Infinity) - (b.ref.no ?? Infinity));
    return { fs, index, origin, payoffs };
  });
}

const sortNo = (ref) => ref.no ?? Infinity;

// 発生した話の順（同じ話の中は登録順）
export function byOrigin(a, b) {
  return sortNo(a.origin) - sortNo(b.origin) || a.index - b.index;
}

// 検索。field：'all' | 'title' | 'body' | 'origin' | 'payoff'
export function matchesQuery(row, query, field = 'all') {
  const words = str(query).trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const parts = {
    title: row.fs.title,
    body: row.fs.body,
    origin: `${episodeLabel(row.origin)} ${row.origin.no ?? ''} ${row.origin.title}`,
    payoff: row.payoffs.map((p) => `${episodeLabel(p.ref)} ${p.ref.no ?? ''} ${p.ref.title} ${PAYOFF_KIND[p.ev.kind]} ${p.ev.body}`).join('\n'),
  };
  const text = (field === 'all' ? [...Object.values(parts), FS_STATUS[row.fs.status]].join('\n') : parts[field] || '').toLowerCase();
  return words.every((w) => text.includes(w));
}

// 話の範囲（発生・回収のどれかが範囲に入っていれば出す）。from・to は空なら制限なし
export function inRange(row, from, to) {
  if (!from && !to) return true;
  const ok = (no) => no != null && (!from || no >= from) && (!to || no <= to);
  return ok(row.origin.no) || row.payoffs.some((p) => ok(p.ref.no));
}

// 回収タブに出す伏線：この話まで（同じ話も含む）に張ったもので、選んだ状態のもの
export function payoffCandidates(project, episodeId, statuses) {
  const nums = episodeNumbers(project);
  const current = nums.get(episodeId) ?? Infinity;
  return foreshadowRows(project)
    .filter((r) => r.origin.no != null && r.origin.no <= current && statuses.includes(r.fs.status))
    .sort(byOrigin);
}
