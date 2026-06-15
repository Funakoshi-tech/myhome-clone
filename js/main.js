// main.js
// エントリ。UI 配線・各モジュールの統括のみ。

import { store } from './store.js';
import * as M from './model.js';
import { ROOM_TYPES, FURNITURE, STAIR_TYPES, getRoomType, getFurniture, getStairType } from './catalog.js';
import { Editor2D } from './editor2d.js';
import { Viewer3D } from './viewer3d.js';
import { getSunPosition, dateFromDayOfYear, formatMonthDay, SEASON_MARKERS } from './sun.js';

// ---- 共有 UI 状態（永続化しない一時状態） ----------------------------------
const ui = {
  view: '2d',            // '2d' | '3d'
  floorId: '1F',
  tool: 'select',        // 'select' | 'room' | 'furniture' | 'stair' | 'pan'
  roomType: ROOM_TYPES.find((r) => r.id === 'LDK')?.id || ROOM_TYPES[0].id,
  furnitureId: FURNITURE[0].id,
  stairType: STAIR_TYPES[0].id,
  selection: null,       // { kind:'room'|'furniture'|'stair', id }
  showGrid: true,
  // 日射シミュレーション（フェーズB）
  sun: { doy: 172, hour: 12, playing: false },
  daylight: {},          // { [roomId]: 直射時間 }
};
let sunTimer = null;

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
  $('#sun-panel').hidden = !is3d;
  editor.setActive(!is3d);
  viewer.setActive(is3d);
  document.querySelectorAll('#view-toggle .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  if (is3d) {
    viewer.updateSun(ui.sun.doy, ui.sun.hour);
    updateSunInfo();
  } else {
    stopSunAnimation();
    editor.resize(); editor.draw();
  }
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
  $('#room-pane').classList.toggle('hl', tool === 'room');
  $('#furniture-pane').classList.toggle('hl', tool === 'furniture');
  $('#stair-pane').classList.toggle('hl', tool === 'stair');
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
  document.querySelectorAll('#stair-types .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === ui.stairType));
}

function buildStairChips() {
  const wrap = $('#stair-types');
  wrap.innerHTML = '';
  for (const t of STAIR_TYPES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.id = t.id;
    b.innerHTML = `<span class="stair-icon">${t.icon}</span>${t.name}`;
    b.addEventListener('click', () => {
      ui.stairType = t.id;
      ui.tool = 'stair';
      setTool('stair');
      markChips();
    });
    wrap.appendChild(b);
  }
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
    body.textContent = '未選択（選択ツールで部屋・家具・階段をクリック）';
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

  } else if (sel.kind === 'stair') {
    const s = (floor.stairs || []).find((x) => x.id === sel.id);
    if (!s) { body.textContent = '—'; return; }
    const def = getStairType(s.type);

    body.appendChild(readonlyRow('種類', def.name));
    body.appendChild(readonlyRow('サイズ', `W${s.widthMM}×D${s.depthMM}mm`));

    // 種別変更
    const typeSel = document.createElement('select');
    for (const t of STAIR_TYPES) {
      const o = document.createElement('option');
      o.value = t.id; o.textContent = `${t.icon} ${t.name}`;
      if (t.id === s.type) o.selected = true;
      typeSel.appendChild(o);
    }
    typeSel.addEventListener('change', () => {
      const newDef = getStairType(typeSel.value);
      editor.applyToSelection((stair) => {
        stair.type = newDef.id;
        stair.widthMM = newDef.defaultW;
        stair.depthMM = newDef.defaultD;
      });
    });
    body.appendChild(field('種別変更', typeSel));

    // 回転
    const rotWrap = document.createElement('div');
    rotWrap.className = 'btn-row';
    const rl = document.createElement('button');
    rl.className = 'btn'; rl.textContent = '⟲ -90°';
    rl.addEventListener('click', () => editor.rotateSelectedStair(-90));
    const rr = document.createElement('button');
    rr.className = 'btn'; rr.textContent = '+90° ⟳';
    rr.addEventListener('click', () => editor.rotateSelectedStair(90));
    rotWrap.append(rl, rr);
    body.appendChild(field(`向き（${s.rotationDeg || 0}°）`, rotWrap));

    body.appendChild(deleteButton('この階段を削除'));
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
    <div><span>階段数</span><b>${(floor.stairs || []).length}</b></div>
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
    select: '選択：クリックで選択/ドラッグで移動。部屋選択中は●頂点ドラッグ・辺ドラッグで平行移動・右クリックで頂点挿入。Del削除 / R回転',
    room: 'ドラッグで部屋を矩形作成（スナップ適用）',
    furniture: 'クリックで家具を配置',
    stair: 'クリックで階段を配置。選択後 R で回転 / Del で削除。1F に置くと 2F に参照表示が自動追加',
    pan: 'ドラッグで画面移動。ホイールでズーム',
  };
  hint.textContent = map[ui.tool] || '';
}

