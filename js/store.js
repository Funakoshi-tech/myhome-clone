// store.js
// 状態管理・保存/読込・JSON 入出力。
// 唯一の正データ（plan）と、複数プランの一覧を保持する。
//
// 保存先:
// - プラン本体 … LocalStorage（下絵画像は imageRef だけを持つ）
// - 下絵画像と自動バックアップ … IndexedDB（localDb.js）
//
// 同じアプリを複数の窓で開いても、他の窓の変更を上書きで消さないように、
// 書き込む前に LocalStorage の最新を読み、自分が変更していないプランは最新側を採用する。

import { createEmptyPlan, normalizePlan, uid } from './model.js';
import * as localDb from './localDb.js';

const LS_KEY = 'myhome-clone:v1';
const UNDO_LIMIT = 50;
const BACKUP_INTERVAL_MS = 30 * 60 * 1000;
const BACKUP_KEEP_LATEST = 10;
const BACKUP_KEEP_DAYS = 14;
const IMAGE_CLEANUP_DELAY_MS = 5000;
const IMAGE_CLEANUP_MIN_AGE_MS = 24 * 60 * 60 * 1000;

// LocalStorage に保存する全体構造:
// { plans: { [id]: plan }, order: [id,...], currentId }

function readText() {
  try {
    return localStorage.getItem(LS_KEY);
  } catch (e) {
    console.warn('LocalStorage 読込失敗', e);
    return null;
  }
}

function parseSaved(txt) {
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch (e) {
    console.warn('LocalStorage 読込失敗', e);
    return null;
  }
}

/** 画像の内容から決まる id（同じ画像は1つだけ保存される） */
function imageKeyOf(dataUrl) {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < dataUrl.length; i++) {
    const c = dataUrl.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b, 33) + c) | 0;
  }
  return `img_${dataUrl.length}_${(a >>> 0).toString(36)}_${(b >>> 0).toString(36)}`;
}

/**
 * 残すバックアップ以外の savedAt を返す。
 * 新しい順に BACKUP_KEEP_LATEST 件と、直近 BACKUP_KEEP_DAYS 日の各日で最新の1件を残す。
 */
export function selectBackupsToDrop(savedAts, now = Date.now()) {
  const sorted = savedAts.slice().sort((a, b) => b - a);
  const keep = new Set(sorted.slice(0, BACKUP_KEEP_LATEST));
  const seenDays = new Set();
  const oldest = now - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const t of sorted) {
    if (t < oldest) break;
    const d = new Date(t);
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (!seenDays.has(day)) {
      seenDays.add(day);
      keep.add(t);
    }
  }
  return sorted.filter((t) => !keep.has(t));
}

export class Store {
  /** @param {{ images?: Map<string,string>, db?: typeof localDb }} [deps] */
  constructor({ images = new Map(), db = localDb } = {}) {
    this._listeners = new Set();
    this.plans = {};   // id -> plan
    this.order = [];   // 表示順
    this.currentId = null;
    this._undo = {};   // planId -> string[]
    this._redo = {};   // planId -> string[]
    this._applyingHistory = false;

    this._db = db;
    this._images = images;            // 画像 id -> dataUrl（IndexedDB に保存済みのもの）
    this._imageKeys = new Map();      // dataUrl -> 画像 id（計算の省略用）
    this._savingImages = new Set();   // IndexedDB へ書き込み中の画像 id
    this._failedImages = new Set();   // IndexedDB へ書けなかった画像 id（LocalStorage に直接持つ）
    this._fetchingImages = new Set();

    this._lastSavedText = null;       // この窓が最後に読み書きした LocalStorage の内容
    this._dirtyIds = new Set();       // この窓で変更し、まだ保存できていないプラン
    this._removedIds = new Set();     // この窓で削除し、まだ保存できていないプラン
    this._orderDirty = false;

    this._lastBackupAt = 0;
    this._lastBackupText = null;

    /** @type {null | Error} 直近の保存に失敗していればそのエラー */
    this.saveError = null;
    /** @type {null | ((err: Error|null) => void)} */
    this.onSaveErrorChange = null;

    this._init();
  }

