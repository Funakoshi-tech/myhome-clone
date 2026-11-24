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

const FOLDER_KEY = 'myhome-clone:list-folder';

/** 前回開いていたフォルダ（null = すべて, '' = 未分類） */
function loadFolderFilter() {
  try {
    const v = localStorage.getItem(FOLDER_KEY);
    return v === null ? null : JSON.parse(v);
  } catch {
    return null;
  }
}

function saveFolderFilter(v) {
  try {
    if (v === null) localStorage.removeItem(FOLDER_KEY);
    else localStorage.setItem(FOLDER_KEY, JSON.stringify(v));
  } catch {
    // 保存できなくても表示には影響しない
  }
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
    this.sortKey = 'updated-desc';
    this._drag = null;
    /** 表示中のフォルダ。null = すべて, '' = 未分類, 文字列 = そのフォルダ */
    this.folderFilter = loadFolderFilter();
    /** 作ったばかりでまだプランが入っていないフォルダ（保存はしない） */
    this._emptyFolders = new Set();

    this.root = document.getElementById('plan-list-screen');
    this.grid = document.getElementById('plan-list-grid');
    this.countEl = document.getElementById('plan-list-count');
    this.searchInput = document.getElementById('plan-list-search');
    this.sortSelect = document.getElementById('plan-list-sort');
    this.newBtn = document.getElementById('plan-list-new');
    this.foldersEl = document.getElementById('plan-list-folders');
    this.expandedFloorIds = new Set();
    this.expandedMemoIds = new Set();
    /** プラン id → { card, sig }。表示内容が前回と同じカードは作り直さずに使い回す */
    this._cards = new Map();
    /** plan → { updatedAt, data }。一覧の表示中だけ使う（show() で捨てる） */
    this._planData = new WeakMap();
    /** プラン id → 描画済みのサムネイル canvas。カードを作り直しても間取りが同じなら使い回す */
    this._thumbCanvases = new Map();
    this._thumbObserver = typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver((entries) => this._onThumbsVisible(entries), { rootMargin: '400px 0px' });

    this._wire();
    this._wireDrag();
    this.store.subscribe(() => {
      // 編集画面にいる間は作り直さない（一覧に戻ったときに show() で描画する）
      if (this._drag || this.root?.hidden) return;
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

    document.getElementById('plan-list-backup')?.addEventListener('click', () => this._openBackups());
    document.getElementById('backup-close')?.addEventListener('click', () => {
      document.getElementById('backup-modal').hidden = true;
    });

    document.addEventListener('click', (e) => {
      if (e.target.closest('.plan-card-menu-btn') || e.target.closest('.plan-card-actions')) return;
      this._closeMenus();
    });
  }

  /** プランの入ったフォルダと、作ったばかりの空のフォルダ */
  _allFolders() {
    const used = this.store.folders();
    for (const f of used) this._emptyFolders.delete(f);
    return [...used, ...this._emptyFolders].sort((a, b) => a.localeCompare(b, 'ja'));
  }

  _inFolder(id, folder) {
    if (folder === null) return true;
    return (this.store.plans[id]?.meta?.folder || '') === folder;
  }

  _setFolderFilter(folder) {
    this.folderFilter = folder;
    saveFolderFilter(folder);
    this.render();
  }

  /** フォルダの切り替えボタン（すべて / 未分類 / 各フォルダ / + フォルダ）と、選択中フォルダの操作 */
  _renderFolders() {
    const el = this.foldersEl;
    if (!el) return;
    const folders = this._allFolders();
    if (this.folderFilter && !folders.includes(this.folderFilter)) {
      this.folderFilter = null;
      saveFolderFilter(null);
    }
    const count = (f) => this.store.order.filter((id) => this.store.plans[id] && this._inFolder(id, f)).length;
    const chip = (label, folder, n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'plan-folder-chip';
      b.setAttribute('role', 'tab');
      const active = this.folderFilter === folder;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', active ? 'true' : 'false');
      if (folder) b.prepend('📁 ');
      b.append(label);
      const c = document.createElement('span');
      c.className = 'plan-folder-chip-count';
      c.textContent = String(n);
      b.appendChild(c);
      b.addEventListener('click', () => this._setFolderFilter(folder));
      return b;
    };
    const items = [chip('すべて', null, count(null))];
    const unsorted = count('');
    if (folders.length || unsorted !== this.store.order.length) items.push(chip('未分類', '', unsorted));
    for (const f of folders) items.push(chip(f, f, count(f)));

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'plan-folder-add';
    add.textContent = '+ フォルダ';
    add.title = '新しいフォルダを作る（同じ土地のプランをまとめる）';
    add.addEventListener('click', () => this._createFolder());
    items.push(add);

    if (this.folderFilter) {
      const tools = document.createElement('span');
      tools.className = 'plan-folder-tools';
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'btn';
      rename.textContent = 'フォルダ名を変更';
      rename.addEventListener('click', () => this._renameFolder(this.folderFilter));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn';
      remove.textContent = 'フォルダを解除';
      remove.title = 'フォルダをなくし、中のプランを未分類に戻す（プランは消えません）';
      remove.addEventListener('click', () => this._removeFolder(this.folderFilter));
      tools.append(rename, remove);
      items.push(tools);
    }
    el.replaceChildren(...items);
  }

  async _createFolder() {
    const name = await showPrompt({ title: '新しいフォルダ', label: 'フォルダ名（例: 赤塚の土地）', defaultValue: '' });
    const trimmed = name?.trim();
    if (!trimmed) return;
    if (!this.store.folders().includes(trimmed)) this._emptyFolders.add(trimmed);
    this._setFolderFilter(trimmed);
  }

  async _renameFolder(oldName) {
    const name = await showPrompt({ title: 'フォルダ名を変更', label: 'フォルダ名', defaultValue: oldName });
    const trimmed = name?.trim();
    if (!trimmed || trimmed === oldName) return;
    if (this._emptyFolders.delete(oldName)) this._emptyFolders.add(trimmed);
    this.folderFilter = trimmed;
    saveFolderFilter(trimmed);
    this.store.renameFolder(oldName, trimmed);
    this.render();
  }

  async _removeFolder(name) {
    const n = this.store.order.filter((id) => this._inFolder(id, name)).length;
    if (n) {
      const ok = await showConfirm({
        title: 'フォルダを解除',
        message: `「${name}」を解除し、中の ${n} 件のプランを未分類に戻しますか？（プランは削除されません）`,
        okText: '解除',
      });
      if (!ok) return;
    }
    this._emptyFolders.delete(name);
    this.folderFilter = null;
    saveFolderFilter(null);
    this.store.renameFolder(name, '');
    this.render();
  }

  async _moveToFolder(id) {
    const plan = this.store.plans[id];
    if (!plan) return;
    const folders = this._allFolders();
    const current = plan.meta.folder || '';
    const name = await showPrompt({
      title: 'フォルダへ移動',
      label: folders.length
        ? 'または新しいフォルダ名を入力して「移動」'
        : '新しいフォルダ名を入力して「移動」（空欄で未分類）',
      defaultValue: '',
      choices: folders.length
        ? [
          ...folders.map((f) => ({ label: `📁 ${f}`, value: f, active: f === current })),
          { label: '未分類', value: '', active: current === '' },
        ]
        : [],
      okText: '移動',
    });
    if (name === null) return;
    this.store.setPlansFolder([id], name);
  }

  _sortedIds() {
    const ids = this.store.order.filter((id) => this._inFolder(id, this.folderFilter));
    const q = this.searchQuery.toLowerCase();
    const filtered = q
      ? ids.filter((id) => {
        const meta = this.store.plans[id]?.meta;
        return `${meta?.name || ''}\n${meta?.memo || ''}`.toLowerCase().includes(q);
      })
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
    this._renderFolders();
    const ids = this._sortedIds();
    const prevCards = this._cards;
    const prevThumbs = this._thumbCanvases;
    this._cards = new Map();
    this._thumbCanvases = new Map();

    if (this.countEl) {
      const total = this.store.order.filter((id) => this._inFolder(id, this.folderFilter)).length;
      this.countEl.textContent = ids.length === total
        ? `全 ${total} 件`
        : `${ids.length} 件 / 全 ${total} 件`;
    }

    if (!ids.length) {
      const empty = document.createElement('div');
      empty.className = 'plan-list-empty';
      empty.innerHTML = this.searchQuery
        ? '<p>該当するプランがありません</p>'
        : this.folderFilter
          ? '<p>このフォルダにはまだプランがありません</p><p class="plan-list-empty-hint">「+ プラン新規作成」でこのフォルダに作るか、他のプランのメニュー「フォルダへ移動」で入れてください</p>'
          : '<p>プランがありません</p><p class="plan-list-empty-hint">「+ プラン新規作成」から始めましょう</p>';
      this.grid.replaceChildren(empty);
      this._dropUnusedThumbs(prevThumbs);
      return;
    }

    const cards = ids.map((id) => {
      const plan = this.store.plans[id];
      const sig = this._cardSig(id, plan);
      const prev = prevCards.get(id);
      if (prev?.sig === sig) {
        this._cards.set(id, prev);
        const canvas = prev.card.querySelector('.plan-card-canvas');
        if (canvas) {
          canvas._thumbPlan = plan;
          this._thumbCanvases.set(id, canvas);
        }
        return prev.card;
      }
      const card = this._buildCard(id, prevThumbs.get(id));
      this._cards.set(id, { card, sig });
      if (this.expandedFloorIds.has(id)) {
        this._setFloorsExpanded(card, true);
        requestAnimationFrame(() => {
          renderPlanFloorThumbnails(this.store.plans[id], card);
        });
      }
      return card;
    });
    this._placeCards(cards);
    this._dropUnusedThumbs(prevThumbs);
  }

  /**
   * カードの表示内容を決めるもの。これが前回と同じならカードを作り直さない。
   * 下絵画像は一覧に出さないので含めない（大きい上に、編集画面で読み込まれると変わるため）
   */
  _cardSig(id, plan) {
    return [
      this._planDataOf(plan),
      formatRelativeTime(plan.meta?.updatedAt), // 「〇分前」の表示も変わったら作り直す
      this._canReorder(),
      this.expandedMemoIds.has(id),
      this.folderFilter === null ? plan.meta?.folder || '' : '',
    ].join('\n');
  }

  /**
   * プランの内容を文字列にしたもの（全プラン分で十数 ms かかるので、表示中は使い回す）。
   * 一覧の表示中の変更は updatePlanMeta などで updatedAt が変わるか、プランごと置き換わる。
   * 編集画面では updatedAt を変えずに直接書き換えることもあるので、一覧に戻るたびに作り直す（show）
   */
  _planDataOf(plan) {
    const updatedAt = plan.meta?.updatedAt;
    const cached = this._planData.get(plan);
    if (cached?.updatedAt === updatedAt) return cached.data;
    const data = JSON.stringify({ ...plan, site: { ...plan.site, backgroundImage: undefined } });
    this._planData.set(plan, { updatedAt, data });
    return data;
  }

  /** グリッドの子要素を cards の並びにする。位置が変わらないカードは動かさない（レイアウトの再計算を小さくする） */
  _placeCards(cards) {
    const keep = new Set(cards);
    for (const el of [...this.grid.children]) {
      if (!keep.has(el)) el.remove();
    }
    let ref = this.grid.firstElementChild;
    for (const card of cards) {
      if (card === ref) {
        ref = ref.nextElementSibling;
      } else {
        this.grid.insertBefore(card, ref);
      }
    }
  }

  /** 一覧から外れたサムネイルは、画面に近づいたときの描画の対象から外す */
  _dropUnusedThumbs(prevThumbs) {
    if (!this._thumbObserver) return;
    const used = new Set(this._thumbCanvases.values());
    for (const canvas of prevThumbs.values()) {
      if (!used.has(canvas)) this._thumbObserver.unobserve(canvas);
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

  /**
   * サムネイルの canvas を用意する。canvas を新しく確保して描くのは1枚あたり数 ms かかるので、
   * 前回と中身が同じなら前回の canvas をそのまま使い、新しく描くのは画面の近くに来たカードだけにする
   */
  _thumbCanvasFor(id, plan, prev) {
    const sig = JSON.stringify(plan.floors);
    const canvas = prev?._thumbSig === sig ? prev : document.createElement('canvas');
    canvas.className = 'plan-card-canvas';
    canvas._thumbSig = sig;
    canvas._thumbPlan = plan;
    this._thumbCanvases.set(id, canvas);
    if (this._thumbObserver) this._thumbObserver.observe(canvas);
    else requestAnimationFrame(() => this._drawThumb(canvas, canvas.clientWidth, canvas.clientHeight));
    return canvas;
  }

  _onThumbsVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      this._thumbObserver.unobserve(e.target);
      this._drawThumb(e.target, e.boundingClientRect.width, e.boundingClientRect.height);
    }
  }

  /** 中身も大きさも前回と同じなら描き直さない */
  _drawThumb(canvas, cssW, cssH) {
    const key = `${canvas._thumbSig}|${Math.round(cssW)}x${Math.round(cssH)}`;
    if (canvas._drawnKey === key) return;
    canvas._drawnKey = key;
    renderPlanThumbnail(canvas._thumbPlan, canvas, { cssW, cssH });
  }

  _buildCard(id, prevThumb) {
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
      this._toggleMenu(card);
    });
    head.appendChild(menuBtn);
    card.appendChild(head);
    if (this.folderFilter === null && plan.meta.folder) {
      const badge = document.createElement('button');
      badge.type = 'button';
      badge.className = 'plan-card-folder';
      badge.textContent = `📁 ${plan.meta.folder}`;
      badge.title = 'このフォルダを開く';
      badge.addEventListener('click', () => this._setFolderFilter(plan.meta.folder));
      card.appendChild(badge);
    }
    card.appendChild(this._buildNotes(id, plan));

    const thumbWrap = document.createElement('button');
    thumbWrap.type = 'button';
    thumbWrap.className = 'plan-card-thumb';
    thumbWrap.title = '編集を開く';
    thumbWrap.appendChild(this._thumbCanvasFor(id, plan, prevThumb));
    thumbWrap.addEventListener('click', () => this.onOpen(id));
    card.appendChild(thumbWrap);

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
        requestAnimationFrame(() => this._renderFloorCanvases(card, this.store.plans[id]));
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
      <button type="button" data-act="folder">フォルダへ移動</button>
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

  /** タイトル下のメモ欄（建蔽率・容積率の上限と現在値、自由記述メモ） */
  _buildNotes(id, plan) {
    const wrap = document.createElement('div');
    wrap.className = 'plan-card-notes';

    const ratios = M.planRatioStats(plan);
    wrap.appendChild(this._siteAreaField(id, plan, ratios));

    const ratioRow = document.createElement('div');
    ratioRow.className = 'plan-card-ratios';
    ratioRow.append(
      this._ratioField(id, '建蔽率', 'coverageLimitPct', plan.meta.coverageLimitPct, ratios.coveragePct),
      this._ratioField(id, '容積率', 'farLimitPct', plan.meta.farLimitPct, ratios.farPct),
    );
    wrap.appendChild(ratioRow);
    if (ratios.siteM2 <= 0) {
      const hint = document.createElement('div');
      hint.className = 'plan-card-ratio-hint';
      hint.textContent = '敷地面積を入れるか敷地を描くと、現在の建蔽率・容積率を計算します';
      wrap.appendChild(hint);
    }

    const memo = plan.meta.memo || '';
    const view = document.createElement('div');
    view.className = 'plan-card-memo';
    view.tabIndex = 0;
    view.title = 'クリックしてメモを編集';
    // 行数の制限は内側の要素にかける（外側の余白に4行目がはみ出して見えないように）
    const text = document.createElement('div');
    text.className = 'plan-card-memo-text';
    if (memo) {
      text.textContent = memo;
    } else {
      view.classList.add('empty');
      text.textContent = 'メモを追加（周辺環境・土地について思ったことなど）';
    }
    view.appendChild(text);
    const expanded = this.expandedMemoIds.has(id);
    view.classList.toggle('expanded', expanded);
    wrap.appendChild(view);

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'plan-card-memo-more';
    more.hidden = true;
    more.textContent = expanded ? '折りたたむ' : '…続きを表示';
    more.addEventListener('click', () => {
      if (this.expandedMemoIds.has(id)) this.expandedMemoIds.delete(id);
      else this.expandedMemoIds.add(id);
      this.render();
    });
    wrap.appendChild(more);
    // 3行に収まらない時だけ「続きを表示」を出す（描画後でないと高さが分からない）
    requestAnimationFrame(() => {
      more.hidden = !memo || (!expanded && text.scrollHeight <= text.clientHeight + 1);
    });

    const startEdit = () => {
      const ta = document.createElement('textarea');
      ta.className = 'plan-card-memo-input';
      ta.value = memo;
      ta.placeholder = '建蔽率・容積率以外の条件、周辺環境、土地について思ったことなど';
      const fit = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
      ta.addEventListener('input', fit);
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { ta.value = memo; ta.blur(); }
      });
      ta.addEventListener('blur', () => {
        if (ta.value !== memo) this.store.updatePlanMeta({ memo: ta.value }, id);
        else {
          this._cards.delete(id); // 入力欄に置き換えたカードは使い回さない
          this.render();
        }
      });
      view.replaceWith(ta);
      more.hidden = true;
      fit();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    };
    view.addEventListener('click', startEdit);
    view.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); startEdit(); }
    });
    return wrap;
  }

  /**
   * 「敷地面積 [120] ㎡（36.30坪・74.1畳）」。空欄で敷地を描いてあれば、描いた面積を薄く出してそれで換算する
   */
  _siteAreaField(id, plan, ratios) {
    const el = document.createElement('label');
    el.className = 'plan-card-site-area';
    const name = document.createElement('span');
    name.textContent = '敷地面積';
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.01';
    const entered = plan.meta.siteAreaM2;
    input.value = entered ?? '';
    input.placeholder = ratios.drawnSiteM2 > 0 ? ratios.drawnSiteM2.toFixed(2) : '—';
    if (ratios.drawnSiteM2 > 0) input.title = '空欄のときは描いた敷地の面積を使います';
    input.addEventListener('change', () => {
      const v = input.value === '' ? null : Number(input.value);
      if (v !== null && (Number.isNaN(v) || v < 0)) { input.value = entered ?? ''; return; }
      this.store.updatePlanMeta({ siteAreaM2: v || null }, id);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    const unit = document.createElement('span');
    unit.textContent = '㎡';
    el.append(name, input, unit);
    if (ratios.siteM2 > 0) {
      const conv = document.createElement('span');
      conv.className = 'plan-card-site-area-conv';
      const tatami = plan.meta.tatamiM2 || 1.62;
      conv.textContent = `（${M.tsuboCount(ratios.siteM2).toFixed(2)}坪・${M.tatamiCount(ratios.siteM2, tatami).toFixed(1)}畳）`;
      el.appendChild(conv);
    }
    return el;
  }

  /** 「建蔽率 [60]% 現在 48.0%」の1項目。上限を超えていたら赤字 */
  _ratioField(id, label, key, limit, current) {
    const el = document.createElement('label');
    el.className = 'plan-card-ratio';
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '10';
    input.placeholder = '—';
    input.value = limit ?? '';
    input.addEventListener('change', () => {
      const v = input.value === '' ? null : Number(input.value);
      if (v !== null && (Number.isNaN(v) || v < 0)) { input.value = limit ?? ''; return; }
      this.store.updatePlanMeta({ [key]: v }, id);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    const unit = document.createElement('span');
    unit.textContent = '%';
    el.append(name, input, unit);
    if (current != null) {
      const now = document.createElement('span');
      now.className = 'plan-card-ratio-now';
      if (limit != null && current > limit) now.classList.add('over');
      now.textContent = `現在 ${current.toFixed(1)}%`;
      el.appendChild(now);
    }
    return el;
  }

  _toggleMenu(card) {
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

  /** 自動バックアップの一覧を開く（時点ごとに折りたたみ、プラン単位で復元する） */
  async _openBackups() {
    const list = document.getElementById('backup-list');
    list.textContent = '';
    document.getElementById('backup-modal').hidden = false;
    const backups = await this.store.listBackups();
    if (!backups.length) {
      const empty = document.createElement('p');
      empty.className = 'modal-message';
      empty.textContent = 'バックアップはまだありません。';
      list.appendChild(empty);
      return;
    }
    for (const backup of backups) {
      const group = document.createElement('details');
      group.className = 'backup-group';
      const summary = document.createElement('summary');
      summary.textContent = `${formatDateTime(backup.savedAt)}（${backup.plans.length} 件）`;
      group.appendChild(summary);
      for (const item of backup.plans) {
        const row = document.createElement('div');
        row.className = 'backup-row';
        const name = document.createElement('span');
        name.className = 'backup-row-name';
        name.textContent = item.name;
        const time = document.createElement('span');
        time.className = 'backup-row-time';
        time.textContent = `更新 ${formatDateTime(item.updatedAt)}`;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn';
        btn.textContent = '復元';
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          const id = await this.store.restorePlanFromBackup(backup.savedAt, item.id);
          btn.textContent = id ? '復元しました' : '復元できません';
        });
        row.append(name, time, btn);
        group.appendChild(row);
      }
      list.appendChild(group);
    }
  }

  async _createPlan() {
    const name = await showPrompt({
      title: 'プラン新規作成',
      label: 'プラン名',
      defaultValue: `マイプラン${this.store.order.length + 1}`,
    });
    if (name === null) return;
    const id = this.store.newPlan(name.trim() || '無題', { folder: this.folderFilter || '' });
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
    if (act === 'folder') {
      this._moveToFolder(id);
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
    this._planData = new WeakMap(); // 編集画面での変更を確実に反映する
    this.render();
  }

  hide() {
    this.root?.setAttribute('hidden', '');
    document.body.classList.remove('plan-list-mode');
    this._closeMenus();
  }
}
