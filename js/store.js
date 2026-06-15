// store.js
// 状態管理・LocalStorage 保存/読込・JSON 入出力。
// 唯一の正データ（plan）と、複数プランの一覧を保持する。

import { createEmptyPlan, normalizePlan, uid } from './model.js';

const LS_KEY = 'myhome-clone:v1';

// LocalStorage に保存する全体構造:
// { plans: { [id]: plan }, order: [id,...], currentId }

function loadRaw() {
  try {
    const txt = localStorage.getItem(LS_KEY);
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (e) {
    console.warn('LocalStorage 読込失敗', e);
    return null;
  }
}

export class Store {
  constructor() {
    this._listeners = new Set();
    this.plans = {};   // id -> plan
    this.order = [];   // 表示順
    this.currentId = null;
    this._init();
  }

  _init() {
    const raw = loadRaw();
    if (raw && raw.order && raw.order.length) {
      this.order = raw.order.slice();
      this.plans = {};
      for (const id of this.order) {
        if (raw.plans[id]) this.plans[id] = normalizePlan(raw.plans[id]);
      }
      this.currentId = raw.currentId && this.plans[raw.currentId]
        ? raw.currentId
        : this.order[0];
    } else {
      // 初回: サンプル空プランを1つ作る
      const id = uid('plan');
      this.plans[id] = createEmptyPlan('マイプラン1');
      this.order = [id];
      this.currentId = id;
      this._persist();
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
  _persist() {
    const data = { plans: this.plans, order: this.order, currentId: this.currentId };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('LocalStorage 保存失敗', e);
    }
  }

  // 変更を加えて保存＋通知（mutator は current plan を受け取る）
  update(mutator) {
    const plan = this.current();
    if (plan) mutator(plan);
    this._persist();
    this.notify();
  }

  // 保存のみ（描画ループ中の頻繁な保存抑制用に分離）
  save() {
    this._persist();
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
    this.order.push(id);
    this.currentId = id;
    this._persist();
    this.notify();
    return id;
  }

  duplicatePlan(id = this.currentId) {
    const src = this.plans[id];
    if (!src) return null;
    const copy = JSON.parse(JSON.stringify(src));
    copy.meta.name = `${src.meta.name} のコピー`;
    const newId = uid('plan');
    this.plans[newId] = copy;
    const idx = this.order.indexOf(id);
    this.order.splice(idx + 1, 0, newId);
    this.currentId = newId;
    this._persist();
    this.notify();
    return newId;
  }

  deletePlan(id = this.currentId) {
    if (this.order.length <= 1) {
      // 最後の1つは消さず、空にして残す
      this.plans[id] = createEmptyPlan('マイプラン1');
      this._persist();
      this.notify();
      return;
    }
    delete this.plans[id];
    const idx = this.order.indexOf(id);
    this.order.splice(idx, 1);
    if (this.currentId === id) {
      this.currentId = this.order[Math.max(0, idx - 1)];
    }
    this._persist();
    this.notify();
  }

  renamePlan(name, id = this.currentId) {
    if (this.plans[id]) {
      this.plans[id].meta.name = name;
      this._persist();
      this.notify();
    }
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
    this.order.push(id);
    this.currentId = id;
    this._persist();
    this.notify();
    return id;
  }
}

export const store = new Store();