// ---- 日射シミュレーション（フェーズB） -------------------------------------
function buildSunStatics() {
  const seasons = $('#sun-seasons');
  seasons.innerHTML = '';
  for (const m of SEASON_MARKERS) {
    const b = document.createElement('button');
    b.textContent = m.label;
    b.title = `${m.label} に移動`;
    b.addEventListener('click', () => {
      ui.sun.doy = m.doy;
      $('#sun-date').value = m.doy;
      onSunDateChange();
    });
    seasons.appendChild(b);
  }
  const ticks = $('#sun-date-ticks');
  ticks.innerHTML = '';
  for (const m of SEASON_MARKERS) {
    const o = document.createElement('option');
    o.value = String(m.doy);
    o.label = m.label;
    ticks.appendChild(o);
  }
}

function updateSunLabels() {
  $('#sun-date-label').textContent = formatMonthDay(ui.sun.doy);
  $('#sun-hour-label').textContent = `${ui.sun.hour}:00`;
}

function updateSunInfo() {
  const plan = store.current();
  const pos = getSunPosition(dateFromDayOfYear(ui.sun.doy), ui.sun.hour, plan.meta.lat, plan.meta.lng);
  const el = $('#sun-info');
  if (pos.altitudeDeg <= 0) {
    el.classList.add('night');
    el.textContent = `日没（太陽は地平線下） ${ui.sun.hour}:00`;
  } else {
    el.classList.remove('night');
    el.textContent = `方位 ${Math.round(pos.azimuthDeg)}° / 高度 ${Math.round(pos.altitudeDeg)}°`;
  }
}

function syncSunPanel() {
  const plan = store.current();
  $('#sun-date').value = ui.sun.doy;
  $('#sun-hour').value = ui.sun.hour;
  updateSunLabels();
  $('#sun-azimuth').value = Math.round(plan.site.azimuth || 0);
  $('#sun-lat').value = plan.meta.lat ?? '';
  $('#sun-lng').value = plan.meta.lng ?? '';
}

// 各部屋の直射日照時間を再計算（部屋ラベルに反映）
function recomputeDaylight() {
  try {
    ui.daylight = viewer.computeDaylight(ui.sun.doy);
  } catch (err) {
    console.warn('日照計算に失敗', err);
    ui.daylight = {};
  }
  if (ui.view === '2d') editor.draw();
}

function onSunDateChange() {
  updateSunLabels();
  if (ui.view === '3d') viewer.updateSun(ui.sun.doy, ui.sun.hour);
  updateSunInfo();
  recomputeDaylight();
}
function onSunHourChange() {
  updateSunLabels();
  if (ui.view === '3d') viewer.updateSun(ui.sun.doy, ui.sun.hour);
  updateSunInfo();
}

function startSunAnimation() {
  ui.sun.playing = true;
  const btn = $('#sun-play');
  btn.classList.add('playing');
  btn.textContent = '⏸ 停止';
  // 1秒で1時間進む
  sunTimer = setInterval(() => {
    ui.sun.hour = (ui.sun.hour + 1) % 24;
    $('#sun-hour').value = ui.sun.hour;
    onSunHourChange();
  }, 1000);
}
function stopSunAnimation() {
  ui.sun.playing = false;
  if (sunTimer) { clearInterval(sunTimer); sunTimer = null; }
  const btn = $('#sun-play');
  if (btn) { btn.classList.remove('playing'); btn.textContent = '▶ 再生'; }
}

function wireSunPanel() {
  $('#sun-date').addEventListener('input', (e) => { ui.sun.doy = Number(e.target.value); onSunDateChange(); });
  $('#sun-hour').addEventListener('input', (e) => { ui.sun.hour = Number(e.target.value); onSunHourChange(); });
  $('#sun-play').addEventListener('click', () => { ui.sun.playing ? stopSunAnimation() : startSunAnimation(); });
  $('#sun-azimuth').addEventListener('change', (e) => {
    const v = ((Number(e.target.value) % 360) + 360) % 360;
    store.update((plan) => { plan.site.azimuth = v; });
  });
  $('#sun-lat').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!Number.isNaN(v)) store.update((plan) => { plan.meta.lat = v; });
  });
  $('#sun-lng').addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (!Number.isNaN(v)) store.update((plan) => { plan.meta.lng = v; });
  });
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
  syncSunPanel();
  recomputeDaylight();
  if (ui.view === '2d') editor.zoomFit();
}

// ---- store 購読: データ変更時に各所を更新 ----------------------------------
store.subscribe(() => {
  refreshPanels();
  recomputeDaylight();
  if (ui.view === '3d') updateSunInfo();
});

// ---- 起動 -------------------------------------------------------------------
function boot() {
  buildRoomChips();
  buildFurnitureChips();
  buildStairChips();
  buildSunStatics();
  buildPlanSelect();
  wireEvents();
  wireSunPanel();

  setTool('select');
  setFloor('1F');
  setView('2d');
  refreshPanels();
  syncSunPanel();
  recomputeDaylight();
  editor.resize();
  editor.zoomFit();
  updateHint();
}

boot();