  _init() {
    const txt = readText();
    const raw = parseSaved(txt);
    if (raw && raw.order && raw.order.length) {
      this.order = raw.order.slice();
      this.plans = {};
      for (const id of this.order) {
        if (raw.plans[id]) this.plans[id] = this._planFromSaved(raw.plans[id]);
      }
      this.currentId = raw.currentId && this.plans[raw.currentId]
        ? raw.currentId
        : this.order[0];
      this._lastSavedText = txt;
    } else {
      // 初回: サンプル空プランを1つ作る
      const id = uid('plan');
      this.plans[id] = createEmptyPlan('マイプラン1');
      this.order = [id];
      this.currentId = id;
      this._persist({ touched: [id] });
    }
  }

  // ---- 購読 -----------------------------------------------------------------
  subscribe(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  notify() {
    for (const fn of this._listeners) fn(this);
  }

  // ---- 永続化 ---------------------------------------------------------------

  /** 保存データのプランに下絵画像を戻して正規化する */
  _planFromSaved(saved) {
    const bg = saved?.site?.backgroundImage;
    if (bg?.imageRef && !bg.dataUrl) {
      const dataUrl = this._images.get(bg.imageRef);
      if (dataUrl) {
        bg.dataUrl = dataUrl;
        delete bg.imageRef;
      } else {
        this._fetchMissingImage(bg.imageRef);
      }
    }
    return normalizePlan(saved);
  }

  /** 他の窓が保存した画像など、手元にない画像を読み込んで反映する */
  _fetchMissingImage(id) {
    if (this._fetchingImages.has(id)) return;
    this._fetchingImages.add(id);
    this._db.getImage(id).then((dataUrl) => {
      this._fetchingImages.delete(id);
      if (!dataUrl) return;
      this._images.set(id, dataUrl);
      let changed = false;
      for (const plan of Object.values(this.plans)) {
        const bg = plan.site?.backgroundImage;
        if (bg?.imageRef === id && !bg.dataUrl) {
          bg.dataUrl = dataUrl;
          delete bg.imageRef;
          changed = true;
        }
      }
      if (changed) this.notify();
    });
  }

  _imageKeyFor(dataUrl) {
    let key = this._imageKeys.get(dataUrl);
    if (!key) {
      key = imageKeyOf(dataUrl);
      this._imageKeys.set(dataUrl, key);
    }
    return key;
  }

  /** 画像を IndexedDB へ保存する。保存が確認できてから LocalStorage 側を参照に置き換える */
  _queueImageSave(id, dataUrl) {
    if (this._savingImages.has(id) || this._failedImages.has(id)) return;
    this._savingImages.add(id);
    this._db.putImage(id, dataUrl).then((ok) => {
      this._savingImages.delete(id);
      if (ok) this._images.set(id, dataUrl);
      else this._failedImages.add(id);
      this._persist();
    });
  }

  _serialize() {
    const data = { plans: this.plans, order: this.order, currentId: this.currentId };
    return JSON.stringify(data, (key, value) => {
      if (key !== 'backgroundImage' || !value?.dataUrl) return value;
      const id = this._imageKeyFor(value.dataUrl);
      if (this._images.has(id)) {
        return { ...value, dataUrl: undefined, imageRef: id }; // undefined は JSON に出力されない
      }
      this._queueImageSave(id, value.dataUrl);
      return value;
    });
  }

  /**
   * 他の窓が保存した内容を取り込む。
   * @param {{ protectCurrent?: boolean }} [opts] protectCurrent: 編集中のプランは置き換えない
   * @returns {boolean} 手元のデータが変わったら true
   */
  _mergeExternalChanges({ protectCurrent = false } = {}) {
    const txt = readText();
    if (txt === null || txt === this._lastSavedText) return false;
    const raw = parseSaved(txt);
    if (!raw?.order || !raw.plans) return false;

    let changed = false;
    let skipped = false;

    for (const id of raw.order) {
      const saved = raw.plans[id];
      if (!saved || this._removedIds.has(id) || this._dirtyIds.has(id)) continue;
      const mine = this.plans[id];
      if (mine && (saved.meta?.updatedAt || 0) <= (mine.meta?.updatedAt || 0)) continue;
      if (protectCurrent && id === this.currentId) {
        skipped = true;
        continue;
      }
      this.plans[id] = this._planFromSaved(saved);
      delete this._undo[id];
      delete this._redo[id];
      changed = true;
    }

    // 他の窓で削除されたプラン（表示中のものは残す）
    for (const id of Object.keys(this.plans)) {
      if (raw.plans[id] || this._dirtyIds.has(id) || id === this.currentId) continue;
      delete this.plans[id];
      changed = true;
    }

    const exists = (id) => !!this.plans[id];
    const savedOrder = raw.order.filter(exists);
    const localOnly = this.order.filter((id) => exists(id) && !savedOrder.includes(id));
    const remoteOnly = savedOrder.filter((id) => !this.order.includes(id));
    const nextOrder = this._orderDirty
      ? [...remoteOnly, ...this.order.filter(exists)]
      : [...localOnly, ...savedOrder];
    if (nextOrder.join() !== this.order.join()) {
      this.order = nextOrder;
      changed = true;
    }

    if (!skipped) this._lastSavedText = txt;
    return changed;
  }

  /** @param {{ touched?: string[], removed?: string[], orderChanged?: boolean }} [change] この窓で変更した内容 */
  _persist({ touched = [], removed = [], orderChanged = false } = {}) {
    touched.forEach((id) => this._dirtyIds.add(id));
    removed.forEach((id) => this._removedIds.add(id));
    if (orderChanged) this._orderDirty = true;

    this._mergeExternalChanges();
    const text = this._serialize();
    try {
      localStorage.setItem(LS_KEY, text);
      this._lastSavedText = text;
      this._dirtyIds.clear();
      this._removedIds.clear();
      this._orderDirty = false;
      this._setSaveError(null);
      this._maybeBackup(text);
    } catch (e) {
      console.warn('LocalStorage 保存失敗', e);
      // 画像の移動が終われば容量が空くので、その間は警告しない
      if (!this._savingImages.size) this._setSaveError(e);
    }
  }

  _setSaveError(err) {
    if (!!err === !!this.saveError) {
      this.saveError = err;
      return;
    }
    this.saveError = err;
    this.onSaveErrorChange?.(err);
  }

  // ---- 自動バックアップ -----------------------------------------------------

  _maybeBackup(text, { force = false } = {}) {
    if (!text || text === this._lastBackupText) return;
    const now = Date.now();
    if (!force && now - this._lastBackupAt < BACKUP_INTERVAL_MS) return;
    this._lastBackupAt = now;
    this._lastBackupText = text;
    this._db.addBackup({ savedAt: now, text }).then(() => this._pruneBackups());
  }

  async _pruneBackups() {
    const rows = await this._db.listBackups();
    const drop = selectBackupsToDrop(rows.map((r) => r.savedAt));
    if (drop.length) await this._db.deleteBackups(drop);
  }

  /** 起動時の1回: 前回と内容が変わっていればバックアップを取り、不要な画像を片付ける */
  async _backupAtStartup() {
    const [latest] = await this._db.listBackups();
    if (latest) {
      this._lastBackupAt = latest.savedAt;
      this._lastBackupText = latest.text;
    }
    this._maybeBackup(this._lastSavedText);
  }

  async _cleanupImages() {
    const texts = [readText() || '', ...(await this._db.listBackups()).map((b) => b.text)];
    const used = new Set();
    for (const text of texts) {
      for (const m of text.matchAll(/"imageRef":"([^"]+)"/g)) used.add(m[1]);
    }
    for (const plan of Object.values(this.plans)) {
      const url = plan.site?.backgroundImage?.dataUrl;
      if (url) used.add(this._imageKeyFor(url));
    }
    const limit = Date.now() - IMAGE_CLEANUP_MIN_AGE_MS;
    const unused = (await this._db.listImageMeta())
      .filter((m) => !used.has(m.id) && m.savedAt < limit)
      .map((m) => m.id);
    if (unused.length) await this._db.deleteImages(unused);
  }

  /** @returns {Promise<Array<{savedAt:number, plans:Array<{id:string,name:string,updatedAt:number}>}>>} 新しい順 */
  async listBackups() {
    const rows = await this._db.listBackups();
    const out = [];
    for (const row of rows) {
      const raw = parseSaved(row.text);
      if (!raw?.order || !raw.plans) continue;
      out.push({
        savedAt: row.savedAt,
        plans: raw.order.filter((id) => raw.plans[id]).map((id) => ({
          id,
          name: raw.plans[id].meta?.name || '無題',
          updatedAt: raw.plans[id].meta?.updatedAt || 0,
        })),
      });
    }
    return out;
  }

  /** バックアップのプランを新しいプランとして一覧の先頭に追加する（既存のプランは変更しない） */
  async restorePlanFromBackup(savedAt, planId) {
    const rows = await this._db.listBackups();
    const raw = parseSaved(rows.find((r) => r.savedAt === savedAt)?.text);
    const saved = raw?.plans?.[planId];
    if (!saved) return null;
    const ref = saved.site?.backgroundImage?.imageRef;
    if (ref && !this._images.has(ref)) {
      const dataUrl = await this._db.getImage(ref);
      if (dataUrl) this._images.set(ref, dataUrl);
    }
    const plan = this._planFromSaved(saved);
    plan.meta.name = `${plan.meta.name || '無題'}（復元）`;
    this._touchUpdated(plan);
    const id = uid('plan');
    this.plans[id] = plan;
    this.order.unshift(id);
    this._persist({ touched: [id] });
    this.notify();
    return id;
  }

  /** 他の窓の変更を受け取り、この窓の表示に反映する */
  syncFromOtherWindows({ protectCurrent = false } = {}) {
    if (this._mergeExternalChanges({ protectCurrent })) this.notify();
  }

  /** 窓間の同期・バックアップなど、ブラウザでだけ行う処理を始める */
  startBackgroundTasks() {
    if (typeof window === 'undefined') return;
    window.addEventListener('storage', (e) => {
      if (e.key === LS_KEY || e.key === null) {
        // 操作中の窓では編集中のプランを差し替えない（ドラッグ等の途中で壊さないため）
        this.syncFromOtherWindows({ protectCurrent: document.hasFocus() });
      }
    });
    // 裏で止まっていた窓は storage イベントを取りこぼすことがある
    window.addEventListener('focus', () => this.syncFromOtherWindows());
    navigator.storage?.persist?.().catch(() => {});
    this._backupAtStartup();
    setTimeout(() => this._cleanupImages(), IMAGE_CLEANUP_DELAY_MS);
  }

  _touchUpdated(plan) {
    if (plan?.meta) plan.meta.updatedAt = Date.now();
  }

  _pushUndoSnapshot() {
    const id = this.currentId;
    const plan = this.current();
    if (!id || !plan) return;
    if (!this._undo[id]) this._undo[id] = [];
    if (!this._redo[id]) this._redo[id] = [];
    this._undo[id].push(JSON.stringify(plan));
    if (this._undo[id].length > UNDO_LIMIT) this._undo[id].shift();
    this._redo[id] = [];
  }

  _applyPlanSnapshot(json) {
    const id = this.currentId;
    if (!id || !json) return false;
    this.plans[id] = normalizePlan(JSON.parse(json));
    this._persist({ touched: [id] });
    this.notify();
    return true;
  }

  canUndo() {
    return (this._undo[this.currentId]?.length || 0) > 0;
  }

  canRedo() {
    return (this._redo[this.currentId]?.length || 0) > 0;
  }

  undo() {
    const id = this.currentId;
    const stack = this._undo[id];
    if (!stack?.length) return false;
    const cur = this.plans[id];
    if (cur) {
      if (!this._redo[id]) this._redo[id] = [];
      this._redo[id].push(JSON.stringify(cur));
    }
    this._applyingHistory = true;
    const ok = this._applyPlanSnapshot(stack.pop());
    this._applyingHistory = false;
    return ok;
  }

  redo() {
    const id = this.currentId;
    const stack = this._redo[id];
    if (!stack?.length) return false;
    const cur = this.plans[id];
    if (cur) {
      if (!this._undo[id]) this._undo[id] = [];
      this._undo[id].push(JSON.stringify(cur));
    }
    this._applyingHistory = true;
    const ok = this._applyPlanSnapshot(stack.pop());
    this._applyingHistory = false;
    return ok;
  }

  // 変更を加えて保存＋通知（mutator は current plan を受け取る）
  update(mutator, opts = {}) {
    const { skipHistory = false } = opts;
    if (!skipHistory && !this._applyingHistory) this._pushUndoSnapshot();
    const plan = this.current();
    if (plan) {
      mutator(plan);
      this._touchUpdated(plan);
    }
    this._persist({ touched: plan ? [this.currentId] : [] });
    this.notify();
  }

  // 保存のみ（描画ループ中の頻繁な保存抑制用に分離）
  save() {
    this._persist({ touched: this.current() ? [this.currentId] : [] });
  }

  // ---- プラン参照 -----------------------------------------------------------
  current() {
    return this.plans[this.currentId] || null;
  }

  list() {
    return this.order.map((id) => ({ id, name: this.plans[id]?.meta?.name || '(無題)' }));
  }

  select(id) {
    if (this.plans[id]) {
      this.currentId = id;
      this._persist();
      this.notify();
    }
  }

  // ---- プラン操作 -----------------------------------------------------------
  newPlan(name = `マイプラン${this.order.length + 1}`) {
    const id = uid('plan');
    this.plans[id] = createEmptyPlan(name);
    this.order.unshift(id); // 新しいプランは一覧の先頭に
    this.currentId = id;
    this._persist({ touched: [id] });
    this.notify();
    return id;
  }

  duplicatePlan(id = this.currentId) {
    const src = this.plans[id];
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.meta.name = `${src.meta.name} のコピー`;
    this._touchUpdated(copy);
    const newId = uid('plan');
    this.plans[newId] = copy;
    const idx = this.order.indexOf(id);
    this.order.splice(idx + 1, 0, newId);
    this.currentId = newId;
    this._persist({ touched: [newId] });
    this.notify();
    return newId;
  }

  deletePlan(id = this.currentId) {
    this._mergeExternalChanges(); // 他の窓で増えたプランを数えてから判断する
    this._maybeBackup(this._lastSavedText, { force: true }); // 誤って消しても戻せるように
    if (this.order.length <= 1) {
      // 最後の1つは消さず、空にして残す
      this.plans[id] = createEmptyPlan('マイプラン1');
      this._persist({ touched: [id] });
      this.notify();
      return;
    }
    delete this.plans[id];
    const idx = this.order.indexOf(id);
    this.order.splice(idx, 1);
    if (this.currentId === id) {
      this.currentId = this.order[Math.max(0, idx - 1)];
    }
    this._persist({ removed: [id] });
    this.notify();
  }

  renamePlan(name, id = this.currentId) {
    if (this.plans[id]) {
      this.plans[id].meta.name = name;
      this._touchUpdated(this.plans[id]);
      this._persist({ touched: [id] });
      this.notify();
    }
  }

  /** プランの meta を部分更新（メモ・建蔽率/容積率の上限など。元に戻すの対象外） */
  updatePlanMeta(patch, id = this.currentId) {
    if (this.plans[id]) {
      Object.assign(this.plans[id].meta, patch);
      this._touchUpdated(this.plans[id]);
      this._persist({ touched: [id] });
      this.notify();
    }
  }

  /** プラン一覧の表示順を更新（id の配列） */
  setOrder(ids) {
    const valid = ids.filter((id) => this.plans[id]);
    const rest = this.order.filter((id) => !valid.includes(id));
    this.order = [...valid, ...rest];
    this._persist({ orderChanged: true });
    this.notify();
  }

  /** 一覧から複製（編集中プランを切り替えない） */
  duplicatePlanAt(id) {
    const src = this.plans[id];
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.meta.name = `${src.meta.name} のコピー`;
    this._touchUpdated(copy);
    const newId = uid('plan');
    this.plans[newId] = copy;
    const idx = this.order.indexOf(id);
    this.order.splice(idx + 1, 0, newId);
    this._persist({ touched: [newId] });
    this.notify();
    return newId;
  }

  // ---- JSON 入出力 ----------------------------------------------------------
  exportCurrentJSON() {
    const plan = this.current();
    if (!plan) return;
    const json = JSON.stringify(plan, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = (plan.meta.name || 'plan').replace(/[\\/:*?"<>|]/g, '_');
    a.href = url;
    a.download = `${safe}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // インポートした JSON を新規プランとして取り込む
  importJSON(obj) {
    const plan = normalizePlan(obj);
    const id = uid('plan');
    this.plans[id] = plan;
    this.order.unshift(id); // 新規作成と同じく一覧の先頭に
    this.currentId = id;
    this._persist({ touched: [id] });
    this.notify();
    return id;
  }
}

export const store = new Store({ images: await localDb.loadAllImages() });
store.startBackgroundTasks();
