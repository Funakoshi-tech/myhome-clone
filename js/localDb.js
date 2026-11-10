// localDb.js — IndexedDB の薄いラッパー。
// 容量の大きい下絵画像と、自動バックアップを保存する。
// IndexedDB が使えない環境では何もせず、呼び出し側は従来どおり LocalStorage だけで動く。

const DB_NAME = 'myhome-clone-db';
const DB_VERSION = 1;
const IMAGES = 'images';
const BACKUPS = 'backups';
const OPEN_TIMEOUT_MS = 3000; // 開けないまま起動が止まらないようにする

let _dbPromise = null;

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const timer = setTimeout(() => resolve(null), OPEN_TIMEOUT_MS);
    const done = (db) => { clearTimeout(timer); resolve(db); };
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(BACKUPS)) db.createObjectStore(BACKUPS, { keyPath: 'savedAt' });
      };
      req.onsuccess = () => done(req.result);
      req.onerror = () => done(null);
      req.onblocked = () => done(null);
    } catch (_e) {
      done(null);
    }
  });
  return _dbPromise;
}

/** 1 トランザクションを実行し、完了時に work の戻り値（IDBRequest なら result）を返す。失敗は fallback */
async function run(storeName, mode, work, fallback) {
  const db = await openDb();
  if (!db) return fallback;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(storeName, mode);
      const out = work(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : (out ?? true));
      tx.onerror = () => resolve(fallback);
      tx.onabort = () => resolve(fallback);
    } catch (_e) {
      resolve(fallback);
    }
  });
}

/** @returns {Promise<Map<string, string>>} 画像 id → dataUrl */
export async function loadAllImages() {
  const rows = await run(IMAGES, 'readonly', (s) => s.getAll(), []);
  return new Map(rows.map((r) => [r.id, r.dataUrl]));
}

export async function getImage(id) {
  const row = await run(IMAGES, 'readonly', (s) => s.get(id), null);
  return row?.dataUrl ?? null;
}

/** @returns {Promise<boolean>} 保存できたら true */
export function putImage(id, dataUrl) {
  return run(IMAGES, 'readwrite', (s) => { s.put({ id, dataUrl, savedAt: Date.now() }); }, false);
}

/** 画像の id と保存時刻の一覧（本体は読まない） */
export async function listImageMeta() {
  const rows = await run(IMAGES, 'readonly', (s) => s.getAll(), []);
  return rows.map((r) => ({ id: r.id, savedAt: r.savedAt || 0 }));
}

export function deleteImages(ids) {
  return run(IMAGES, 'readwrite', (s) => { ids.forEach((id) => s.delete(id)); }, false);
}

export function addBackup(backup) {
  return run(BACKUPS, 'readwrite', (s) => { s.put(backup); }, false);
}

/** @returns {Promise<Array<{savedAt:number, text:string}>>} 新しい順 */
export async function listBackups() {
  const rows = await run(BACKUPS, 'readonly', (s) => s.getAll(), []);
  return rows.sort((a, b) => b.savedAt - a.savedAt);
}

export function deleteBackups(savedAts) {
  return run(BACKUPS, 'readwrite', (s) => { savedAts.forEach((t) => s.delete(t)); }, false);
}
