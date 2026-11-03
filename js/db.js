// 端末内の作品保存（IndexedDB）。使えない環境ではメモリ上に保持する。
// v1: works（1作品＝1原稿）  v2: projects（1作品＝複数エピソード）  v3: versions（作品のバージョン）
// v4: meta（自動バックアップ先フォルダなど、localStorage に置けない値）
// v5: versions に projectId＋id の複合索引（巨大な履歴を作品ごとに少しずつ読む）
// v6: versions に projectId＋kind＋id の複合索引（稿だけを読む。作品全体の復元ポイントは大きく、iPhone で一緒に読むと落ちていた）
const DB_NAME = 'novel-editor';
const STORE = 'projects';
const VERSIONS = 'versions';
const META = 'meta';
const OLD_STORE = 'works';

let dbPromise = null;
const memory = new Map();
const memoryVersions = new Map();
let useMemory = false;

let opening = null;
let everOpened = false; // 一度でも開けたか（開き直しに失敗したときは、メモリ保存に切り替えずに失敗として返す）
function openDb() {
  if (!dbPromise) {
    dbPromise = opening = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 6);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
        let versionStore;
        if (!d.objectStoreNames.contains(VERSIONS)) {
          versionStore = d.createObjectStore(VERSIONS, { keyPath: 'id' });
          versionStore.createIndex('projectId', 'projectId');
        } else versionStore = req.transaction.objectStore(VERSIONS);
        if (!versionStore.indexNames.contains('projectIdId')) versionStore.createIndex('projectIdId', ['projectId', 'id']);
        if (!versionStore.indexNames.contains('projectKindId')) versionStore.createIndex('projectKindId', ['projectId', 'kind', 'id']);
        if (!d.objectStoreNames.contains(META)) d.createObjectStore(META);
      };
      req.onsuccess = () => {
        // 別のタブで新しい版が開かれたら接続を譲る
        req.result.onversionchange = () => { req.result.close(); location.reload(); };
        // iPhone・iPad では、アプリを裏に回したときなどに接続が閉じられることがある。次に使うときに開き直す
        req.result.onclose = () => { if (dbPromise === opening) dbPromise = null; };
        everOpened = true;
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => alert('このエディターが別のタブでも開かれています。\n他のタブを閉じるか再読み込みしてください。');
    }).catch((e) => {
      // 使っている途中で開き直せなかったときは、メモリ保存に切り替えない（切り替えると、それ以降の保存が消えてしまう）。
      // 失敗として返し、次に使うときにもう一度開き直す
      if (everOpened) { dbPromise = null; throw e; }
      console.warn('IndexedDB が使えないためメモリ保存に切り替えます', e);
      useMemory = true;
      return null;
    });
  }
  return dbPromise;
}

function request(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('IndexedDB の処理が中断されました', 'AbortError'));
  });
}

// iPhone・iPad では、接続が閉じられていて「The database connection is closing」などで失敗することがある。
// そのときは開き直して1回だけやり直す（中断された書き込みは保存されていないので、やり直しても二重にならない）
const isLostConnection = (e) => ['InvalidStateError', 'AbortError', 'UnknownError'].includes(e?.name)
  || /clos(ing|ed)|connection.*lost/i.test(e?.message || '');

async function transact(storeName, mode, fn) {
  const d = await openDb();
  if (useMemory || !d) return null;
  try {
    return await request(d, storeName, mode, fn);
  } catch (e) {
    if (!isLostConnection(e)) throw e;
    if (dbPromise === opening) { try { d.close(); } catch { /* 閉じていれば何もしない */ } dbPromise = null; }
    const again = await openDb().catch(() => null);
    if (useMemory || !again) throw e;
    return request(again, storeName, mode, fn);
  }
}

async function run(mode, fn) {
  return transact(STORE, mode, fn);
}

export const db = {
  get persistent() { return !useMemory; },
  async all() {
    const r = await run('readonly', (s) => s.getAll());
    return useMemory ? [...memory.values()] : r;
  },
  async get(id) {
    const r = await run('readonly', (s) => s.get(id));
    return useMemory ? memory.get(id) : r;
  },
  async put(project) {
    if (useMemory) { memory.set(project.id, structuredClone(project)); return; }
    await run('readwrite', (s) => s.put(project));
  },
  async remove(id) {
    if (useMemory) { memory.delete(id); return; }
    await run('readwrite', (s) => s.delete(id));
  },
  // 旧形式（v1）の作品。移し替えが済んだら clearOldWorks で消す
  async oldWorks() {
    const d = await openDb();
    if (useMemory || !d.objectStoreNames.contains(OLD_STORE)) return [];
    return transact(OLD_STORE, 'readonly', (s) => s.getAll());
  },
  async clearOldWorks() {
    const d = await openDb();
    if (useMemory || !d.objectStoreNames.contains(OLD_STORE)) return;
    await transact(OLD_STORE, 'readwrite', (s) => s.clear());
  },
};

