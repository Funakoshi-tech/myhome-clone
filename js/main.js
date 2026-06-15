// main.js
// エントリ。UI 配線・各モジュールの統括のみ。

import { store } from './store.js';
import * as M from './model.js';
import { ROOM_TYPES, FURNITURE, getRoomType, getFurniture } from './catalog.js';
import { Editor2D } from './editor2d.js';
import { Viewer3D } from './viewer3d.js';

// ---- 共有 UI 状態（永続化しない一時状態） ----------------------------------
const ui = {
  view: '2d',            // '2d' | '3d'
  floorId: '1F',
  tool: 'select',        // 'select' | 'room' | 'furniture' | 'pan'
  roomType: ROOM_TYPES.find((r) => r.id === 'LDK')?.id || ROOM_TYPES[0].id,
  furnitureId: FURNITURE[0].id,
  selection: null,       // { kind:'room'|'furniture', id }
  showGrid: true,
};

// ---- DOM 取得 ---------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const canvas = $('#canvas2d');
const viewer3dEl = $('#viewer3d');

const editor = new Editor2D(canvas, store, ui, refreshPanels);
const viewer = new Viewer3D(viewer3dEl, store, ui);

// ---- ビュー切替 -------------------------------------------------------------
function setView(view) {
  ui.view = view;
  const is3d = view === '3d';
  canvas.hidden = is3d;
  viewer3dEl.hidden = !is3d;
  editor.setActive(!is3d);
  viewer.setActive(is3d);
  document.querySelectorAll('#view-toggle .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  if (!is3d) { editor.resize(); editor.draw(); }
  updateHint();
}

function setFloor(floorId) {
  ui.floorId = floorId;
  ui.selection = null;
  document.querySelectorAll('#floor-tabs .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.floor === floorId));
  if (ui.view === '2d') editor.draw();
  refreshPanels();
}

function setTool(tool) {
  ui.tool = tool;
  document.querySelectorAll('#tool-group .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === tool));
  // 関連パネルの強調
  $('#room-pane').classList.toggle('hl', tool === 'room');
  $('#furniture-pane').classList.toggle('hl', tool === 'furniture');
  updateHint();
}

// ---- パネル構築 -------------------------------------------------------------
function buildRoomChips() {
  const wrap = $('#room-types');
  wrap.innerHTML = '';
  for (const t of ROOM_TYPES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.id = t.id;
    b.innerHTML = `<span class="dot" style="background:${t.color}"></span>${t.name}`;
    b.addEventListener('click', () => {
      ui.roomType = t.id;
      ui.tool = 'room';
      setTool('room');
      markChips();
    });
    wrap.appendChild(b);
  }
}

function buildFurnitureChips() {
  const wrap = $('#furniture-types');
  wrap.innerHTML = '';
  for (const f of FURNITURE) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.id = f.id;
    b.innerHTML = `<span class="dot" style="background:${f.color}"></span>${f.name}`;
    b.addEventListener('click', () => {
      ui.furnitureId = f.id;
      ui.tool = 'furniture';
      setTool('furniture');
      markChips();
    });
    wrap.appendChild(b);
  }
}

function markChips() {
  document.querySelectorAll('#room-types .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === ui.roomType));
  document.querySelectorAll('#furniture-types .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === ui.furnitureId));
}

// ---- プラン選択 -------------------------------------------------------------
function buildPlanSelect() {
  const sel = $('#plan-select');
  sel.innerHTML = '';
  for (const p of store.list()) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === store.currentId) opt.selected = true;
    sel.appendChild(opt);
  }
}

// ---- プロパティ & 情報 ------------------------------------------------------
function refreshPanels() {
  buildPlanSelect();
  markChips();
  buildProps();
  buildFloorInfo();
  syncSnapButtons();
  if (ui.view === '2d') editor.draw();
  if (ui.view === '3d') viewer.rebuild();
}

function buildProps() {
  const body = $('#props-body');
  const sel = ui.selection;
  const floor = M.getFloor(store.current(), ui.floorId);
  body.innerHTML = '';

  if (!sel) {
    body.className = 'props-empty';
    body.textContent = '未選択（選択ツールで部屋や家具をクリック）';
    return;
  }
  body.className = '';

  if (sel.kind === 'room') {
    const r = floor.rooms.find((x) => x.id === sel.id);
    if (!r) { body.textContent = '—'; return; }
    const areaM2 = M.polygonAreaM2(r.polygon);
    const tatami = store.current().meta.tatamiM2 || 1.62;

    // 名前
    body.appendChild(field('名前', inputText(r.name || '', (v) => {
      editor.applyToSelection((room) => { room.name = v; });
    })));

    // 種別
    const typeSel = document.createElement('select');
    for (const t of ROOM_TYPES) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = t.name;
      if (t.id === r.type) o.selected = true;
      typeSel.appendChild(o);
    }
    typeSel.addEventListener('change', () => {
      const t = getRoomType(typeSel.value);
      editor.applyToSelection((room) => { room.type = t.id; });
    });
    body.appendChild(field('種別', typeSel));

    // ラベル表示
    body.appendChild(checkRow('ラベルを表示', r.labelVisible !== false, (on) => {
      editor.applyToSelection((room) => { room.labelVisible = on; });
    }));

    body.appendChild(readonlyRow('面積', M.formatAreaLabel(areaM2, tatami)));

    body.appendChild(deleteButton('この部屋を削除'));
  } else if (sel.kind === 'furniture') {
    const f = floor.furniture.find((x) => x.id === sel.id);
    if (!f) { body.textContent = '—'; return; }
    const cat = getFurniture(f.catalogId);

    body.appendChild(readonlyRow('種類', cat.name));
    body.appendChild(readonlyRow('サイズ', `${f.wMM}×${f.dMM}×${f.hMM}mm`));

    // 回転
    const rotWrap = document.createElement('div');
    rotWrap.className = 'btn-row';
    const rl = document.createElement('button');
    rl.className = 'btn'; rl.textContent = '⟲ -90°';
    rl.addEventListener('click', () => editor.rotateSelectedFurniture(-90));
    const rr = document.createElement('button');
    rr.className = 'btn'; rr.textContent = '+90° ⟳';
    rr.addEventListener('click', () => editor.rotateSelectedFurniture(90));
    rotWrap.append(rl, rr);
    body.appendChild(field(`向き（${f.rotationDeg || 0}°）`, rotWrap));

    // 色
    body.appendChild(field('色', inputColor(f.color || '#888888', (v) => {
      editor.applyToSelection((fr) => { fr.color = v; });
    })));

    body.appendChild(deleteButton('この家具を削除'));
  }
}

function field(label, el) {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const l = document.createElement('label');
  l.textContent = label;
  row.append(l, el);
  return row;
}
function readonlyRow(label, value) {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const l = document.createElement('label'); l.textContent = label;
  const v = document.createElement('span'); v.className = 'prop-val'; v.textContent = value;
  row.append(l, v);
  return row;
}
function inputText(value, onChange) {
  const i = document.createElement('input');
  i.type = 'text'; i.value = value;
  i.addEventListener('change', () => onChange(i.value));
  return i;
}
function inputColor(value, onChange) {
  const i = document.createElement('input');
  i.type = 'color'; i.value = value;
  i.addEventListener('input', () => onChange(i.value));
  return i;
}
function checkRow(label, checked, onChange) {
  const row = document.createElement('label');
  row.className = 'row check';
  const i = document.createElement('input');
  i.type = 'checkbox'; i.checked = checked;
  i.addEventListener('change', () => onChange(i.checked));
  const s = document.createElement('span'); s.textContent = label;
  row.append(i, s);
  return row;
}
function deleteButton(label) {
  const b = document.createElement('button');
  b.className = 'btn danger wide';
  b.textContent = label;
  b.addEventListener('click', () => editor.deleteSelection());
  return b;
}

function buildFloorInfo() {
  const el = $('#floor-info');
  const plan = store.current();
  const floor = M.getFloor(plan, ui.floorId);
  const tatami = plan.meta.tatamiM2 || 1.62;
  let total = 0;
  for (const r of floor.rooms) total += M.polygonAreaM2(r.polygon);
  el.innerHTML = `
    <div><span>フロア</span><b>${floor.id}（天井 ${floor.ceilingHeightMM}mm）</b></div>
    <div><span>部屋数</span><b>${floor.rooms.length}</b></div>
    <div><span>家具数</span><b>${floor.furniture.length}</b></div>
    <div><span>床面積合計</span><b>${M.formatAreaLabel(total, tatami)}</b></div>
  `;
}

function syncSnapButtons() {
  const div = store.current().meta.snapDivisions || 4;
  document.querySelectorAll('#snap-group .seg-btn').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.snap) === div));
}

