// main.js
// エントリ。UI 配線・各モジュールの統括のみ。

import { store } from './store.js';
import * as M from './model.js';
import { ROOM_TYPES, FURNITURE, STAIR_TYPES, OPENING_TYPES, PLUMBING_TYPES, EXTERIOR_TYPES, getRoomType, getFurniture, getStairType, getOpeningType } from './catalog.js';
import { Editor2D } from './editor2d.js';
import { Viewer3D } from './viewer3d.js';
import { getSunPosition, dateFromDayOfYear, formatMonthDay, SEASON_MARKERS } from './sun.js';
import { PlanList } from './planList.js';
import { showAlert, showConfirm } from './dialog.js';

// ---- 共有 UI 状態（永続化しない一時状態） ----------------------------------
const ui = {
  view: '2d',            // '2d' | '3d'
  floorId: '1F',
  tool: 'select',        // 'select' | 'room' | 'furniture' | 'stair' | 'pan'
  roomType: ROOM_TYPES.find((r) => r.id === 'LDK')?.id || ROOM_TYPES[0].id,
  furnitureId: FURNITURE[0].id,
  stairType: STAIR_TYPES[0].id,
  openingId: OPENING_TYPES[0].id,  // 'window' | 'sliding' | 'door'
  plumbingId: PLUMBING_TYPES[0].id,
  exteriorId: EXTERIOR_TYPES[0].id,
  selection: null,       // { kind:'room'|'furniture'|'stair'|'opening', id }
  showGrid: true,
  showDimensions: false,
  showLowerFloorRef: true,
  view3dAllFloors: false, // 3D: true=全階積み上げ表示, false=選択階のみ
  // 日射シミュレーション（フェーズB）
  sun: { doy: 172, hour: 12, playing: false },
  daylight: {},          // { [roomId]: 直射時間 }
  bgCalib: false,        // 敷地写真：基準線モード中
};
let sunTimer = null;

// ---- DOM 取得 ---------------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const canvas = $('#canvas2d');
const viewer3dEl = $('#viewer3d');

const editor = new Editor2D(canvas, store, ui, refreshPanels);
const viewer = new Viewer3D(viewer3dEl, store, ui);

let planList = null;
let screen = 'list'; // 'list' | 'editor'

// ---- 画面切替 ---------------------------------------------------------------
function syncEditorPlanName() {
  const el = $('#editor-plan-name');
  if (el) el.textContent = store.current()?.meta?.name || '無題';
}

function showPlanList() {
  screen = 'list';
  stopSunAnimation();
  editor.setActive(false);
  viewer.setActive(false);
  $('#editor-screen')?.setAttribute('hidden', '');
  planList?.show();
}

function openPlanEditor(id) {
  if (id && store.plans[id]) store.select(id);
  screen = 'editor';
  planList?.hide();
  $('#editor-screen')?.removeAttribute('hidden');
  syncEditorPlanName();
  afterPlanChange();
  scheduleEditorLayout();
}

/** 編集画面表示後にレイアウト確定してから 2D/3D を有効化（非表示中の resize 回避） */
function scheduleEditorLayout() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setView(ui.view);
      if (ui.view === '2d') editor.zoomFit();
    });
  });
}

function returnToPlanList() {
  store.save();
  showPlanList();
}

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
  syncView3dAllFloorsButton();
  updateHint();
}

function syncView3dAllFloorsButton() {
  const btn = $('#view3d-all-floors');
  if (!btn) return;
  const is3d = ui.view === '3d';
  btn.hidden = !is3d;
  btn.classList.toggle('active', is3d && ui.view3dAllFloors);
  btn.textContent = ui.view3dAllFloors ? '全階表示中' : '全階表示';
}

function setView3dAllFloors(on) {
  ui.view3dAllFloors = !!on;
  syncView3dAllFloorsButton();
  if (ui.view === '3d') {
    viewer.rebuild({ fitCamera: true });
    updateHint();
  }
}

