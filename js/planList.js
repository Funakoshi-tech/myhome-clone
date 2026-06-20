// planList.js — プラン一覧画面

import * as M from './model.js';
import { renderPlanThumbnail, renderPlanFloorThumbnails } from './planThumbnail.js';
import { showPrompt, showConfirm } from './dialog.js';

function formatRelativeTime(ts) {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}日前`;
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export class PlanList {
  /**
   * @param {import('./store.js').Store} store
   * @param {{ onOpen: (id: string) => void }} callbacks
   */
  constructor(store, callbacks) {
    this.store = store;
    this.onOpen = callbacks.onOpen;
    this.searchQuery = '';
    this.sortKey = 'order-manual';
    this._drag = null;

    this.root = document.getElementById('plan-list-screen');
    this.grid = document.getElementById('plan-list-grid');
    this.countEl = document.getElementById('plan-list-count');
    this.searchInput = document.getElementById('plan-list-search');
    this.sortSelect = document.getElementById('plan-list-sort');
    this.newBtn = document.getElementById('plan-list-new');
    this.expandedFloorIds = new Set();

    this._wire();
    this._wireDrag();
    this.store.subscribe(() => {
      if (this._drag) return;
      this.render();
    });
  }

  _wire() {
    this.newBtn?.addEventListener('click', () => {
      this._createPlan();
    });

    this.searchInput?.addEventListener('input', () => {
      this.searchQuery = this.searchInput.value.trim();
      this.render();
    });

    this.sortSelect?.addEventListener('change', () => {
      this.sortKey = this.sortSelect.value;
      this.render();
    });

    document.getElementById('plan-list-brand')?.addEventListener('click', () => this.render());

    document.addEventListener('click', (e) => {
      if (e.target.closest('.plan-card-menu-btn') || e.target.closest('.plan-card-actions')) return;
      this._closeMenus();
    });
  }

  _sortedIds() {
    const ids = this.store.order.slice();
    const q = this.searchQuery.toLowerCase();
    const filtered = q
      ? ids.filter((id) => (this.store.plans[id]?.meta?.name || '').toLowerCase().includes(q))
      : ids;

    if (this.sortKey === 'order-manual') return filtered;

    filtered.sort((a, b) => {
      const pa = this.store.plans[a];
      const pb = this.store.plans[b];
      if (this.sortKey === 'name-asc') {
        return (pa?.meta?.name || '').localeCompare(pb?.meta?.name || '', 'ja');
      }
      if (this.sortKey === 'name-desc') {
        return (pb?.meta?.name || '').localeCompare(pa?.meta?.name || '', 'ja');
      }
      const ta = pa?.meta?.updatedAt || 0;
      const tb = pb?.meta?.updatedAt || 0;
      return this.sortKey === 'updated-asc' ? ta - tb : tb - ta;
    });
    return filtered;
  }

  render() {
    if (!this.grid) return;
    const ids = this._sortedIds();
    this.grid.innerHTML = '';

    if (this.countEl) {
      const total = this.store.order.length;
      this.countEl.textContent = ids.length === total
        ? `全 ${total} 件`
        : `${ids.length} 件 / 全 ${total} 件`;
    }

    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'plan-list-empty';
      empty.innerHTML = this.searchQuery
        ? '<p>該当するプランがありません</p>'
        : '<p>プランがありません</p><p class="plan-list-empty-hint">「+ プラン新規作成」から始めましょう</p>';
      this.grid.appendChild(empty);
      return;
    }

    for (const id of ids) {
      const card = this._buildCard(id);
      this.grid.appendChild(card);
      if (this.expandedFloorIds.has(id)) {
        this._setFloorsExpanded(card, true);
        requestAnimationFrame(() => {
          renderPlanFloorThumbnails(this.store.plans[id], card);
        });
      }
    }
  }

  _areaBlockHtml(label, areas) {
    return `
      <div class="plan-card-area">
        <span class="plan-card-area-label">${label}</span>
        <span class="plan-card-area-values">
          <b>${areas.m2}</b>㎡ /
          <b>${areas.jo}</b>畳 /
          <b>${areas.tsubo}</b>坪
        </span>
      </div>`;
  }

  _setFloorsExpanded(card, open) {
    const body = card.querySelector('.plan-card-floors-body');
    const head = card.querySelector('.plan-card-floors-head');
    if (!body || !head) return;
    card.classList.toggle('floors-open', open);
    body.hidden = !open;
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  _renderFloorCanvases(card, plan) {
    renderPlanFloorThumbnails(plan, card);
  }

  _buildCard(id) {
    const plan = this.store.plans[id];
    const stats = M.planStats(plan);
    const withGarage = stats.areasWithGarage;
    const exGarage = stats.areasExGarage;
    const card = document.createElement('article');
    card.className = 'plan-card';
    card.dataset.id = id;

    const head = document.createElement('div');
    head.className = 'plan-card-head';

    const dragHandle = document.createElement('button');
    dragHandle.type = 'button';
    dragHandle.className = 'plan-card-drag-handle';
    dragHandle.title = this._canReorder()
      ? 'ドラッグで並び替え'
      : '並び順（ドラッグ）表示時のみ並び替え可能';
    dragHandle.textContent = '⋮⋮';
    dragHandle.disabled = !this._canReorder();
    dragHandle.addEventListener('pointerdown', (e) => this._onDragStart(e, card, id));
    head.appendChild(dragHandle);

    const title = document.createElement('h3');
    title.className = 'plan-card-title';
    title.textContent = plan.meta.name || '無題';
    head.appendChild(title);

    const menuBtn = document.createElement('button');
    menuBtn.type = 'button';
    menuBtn.className = 'plan-card-menu-btn';
    menuBtn.title = '操作';
    menuBtn.textContent = '⋯';
    menuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this._toggleMenu(card, menuBtn, id);
    });
    head.appendChild(menuBtn);
    card.appendChild(head);

    const thumbWrap = document.createElement('button');
    thumbWrap.type = 'button';
    thumbWrap.className = 'plan-card-thumb';
    thumbWrap.title = '編集を開く';
    const canvas = document.createElement('canvas');
    canvas.className = 'plan-card-canvas';
    thumbWrap.appendChild(canvas);
    thumbWrap.addEventListener('click', () => this.onOpen(id));
    card.appendChild(thumbWrap);
    requestAnimationFrame(() => renderPlanThumbnail(plan, canvas));

    const meta = document.createElement('div');
    meta.className = 'plan-card-meta';
    const sizeLine = stats.widthM > 0
      ? `<div class="plan-card-line">間口: ${stats.widthM.toFixed(2)}m / 奥行: ${stats.depthM.toFixed(2)}m</div>`
      : '';
    meta.innerHTML = `
      <div class="plan-card-line">${stats.floorCount}階建 / ${stats.roomCount}部屋</div>
      ${sizeLine}
      ${this._areaBlockHtml('延床面積（ガレージ込）', withGarage)}
      ${this._areaBlockHtml('延床面積（ガレージ抜）', exGarage)}
    `;
    card.appendChild(meta);

    const floorsFold = document.createElement('div');
    floorsFold.className = 'plan-card-floors-fold';
    floorsFold.innerHTML = `
      <button type="button" class="plan-card-floors-head" aria-expanded="false">
        <span>各階表示</span>
        <span class="plan-card-floors-icon" aria-hidden="true"></span>
      </button>
      <div class="plan-card-floors-body" hidden>
        <div class="plan-card-floor-grid">
          <figure class="plan-card-floor-item">
            <figcaption>1F</figcaption>
            <canvas class="plan-card-floor-canvas" data-floor="1F"></canvas>
          </figure>
          <figure class="plan-card-floor-item">
            <figcaption>2F</figcaption>
            <canvas class="plan-card-floor-canvas" data-floor="2F"></canvas>
          </figure>
          <figure class="plan-card-floor-item">
            <figcaption>3F</figcaption>
            <canvas class="plan-card-floor-canvas" data-floor="3F"></canvas>
          </figure>
        </div>
      </div>
    `;
    const floorsHead = floorsFold.querySelector('.plan-card-floors-head');
    floorsHead.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !card.classList.contains('floors-open');
      if (open) {
        this.expandedFloorIds.add(id);
        this._setFloorsExpanded(card, true);
        requestAnimationFrame(() => this._renderFloorCanvases(card, plan));
      } else {
        this.expandedFloorIds.delete(id);
        this._setFloorsExpanded(card, false);
      }
    });
    card.appendChild(floorsFold);

    const foot = document.createElement('div');
    foot.className = 'plan-card-foot';
    const created = plan.meta.createdAt;
    const updated = plan.meta.updatedAt;
    foot.innerHTML = `
      <div>作成 ${formatDateTime(created)}</div>
      <div>更新 ${formatRelativeTime(updated)}</div>
    `;
    card.appendChild(foot);

    const actions = document.createElement('div');
    actions.className = 'plan-card-actions';
    actions.hidden = true;
    actions.innerHTML = `
      <button type="button" data-act="open">編集</button>
      <button type="button" data-act="rename">名前変更</button>
      <button type="button" data-act="copy">コピー</button>
      <button type="button" data-act="delete" data-danger>削除</button>
    `;
    actions.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      this._closeMenus();
      this._handleAction(btn.dataset.act, id);
    });
    card.appendChild(actions);
    card._menuBtn = menuBtn;
    card._actions = actions;

    return card;
  }

  _toggleMenu(card, btn, id) {
    const open = card.classList.contains('menu-open');
    this._closeMenus();
    if (!open) {
      card.classList.add('menu-open');
      card._actions.hidden = false;
    }
  }

  _closeMenus() {
    document.querySelectorAll('.plan-card.menu-open').forEach((c) => {
      c.classList.remove('menu-open');
      if (c._actions) c._actions.hidden = true;
    });
  }

  _canReorder() {
    return this.sortKey === 'order-manual' && !this.searchQuery;
  }

  _wireDrag() {
    window.addEventListener('pointermove', (e) => this._onDragMove(e));
    window.addEventListener('pointerup', (e) => this._onDragEnd(e));
    window.addEventListener('pointercancel', (e) => this._onDragEnd(e));
  }

  _onDragStart(e, card, id) {
    if (!this._canReorder() || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    this._closeMenus();
    card.setPointerCapture(e.pointerId);
    this._drag = { id, card, pointerId: e.pointerId };
    card.classList.add('plan-card-dragging');
  }

  _findInsertBefore(clientX, clientY, dragCard) {
    const cards = [...this.grid.querySelectorAll('.plan-card')].filter((c) => c !== dragCard);
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clientY < midY) return card;
      if (clientY <= rect.bottom && clientX < rect.left + rect.width / 2) return card;
    }
    return null;
  }

  _onDragMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.pointerId) return;
    e.preventDefault();
    const before = this._findInsertBefore(e.clientX, e.clientY, d.card);
    document.querySelectorAll('.plan-card-drop-before').forEach((el) => {
      el.classList.remove('plan-card-drop-before');
    });
    if (before) before.classList.add('plan-card-drop-before');
    if (before) {
      this.grid.insertBefore(d.card, before);
    } else if (d.card.parentElement === this.grid) {
      this.grid.appendChild(d.card);
    }
  }

  _onDragEnd(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.card.classList.remove('plan-card-dragging');
    d.card.releasePointerCapture?.(e.pointerId);
    document.querySelectorAll('.plan-card-drop-before').forEach((el) => {
      el.classList.remove('plan-card-drop-before');
    });

    const ids = [...this.grid.querySelectorAll('.plan-card')].map((c) => c.dataset.id);
    this._drag = null;
    this.store.setOrder(ids);
  }

  async _createPlan() {
    const name = await showPrompt({
      title: 'プラン新規作成',
      label: 'プラン名',
      defaultValue: `マイプラン${this.store.order.length + 1}`,
    });
    if (name === null) return;
    const id = this.store.newPlan(name.trim() || '無題');
    this.onOpen(id);
  }

  async _handleAction(act, id) {
    const plan = this.store.plans[id];
    if (!plan) return;
    if (act === 'open') {
      this.onOpen(id);
      return;
    }
    if (act === 'rename') {
      const name = await showPrompt({
        title: 'プラン名を変更',
        label: 'プラン名',
        defaultValue: plan.meta.name || '',
      });
      if (name === null) return;
      const trimmed = name.trim();
      if (trimmed) this.store.renamePlan(trimmed, id);
      return;
    }
    if (act === 'copy') {
      this.store.duplicatePlanAt(id);
      return;
    }
    if (act === 'delete') {
      const label = plan.meta.name || 'このプラン';
      const ok = await showConfirm({
        title: 'プランを削除',
        message: `「${label}」を削除しますか？`,
        okText: '削除',
        danger: true,
      });
      if (!ok) return;
      this.store.deletePlan(id);
    }
  }

  show() {
    this.root?.removeAttribute('hidden');
    document.body.classList.add('plan-list-mode');
    this._closeMenus();
    this.render();
  }

  hide() {
    this.root?.setAttribute('hidden', '');
    document.body.classList.remove('plan-list-mode');
    this._closeMenus();
  }
}