function updateHint() {
  const hint = $('#hint');
  if (ui.view === '3d') {
    hint.textContent = 'ドラッグで回転 / ホイールでズーム / 右ドラッグで平行移動';
    return;
  }
  const map = {
    select: '部屋・家具をクリックで選択、ドラッグで移動。Delキーで削除、Rキーで家具回転',
    room: 'ドラッグで部屋を矩形作成（スナップ適用）',
    furniture: 'クリックで家具を配置',
    pan: 'ドラッグで画面移動。ホイールでズーム',
  };
  hint.textContent = map[ui.tool] || '';
}

// ---- イベント配線 -----------------------------------------------------------
function wireEvents() {
  document.querySelectorAll('#view-toggle .seg-btn').forEach((b) =>
    b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('#floor-tabs .seg-btn').forEach((b) =>
    b.addEventListener('click', () => setFloor(b.dataset.floor)));
  document.querySelectorAll('#tool-group .seg-btn').forEach((b) =>
    b.addEventListener('click', () => setTool(b.dataset.tool)));

  document.querySelectorAll('#snap-group .seg-btn').forEach((b) =>
    b.addEventListener('click', () => {
      const div = Number(b.dataset.snap);
      store.update((plan) => { plan.meta.snapDivisions = div; });
    }));

  $('#grid-toggle').addEventListener('change', (e) => {
    ui.showGrid = e.target.checked;
    editor.draw();
  });

  $('#zoom-fit').addEventListener('click', () => {
    if (ui.view === '2d') editor.zoomFit();
    else viewer.resetView();
  });

  // プラン操作
  $('#plan-select').addEventListener('change', (e) => store.select(e.target.value));
  $('#plan-new').addEventListener('click', () => {
    const name = prompt('新しいプラン名', `マイプラン${store.order.length + 1}`);
    if (name !== null) { store.newPlan(name || '無題'); afterPlanChange(); }
  });
  $('#plan-dup').addEventListener('click', () => { store.duplicatePlan(); afterPlanChange(); });
  $('#plan-del').addEventListener('click', () => {
    if (confirm('現在のプランを削除しますか？')) { store.deletePlan(); afterPlanChange(); }
  });
  $('#plan-rename').addEventListener('click', () => {
    const cur = store.current();
    const name = prompt('プラン名を変更', cur.meta.name);
    if (name) store.renamePlan(name);
  });

  // JSON 入出力
  $('#json-export').addEventListener('click', () => store.exportCurrentJSON());
  $('#json-import').addEventListener('click', () => $('#json-file').click());
  $('#json-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      store.importJSON(obj);
      afterPlanChange();
    } catch (err) {
      alert('JSON の読み込みに失敗しました: ' + err.message);
    }
    e.target.value = '';
  });

  // リサイズ
  window.addEventListener('resize', () => { if (ui.view === '2d') editor.resize(); });
}

function afterPlanChange() {
  ui.selection = null;
  ui.floorId = '1F';
  setFloor('1F');
  viewer._fitted = false;
  refreshPanels();
  if (ui.view === '2d') editor.zoomFit();
}

// ---- store 購読: データ変更時に各所を更新 ----------------------------------
store.subscribe(() => {
  refreshPanels();
});

// ---- 起動 -------------------------------------------------------------------
function boot() {
  buildRoomChips();
  buildFurnitureChips();
  buildPlanSelect();
  wireEvents();

  setTool('select');
  setFloor('1F');
  setView('2d');
  refreshPanels();
  editor.resize();
  editor.zoomFit();
  updateHint();
}

boot();
