// 端末内の作品保存（IndexedDB）。使えない環境ではメモリ上に保持する。
// v1: works（1作品＝1原稿）  v2: projects（1作品＝複数エピソード）
const DB_NAME = 'novel-editor';
const STORE = 'projects';
const OLD_STORE = 'works';

let dbPromise = null;
const memory = new Map();
let useMemory = false;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        // 別のタブで新しい版が開かれたら接続を譲る
        req.result.onversionchange = () => { req.result.close(); location.reload(); };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => alert('このエディターが別のタブでも開かれています。\n他のタブを閉じるか再読み込みしてください。');
    }).catch((e) => {
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
    tx.onabort = () => reject(tx.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  if (useMemory) return null;
  return request(db, STORE, mode, fn);
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
    return request(d, OLD_STORE, 'readonly', (s) => s.getAll());
  },
  async clearOldWorks() {
    const d = await openDb();
    if (useMemory || !d.objectStoreNames.contains(OLD_STORE)) return;
    await request(d, OLD_STORE, 'readwrite', (s) => s.clear());
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
  },
};