// フォルダのハンドルなど、そのまま保存する値
const memoryMeta = new Map();
export const meta = {
  async get(key) {
    if (useMemory || !(await openDb())) return memoryMeta.get(key);
    return transact(META, 'readonly', (s) => s.get(key));
  },
  async set(key, value) {
    if (useMemory || !(await openDb())) { memoryMeta.set(key, value); return; }
    await transact(META, 'readwrite', (s) => s.put(value, key));
  },
  async remove(key) {
    if (useMemory || !(await openDb())) { memoryMeta.delete(key); return; }
    await transact(META, 'readwrite', (s) => s.delete(key));
  },
};

// 作品のバージョン（その時点の作品まるごとのコピー）。auto: true は自動で残したもの
//   { id, projectId, name, memo, createdAt, chars, episodes, data }
// 稿（エピソードの原稿の版）。それ以外（kind: 'project' や種類のない古いもの）は、作品全体の復元ポイント
const isEditionKind = (kind) => kind === 'episode' || kind === 'episode-legacy';

async function runVersions(mode, fn) {
  return transact(VERSIONS, mode, fn);
}

export const versions = {
  async list(projectId) {
    const r = useMemory
      ? [...memoryVersions.values()].filter((v) => v.projectId === projectId)
      : await runVersions('readonly', (s) => s.index('projectId').getAll(projectId));
    return r.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async all() {
    return useMemory ? [...memoryVersions.values()] : runVersions('readonly', (s) => s.getAll());
  },
  // 少しずつ読む（id の順に、after の次から size 件）。全部を一度に読むとメモリが足りない iPhone 向け
  async page(after = null, size = 50) {
    if (useMemory) {
      const ids = [...memoryVersions.keys()].sort();
      return ids.filter((id) => after === null || id > after).slice(0, size).map((id) => memoryVersions.get(id));
    }
    return runVersions('readonly', (s) => s.getAll(after === null ? null : IDBKeyRange.lowerBound(after, true), size));
  },
  // 一つの作品の稿・履歴を id 順に少しずつ読む。600MB級でも全件を同時にメモリへ載せない。
  async pageProject(projectId, after = null, size = 25) {
    if (useMemory) {
      const values = [...memoryVersions.values()]
        .filter((v) => v.projectId === projectId && (after === null || v.id > after))
        .sort((a, b) => a.id.localeCompare(b.id));
      return values.slice(0, size);
    }
    const lower = [projectId, after === null ? '' : after];
    const upper = [projectId, '\uffff'];
    const range = IDBKeyRange.bound(lower, upper, after !== null, false);
    return runVersions('readonly', (s) => s.index('projectIdId').getAll(range, size));
  },
  // 一つの作品の稿（kind が 'episode'／'episode-legacy'）だけを、少しずつ読む。作品全体の復元ポイントは読まない。
  // 索引の順は [kind, id]。after は前に読んだ最後の稿
  async pageEditions(projectId, after = null, size = 25) {
    if (useMemory) {
      const key = (v) => `${v.kind}\u0000${v.id}`;
      const values = [...memoryVersions.values()]
        .filter((v) => v.projectId === projectId && isEditionKind(v.kind) && (after === null || key(v) > key(after)))
        .sort((a, b) => key(a).localeCompare(key(b)));
      return values.slice(0, size);
    }
    // 'episode' と 'episode-legacy' は索引で隣り合う（あいだに入る種類はない）
    const lower = after === null ? [projectId, 'episode', ''] : [projectId, after.kind, after.id];
    const range = IDBKeyRange.bound(lower, [projectId, 'episode-legacy', '￿'], after !== null, false);
    return runVersions('readonly', (s) => s.index('projectKindId').getAll(range, size));
  },
  // 一つの作品の稿をすべて（稿は1件が1話分なので、作品全体の復元ポイントよりずっと小さい）
  async editions(projectId) {
    const out = [];
    for (let after = null; ;) {
      const page = await this.pageEditions(projectId, after, 200);
      out.push(...page);
      if (page.length < 200) break;
      after = page.at(-1);
    }
    return out;
  },
  // 一つの作品の、作品全体の復元ポイントの一覧（中身の data は持たない。新しい順）。
  // 1件ずつ読んでは中身を捨てるので、何百件あっても一度にメモリへ載せない。中身は get(id) で読む
  async restorePoints(projectId) {
    const light = ({ data, ...rest }) => rest;
    let out = [];
    if (useMemory) out = [...memoryVersions.values()].filter((v) => v.projectId === projectId && !isEditionKind(v.kind)).map(light);
    else {
      await runVersions('readonly', (s) => {
        const req = s.index('projectId').openCursor(IDBKeyRange.only(projectId));
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return;
          if (!isEditionKind(c.value.kind)) out.push(light(c.value));
          c.continue();
        };
        return null;
      });
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  },
  // 一つの作品（episodeId を渡したときは、その話）の稿をすべて削除する（バックアップで上書きするとき、稿をそっくり入れ替えるため）。
  // 作品全体の復元ポイントは消さない
  async removeEditions(projectId, episodeId = null) {
    let ids;
    if (useMemory) ids = [...memoryVersions.values()].filter((v) => v.projectId === projectId && isEditionKind(v.kind) && (!episodeId || v.episodeId === episodeId)).map((v) => v.id);
    else if (!episodeId) {
      const range = IDBKeyRange.bound([projectId, 'episode', ''], [projectId, 'episode-legacy', '￿']);
      ids = await runVersions('readonly', (s) => s.index('projectKindId').getAllKeys(range));
    } else ids = (await this.editions(projectId)).filter((v) => v.episodeId === episodeId).map((v) => v.id);
    for (const id of ids || []) await this.remove(id);
    return (ids || []).length;
  },
  async count(projectId) {
    if (useMemory) return [...memoryVersions.values()].filter((v) => v.projectId === projectId).length;
    return runVersions('readonly', (s) => s.index('projectId').count(IDBKeyRange.only(projectId)));
  },
  async get(id) {
    return useMemory ? memoryVersions.get(id) : runVersions('readonly', (s) => s.get(id));
  },
  async put(v) {
    if (useMemory) { memoryVersions.set(v.id, structuredClone(v)); return; }
    await runVersions('readwrite', (s) => s.put(v));
  },
  async remove(id) {
    if (useMemory) { memoryVersions.delete(id); return; }
    await runVersions('readwrite', (s) => s.delete(id));
  },
  async removeProject(projectId) {
    // 中身は読まずに、id だけを集めて消す
    const ids = useMemory ? [...memoryVersions.values()].filter((v) => v.projectId === projectId).map((v) => v.id)
      : await runVersions('readonly', (s) => s.index('projectId').getAllKeys(IDBKeyRange.only(projectId)));
    for (const id of ids || []) await this.remove(id);
  },
  async clear() {
    if (useMemory) { memoryVersions.clear(); return; }
    await runVersions('readwrite', (s) => s.clear());
  },
};

// 小さな設定値は localStorage に置く（使えなくても動くようにする）
export const prefs = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem('novel-editor:' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('novel-editor:' + key, JSON.stringify(value)); } catch { /* 保存できなくても続行 */ }
    scheduleEnvironmentSave();
  },
  // すべての設定値（バックアップ用）
  entries() {
    const out = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith('novel-editor:')) continue;
        // 1件読めなくても、ほかの設定は読む（全部が空に見えると、「設定が消えた」と思って控えで上書きしてしまうため）
        try { out[k.slice('novel-editor:'.length)] = JSON.parse(localStorage.getItem(k)); } catch { /* その1件だけ飛ばす */ }
      }
    } catch { /* 読めなければ空 */ }
    return out;
  },
};