function setFloor(floorId) {
  ui.floorId = floorId;
  ui.selection = null;
  ui.view3dAllFloors = false;
  document.querySelectorAll('#floor-tabs .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.floor === floorId));
  syncView3dAllFloorsButton();
  if (ui.view === '2d') editor.draw();
  refreshPanels();
}

function setTool(tool) {
  ui.tool = tool;
  document.querySelectorAll('#tool-group .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tool === tool));
  $('#room-pane').classList.toggle('hl', tool === 'room');
  $('#stair-pane').classList.toggle('hl', tool === 'stair');
  $('#opening-pane').classList.toggle('hl', tool === 'opening');
  $('#furniture-pane').classList.toggle('hl', tool === 'furniture');
  updateHint();
}

ui.setTool = (tool) => setTool(tool);

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
  document.querySelectorAll('#stair-types .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === ui.stairType));
  document.querySelectorAll('#opening-types .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === ui.openingId));
  document.querySelectorAll('#plumbing-types .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === ui.plumbingId));
  document.querySelectorAll('#furniture-types .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === ui.furnitureId));
  document.querySelectorAll('#exterior-types .chip').forEach((b) =>
    b.classList.toggle('active', b.dataset.id === ui.exteriorId));
}

function buildOpeningChips() {
  const wrap = $('#opening-types');
  wrap.innerHTML = '';
  for (const t of OPENING_TYPES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.id = t.id;
    b.textContent = t.name;
    b.addEventListener('click', () => {
      ui.openingId = t.id;
      ui.tool = 'opening';
      setTool('opening');
      markChips();
    });
    wrap.appendChild(b);
  }
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

function buildPlumbingChips() {
  const wrap = $('#plumbing-types');
  wrap.innerHTML = '';
  for (const t of PLUMBING_TYPES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.id = t.id;
    b.innerHTML = `<span class="dot" style="background:${t.color}"></span>${t.name}`;
    b.addEventListener('click', () => {
      ui.plumbingId = t.id;
      markChips();
    });
    wrap.appendChild(b);
  }
}

function buildExteriorChips() {
  const wrap = $('#exterior-types');
  wrap.innerHTML = '';
  for (const t of EXTERIOR_TYPES) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.dataset.id = t.id;
    b.innerHTML = `<span class="dot" style="background:${t.color}"></span>${t.name}`;
    b.addEventListener('click', () => {
      ui.exteriorId = t.id;
      markChips();
    });
    wrap.appendChild(b);
  }
}

function wireCollapsiblePanes() {
  document.querySelectorAll('.pane-fold').forEach((pane) => {
    const head = pane.querySelector('.pane-fold-head');
    if (!head || head.dataset.wired) return;
    head.dataset.wired = '1';
    head.addEventListener('click', () => {
      const collapsed = pane.classList.toggle('collapsed');
      head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    });
  });
}

// ---- プロパティ & 情報 ------------------------------------------------------
function refreshPanels() {
  syncEditorPlanName();
  markChips();
  buildProps();
  buildFloorInfo();
  syncSnapButtons();
  syncLowerFloorRefToggle();
  syncBgPanel();
  if (ui.view === '2d') editor.draw();
  if (ui.view === '3d') viewer.rebuild();
}

// ---- 敷地写真（下絵） -------------------------------------------------------
let _bgPendingPxDist = 0;

function syncBgPanel() {
  const bg = store.current()?.site?.backgroundImage;
  const hasBg = !!(bg?.dataUrl);
  $('#bg-recalib').hidden = !hasBg;
  $('#bg-position').hidden = !hasBg || !M.isBackgroundImageScaled(bg);
  $('#bg-delete').hidden = !hasBg;
  $('#bg-visible').closest('.row.check').hidden = !hasBg;
  $('#bg-opacity').closest('.row').hidden = !hasBg;
  if (hasBg) {
    $('#bg-visible').checked = bg.visible !== false;
    const opPct = Math.round((bg.opacity ?? 0.5) * 100);
    $('#bg-opacity').value = String(opPct);
    $('#bg-opacity-label').textContent = `${opPct}%`;
    const status = M.isBackgroundImageScaled(bg)
      ? `スケール ${bg.scaleMMperPx.toFixed(2)} mm/px · ${bg.naturalWidthPx}×${bg.naturalHeightPx}px`
      : '基準線を設定して実寸合わせしてください';
    $('#bg-status').textContent = status;
    editor._ensureBgImage(bg);
  } else {
    $('#bg-status').textContent = 'JPEG/PNG を読み込んで実寸合わせ';
  }
}

function readImageFileAsDataUrl(file, maxPx = 1600) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        const scale = Math.min(1, maxPx / Math.max(width, height));
        if (scale < 1) {
          width = Math.round(width * scale);
          height = Math.round(height * scale);
          const c = document.createElement('canvas');
          c.width = width;
          c.height = height;
          const ctx = c.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve({ dataUrl: c.toDataURL('image/jpeg', 0.88), width, height });
        } else {
          resolve({ dataUrl: reader.result, width, height });
        }
      };
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });
}

function showBgScaleModal(pxDist) {
  _bgPendingPxDist = pxDist;
  $('#bg-scale-px-info').textContent = `画面上の距離: ${pxDist.toFixed(1)} px`;
  $('#bg-scale-mm').value = '';
  $('#bg-scale-modal').hidden = false;
  $('#bg-scale-mm').focus();
}

function hideBgScaleModal() {
  $('#bg-scale-modal').hidden = true;
  _bgPendingPxDist = 0;
}

function showBgPosModal() {
  syncBgPosLabel();
  $('#bg-pos-modal').hidden = false;
  editor.draw();
}

function hideBgPosModal() {
  $('#bg-pos-modal').hidden = true;
  syncBgPanel();
  updateHint();
  editor.draw();
}

function syncBgPosLabel() {
  const bg = store.current()?.site?.backgroundImage;
  if (!bg) return;
  $('#bg-pos-offset').textContent =
    `X: ${Math.round(bg.offsetX ?? 0)} / Z: ${Math.round(bg.offsetZ ?? 0)} mm`;
}

ui.onBgCalibDone = async (pxDist) => {
  if (pxDist < 2) {
    await showAlert({ title: '基準線', message: '2点が近すぎます。もう一度設定してください。' });
    editor.startBgCalibration();
    updateHint();
    return;
  }
  showBgScaleModal(pxDist);
  updateHint();
};

function wireBgPanel() {
  $('#bg-load').addEventListener('click', () => $('#bg-file').click());

  $('#bg-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { dataUrl, width, height } = await readImageFileAsDataUrl(file);
      store.update((plan) => {
        plan.site.backgroundImage = {
          dataUrl,
          naturalWidthPx: width,
          naturalHeightPx: height,
          scaleMMperPx: null,
          offsetX: 0,
          offsetZ: 0,
          rotationDeg: 0,
          opacity: 0.5,
          visible: true,
        };
      });
      editor.invalidateBgImage();
      editor.startBgCalibration();
      editor.zoomFit();
      syncBgPanel();
      updateHint();
    } catch (err) {
      await showAlert({ title: '画像読込', message: err.message || '画像の読み込みに失敗しました' });
    }
  });

  $('#bg-recalib').addEventListener('click', () => {
    editor.startBgCalibration();
    updateHint();
  });

  $('#bg-position').addEventListener('click', () => showBgPosModal());

  $('#bg-delete').addEventListener('click', async () => {
    if (!store.current()?.site?.backgroundImage?.dataUrl) return;
    const ok = await showConfirm({
      title: '下絵を削除',
      message: '下絵を削除しますか？',
      okText: '削除',
      danger: true,
    });
    if (!ok) return;
    store.update((plan) => {
      plan.site.backgroundImage = null;
    });
    editor.cancelBgCalibration();
    editor.invalidateBgImage();
    hideBgScaleModal();
    hideBgPosModal();
    syncBgPanel();
    updateHint();
    editor.draw();
  });

  $('#bg-visible').addEventListener('change', (e) => {
    store.update((plan) => {
      const bg = plan.site.backgroundImage;
      if (bg) bg.visible = e.target.checked;
    });
    editor.draw();
  });

  $('#bg-opacity').addEventListener('input', (e) => {
    const pct = Number(e.target.value);
    $('#bg-opacity-label').textContent = `${pct}%`;
    store.update((plan) => {
      const bg = plan.site.backgroundImage;
      if (bg) bg.opacity = pct / 100;
    });
    editor.draw();
  });

  $('#bg-scale-cancel').addEventListener('click', () => {
    hideBgScaleModal();
    editor.startBgCalibration();
    updateHint();
  });

  $('#bg-scale-ok').addEventListener('click', async () => {
    const mm = Number($('#bg-scale-mm').value);
    if (!mm || mm <= 0) {
      await showAlert({ title: '実寸入力', message: '0より大きい mm 数値を入力してください' });
      return;
    }
    const pxDist = _bgPendingPxDist;
    if (pxDist < 2) return;
    store.update((plan) => {
      const bg = plan.site.backgroundImage;
      if (!bg) return;
      bg.scaleMMperPx = mm / pxDist;
      bg.offsetX = 0;
      bg.offsetZ = 0;
    });
    editor.cancelBgCalibration();
    hideBgScaleModal();
    showBgPosModal();
    syncBgPanel();
  });

  $('#bg-scale-mm').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#bg-scale-ok').click();
  });

  document.querySelectorAll('.bg-pos-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dx = Number(btn.dataset.dx);
      const dz = Number(btn.dataset.dz);
      store.update((plan) => {
        const bg = plan.site.backgroundImage;
        if (!bg) return;
        bg.offsetX = (bg.offsetX ?? 0) + dx;
        bg.offsetZ = (bg.offsetZ ?? 0) + dz;
      });
      syncBgPosLabel();
      editor.draw();
    });
  });

  $('#bg-pos-ok').addEventListener('click', () => hideBgPosModal());
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

  } else if (sel.kind === 'opening') {
    const op = (floor.openings || []).find((x) => x.id === sel.id);
    if (!op) { body.textContent = '—'; return; }
    const def = getOpeningType(op.type);
    const wall = floor.walls?.find((w) => w.id === op.wallId);
    const wallLen = wall ? Math.round(Math.hypot(
      wall.end.x - wall.start.x, wall.end.z - wall.start.z,
    )) : 0;

    body.appendChild(readonlyRow('種類', def.name));
    if (wallLen > 0) body.appendChild(readonlyRow('壁長さ', `${wallLen}mm`));

    if (op.type === 'door') {
      // ドア：開き方反転のみ（サイズ変更なし）
      const flipWrap = document.createElement('div');
      flipWrap.className = 'btn-row';
      const lr = document.createElement('button');
      lr.className = 'btn';
      lr.textContent = '左右反転';
      lr.addEventListener('click', () => editor.toggleDoorFlip('flipLR'));
      const ud = document.createElement('button');
      ud.className = 'btn';
      ud.textContent = '上下反転';
      ud.addEventListener('click', () => editor.toggleDoorFlip('flipUD'));
      flipWrap.append(lr, ud);
      body.appendChild(field('開き方', flipWrap));
    } else {
      // 窓・掃き出し窓：幅・腰高・開口高
      body.appendChild(field('幅 (mm)', inputNumber(op.widthMM, (v) => {
        editor.applyToSelection((o) => {
          o.widthMM = Math.max(100, v);
          if (wall) {
            const halfW = o.widthMM / 2;
            o.offsetMM = Math.max(halfW, Math.min(wallLen - halfW, o.offsetMM));
          }
        });
      })));
      body.appendChild(field('腰高 (mm)', inputNumber(op.sillMM, (v) => {
        editor.applyToSelection((o) => { o.sillMM = Math.max(0, v); });
      })));
      body.appendChild(field('開口高 (mm)', inputNumber(op.heightMM, (v) => {
        editor.applyToSelection((o) => { o.heightMM = Math.max(100, v); });
      })));
    }
    body.appendChild(readonlyRow('壁中心からの距離', `${Math.round(op.offsetMM)}mm`));

    body.appendChild(deleteButton('この建具を削除'));
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
function inputNumber(value, onChange) {
  const i = document.createElement('input');
  i.type = 'number'; i.value = value; i.step = '10'; i.min = '0';
  i.addEventListener('change', () => { const v = Number(i.value); if (!Number.isNaN(v)) onChange(v); });
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
    <div><span>建具数</span><b>${(floor.openings || []).length}</b></div>
    <div><span>床面積合計</span><b>${M.formatAreaLabel(total, tatami)}</b></div>
  `;
}

function syncLowerFloorRefToggle() {
  const row = $('#lower-floor-ref-row');
  const el = $('#lower-floor-ref-toggle');
  if (!row || !el) return;
  const plan = store.current();
  const cur = M.getFloor(plan, ui.floorId);
  const hasLower = plan.floors.some((f) => f.level === cur.level - 1);
  row.hidden = !hasLower;
  el.checked = !!ui.showLowerFloorRef;
}

function syncSnapButtons() {
  const div = store.current().meta.snapDivisions || 4;
  document.querySelectorAll('#snap-group .seg-btn').forEach((b) =>
    b.classList.toggle('active', Number(b.dataset.snap) === div));
  const dimEl = $('#dim-toggle');
  if (dimEl) dimEl.checked = !!ui.showDimensions;
}

function reconcileSelection(sel) {
  if (!sel) return null;
  const floor = M.getFloor(store.current(), ui.floorId);
  if (sel.kind === 'room') {
    return floor.rooms.some((r) => r.id === sel.id) ? sel : null;
  }
  if (sel.kind === 'furniture') {
    return floor.furniture.some((f) => f.id === sel.id) ? sel : null;
  }
  if (sel.kind === 'stair') {
    return (floor.stairs || []).some((s) => s.id === sel.id) ? sel : null;
  }
  if (sel.kind === 'opening') {
    return (floor.openings || []).some((o) => o.id === sel.id) ? sel : null;
  }
  return null;
}

function afterHistoryChange() {
  ui.selection = reconcileSelection(ui.selection);
  refreshPanels();
  recomputeDaylight();
  if (ui.view === '2d') editor.draw();
  if (ui.view === '3d') viewer.rebuild();
}

function isEditorTypingTarget(e) {
  const tag = e.target?.tagName || '';
  return /^(INPUT|SELECT|TEXTAREA)$/.test(tag) || e.target?.isContentEditable;
}

function updateHint() {
  const hint = $('#hint');
  if (ui.view === '3d') {
    hint.textContent = ui.view3dAllFloors
      ? '全階表示中。フロア切替または全階表示ボタンで現在階のみに戻せます。ドラッグで回転 / ホイールでズーム'
      : `${ui.floorId} のみ表示中。全階表示ボタンですべての階を積み上げ表示。ドラッグで回転 / ホイールでズーム`;
    return;
  }
  if (ui.bgCalib) {
    hint.textContent = '基準線モード：寸法のわかる2点を下絵上でクリックしてください';
    return;
  }
  const map = {
    select: '選択：クリックで選択/ドラッグで移動。⌘C/V/Z でコピー/貼付/元に戻す。部屋：辺ドラッグでサイズ変更、辺右クリック→頂点追加、橙頂点右クリック→削除。階段・ドアは緑丸で90°回転。短クリック/右クリック→操作メニュー',
    room: 'ドラッグで部屋を矩形作成（スナップ適用）。完了後は自動で選択モードへ',
    furniture: 'クリックで家具を配置。完了後は自動で選択モードへ',
    stair: 'クリックで階段を配置。完了後は自動で選択モードへ。辺ドラッグでサイズ変更 / 緑丸ドラッグで90°回転',
    opening: '壁をクリックで建具を配置。ドア選択時は緑丸ドラッグで90°刻みの開き方向変更。短クリック/右クリック→操作メニュー',
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
  $('#view3d-all-floors').addEventListener('click', () => {
    setView3dAllFloors(!ui.view3dAllFloors);
  });
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

  $('#dim-toggle').addEventListener('change', (e) => {
    ui.showDimensions = e.target.checked;
    editor.draw();
  });

  $('#lower-floor-ref-toggle').addEventListener('change', (e) => {
    ui.showLowerFloorRef = e.target.checked;
    editor.draw();
  });

  $('#zoom-fit').addEventListener('click', () => {
    if (ui.view === '2d') editor.zoomFit();
    else viewer.resetView();
  });

  $('#back-to-list').addEventListener('click', () => returnToPlanList());

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
      openPlanEditor(store.currentId);
    } catch (err) {
      await showAlert({ title: 'JSON読込', message: 'JSON の読み込みに失敗しました: ' + err.message });
    }
    e.target.value = '';
  });

  // リサイズ（編集画面が非表示のときはスキップ — 0px で上書きされるのを防ぐ）
  window.addEventListener('resize', () => {
    if (screen !== 'editor' || ui.view !== '2d') return;
    editor.resize();
  });

  // 編集ショートカット（⌘/Ctrl+C V Z）
  window.addEventListener('keydown', (e) => {
    if (screen !== 'editor' || isEditorTypingTarget(e)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;

    const key = e.key.toLowerCase();
    if (key === 'z') {
      e.preventDefault();
      if (e.shiftKey) {
        if (store.redo()) afterHistoryChange();
      } else if (store.undo()) {
        afterHistoryChange();
      }
      return;
    }
    if (key === 'y') {
      e.preventDefault();
      if (store.redo()) afterHistoryChange();
      return;
    }
    if (ui.view !== '2d' || !editor.active) return;
    if (key === 'c') {
      if (editor.copySelection()) e.preventDefault();
    } else if (key === 'v') {
      if (editor.pasteSelection()) e.preventDefault();
    }
  });
}

function afterPlanChange() {
  ui.selection = null;
  ui.floorId = '1F';
  ui.bgCalib = false;
  editor.invalidateBgImage();
  setFloor('1F');
  viewer._fitted = false;
  refreshPanels();
  syncSunPanel();
  recomputeDaylight();
}

// ---- store 購読: データ変更時に各所を更新 ----------------------------------
store.subscribe(() => {
  if (screen === 'editor') {
    refreshPanels();
    recomputeDaylight();
    if (ui.view === '3d') updateSunInfo();
  }
});

// ---- 起動 -------------------------------------------------------------------
function boot() {
  buildRoomChips();
  buildStairChips();
  buildOpeningChips();
  buildPlumbingChips();
  buildFurnitureChips();
  buildExteriorChips();
  wireCollapsiblePanes();
  buildSunStatics();
  wireEvents();
  wireSunPanel();
  wireBgPanel();

  planList = new PlanList(store, {
    onOpen: (id) => openPlanEditor(id),
  });

  setTool('select');
  setFloor('1F');
  setView('2d');
  markChips();
  showPlanList();
}

boot();