// ---------- 環境（設定）の自動保存 ----------
// 設定は localStorage にあるが、ブラウザーが消すことがある（iPhone の Safari など）。
// 小説とは分けて、IndexedDB の meta（'environment'）にも控えておき、設定がすべて消えていたら戻す。
// ログインの鍵（novel-editor-session:）は控えない。クラウドへは、利用者が選んだときだけ送る（自動では送らない）。
const ENV_KEY = 'environment';
let envTimer = null;
function scheduleEnvironmentSave() {
  clearTimeout(envTimer);
  envTimer = setTimeout(() => { saveEnvironment().catch(() => {}); }, 800);
}

export async function saveEnvironment() {
  clearTimeout(envTimer);
  const entries = prefs.entries();
  if (!Object.keys(entries).length) return;
  await meta.set(ENV_KEY, { savedAt: new Date().toISOString(), prefs: entries });
}

/** 設定がすべて消えていて、控えがあれば戻す。戻したら控えの日時、戻さなければ null */
export async function restoreEnvironmentIfLost() {
  if (Object.keys(prefs.entries()).length) return null;
  const saved = await meta.get(ENV_KEY).catch(() => null);
  if (!saved?.prefs || !Object.keys(saved.prefs).length) return null;
  for (const [key, value] of Object.entries(saved.prefs)) {
    try { localStorage.setItem('novel-editor:' + key, JSON.stringify(value)); } catch { /* 保存できなくても続行 */ }
  }
  return saved.savedAt || '';
}
