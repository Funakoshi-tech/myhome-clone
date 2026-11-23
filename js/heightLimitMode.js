// heightLimitMode.js — 高さ制限（北側斜線・高度地区）の左パネル
//
// 計算は heightLimit.js（純関数）。設定は plan.site.heightLimit に保存する（取り消し履歴に積む）。
// 土地選びの目安なので、結果は「北端から○m 以上なら置ける」と書き、「入らない」とは言い切らない。
// 2D 図面への重ね描きはフェーズ 3 で足す。

import * as H from './heightLimit.js';
import * as SITE from './sitePolygon.js';

const $ = (sel) => document.querySelector(sel);

const fmtM = (mm) => `${(mm / 1000).toFixed(2)}m`;
const fmtHeight = (mm) => `${(Math.round(mm / 10) / 100).toString()}m`;

/** 必要な距離の表示（0 = どこでも置ける、Infinity = 絶対高さを超える） */
function fmtDistance(mm, absMaxMM) {
  if (mm === Infinity) return `絶対高さ ${fmtHeight(absMaxMM)} 超え`;
  if (mm <= 0) return '制限なし';
  return `${fmtM(Math.ceil(mm / 10) * 10)} 以上`;
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

export class HeightLimitController {
  /**
   * @param {object} deps
   * @param {import('./store.js').Store} deps.store
   * @param {object} deps.ui
   * @param {(floorId: string) => void} deps.setFloor
   */
  constructor({ store, ui, setFloor }) {
    this.store = store;
    this.ui = ui;
    this.setFloor = setFloor;
    this._wirePanel();
  }

  // ---- データ ---------------------------------------------------------------

  _plan() { return this.store.current(); }

  settings() {
    return H.normalizeHeightLimit(this._plan()?.site?.heightLimit);
  }

  /** 設定を書き換えて保存する（取り消し履歴に積む） */
  _update(mutator) {
    this.store.update((plan) => {
      const s = H.normalizeHeightLimit(plan.site.heightLimit);
      mutator(s);
      plan.site.heightLimit = H.normalizeHeightLimit(s);
    });
  }

  /** 表示に使う階（level の昇順） */
  _floors() {
    return [...(this._plan()?.floors || [])].sort((a, b) => (a.level || 0) - (b.level || 0));
  }

  // ---- 左パネル ---------------------------------------------------------------

  _wirePanel() {
    const zone = $('#hl-zone');
    for (const z of H.ZONE_PRESETS) zone.appendChild(option(z.id, z.name));
    const lowMax = $('#hl-lowrise-max');
    for (const v of H.LOW_RISE_ABS_MAX_OPTIONS_MM) lowMax.appendChild(option(String(v), `${v / 1000}m`));
    const dist = $('#hl-district');
    const kinds = H.DISTRICT_PRESETS[H.DEFAULT_CITY].kinds;
    dist.appendChild(option('none', 'なし（斜線なし）'));
    for (const k of kinds) dist.appendChild(option(k.id, k.name));
    dist.appendChild(option('custom', '自分で入力'));

    $('#hl-enabled').addEventListener('change', (e) => this._update((s) => { s.enabled = e.target.checked; }));
    zone.addEventListener('change', () => this._update((s) => { s.zoneId = zone.value; }));
    lowMax.addEventListener('change', () => this._update((s) => { s.lowRiseAbsMaxMM = Number(lowMax.value); }));
    $('#hl-shadow').addEventListener('change', (e) => this._update((s) => { s.shadowRegulated = e.target.checked; }));
    dist.addEventListener('change', () => this._update((s) => {
      const kind = dist.value;
      s.district.kind = kind;
      const preset = kinds.find((k) => k.id === kind);
      // 種類を替えたら絶対高さはその種類の選択肢に合わせる（不正な値は正規化で先頭になる）
      if (preset && !preset.maxHeightOptionsMM.includes(s.district.maxHeightMM)) s.district.maxHeightMM = preset.maxHeightOptionsMM[0];
      if (kind === 'custom' && !s.district.custom) {
        // 初期値は第 2 種と同じ式（立ち上がり 5m、8m まで 1.25、その先 0.6）
        s.district.custom = [
          { fromMM: 0, baseMM: 5000, slope: 1.25 },
          { fromMM: 8000, baseMM: 15000, slope: 0.6 },
        ];
      }
    }));
    $('#hl-district-max').addEventListener('change', (e) => this._update((s) => {
      s.district.maxHeightMM = e.target.value === '' ? null : Number(e.target.value);
    }));
    $('#hl-free-max').addEventListener('change', (e) => this._update((s) => {
      const v = e.target.value.trim();
      s.district.maxHeightMM = v === '' ? null : Number(v);
    }));
    for (const id of ['#hl-custom-base', '#hl-custom-slope', '#hl-custom-switch', '#hl-custom-slope2']) {
      $(id).addEventListener('change', () => this._updateCustom());
    }

    $('#hl-build-reset').addEventListener('click', () => this._update((s) => { s.build = H.defaultBuild(); }));
    $('#hl-margin').addEventListener('change', (e) => this._update((s) => { s.marginMM = Number(e.target.value) || 0; }));
    $('#hl-show-2d').addEventListener('change', (e) => this._update((s) => { s.show.contour2d = e.target.checked; }));

    // 各階の高さの表（入力は表を作り直すたびに付け直さないよう、表に 1 つだけ付ける）
    $('#hl-build').addEventListener('change', (e) => {
      const input = e.target.closest('input[data-set]');
      if (!input) return;
      const set = input.dataset.set; // 'low' | 'standard'
      const v = Number(input.value);
      if (!Number.isFinite(v) || input.value.trim() === '') { this.syncPanel(); return; }
      this._update((s) => {
        const b = s.build[set];
        if (input.dataset.field === 'ground') {
          b.groundToFirstFloorMM = v;
          return;
        }
        const i = Number(input.dataset.index);
        // 足りない階の分は最後の値で埋めてから書く
        while (b.storyHeightsMM.length <= i) b.storyHeightsMM.push(b.storyHeightsMM[b.storyHeightsMM.length - 1]);
        b.storyHeightsMM[i] = v;
      });
    });

    // 結果の行をクリックするとその階へ
    $('#hl-result').addEventListener('click', (e) => {
      const tr = e.target.closest('tr[data-floor]');
      if (tr) this.setFloor(tr.dataset.floor);
    });
  }

  /** 「自分で入力」の 4 つの数値から segments を作る（切替距離が空なら 1 本） */
  _updateCustom() {
    const num = (id) => {
      const v = $(id).value.trim();
      return v === '' ? null : Number(v);
    };
    const base = num('#hl-custom-base');
    const slope = num('#hl-custom-slope');
    const sw = num('#hl-custom-switch');
    const slope2 = num('#hl-custom-slope2');
    if (base === null || slope === null) { this.syncPanel(); return; }
    const segs = [{ fromMM: 0, baseMM: base, slope }];
    // 切替後は切替点で高さがつながるようにする
    if (sw !== null && sw > 0) segs.push({ fromMM: sw, baseMM: base + slope * sw, slope: slope2 ?? slope });
    this._update((s) => { s.district.custom = segs; });
  }

  _setValue(el, value) {
    if (document.activeElement !== el) el.value = value;
  }

  _syncBuildTable(s, floors) {
    const table = $('#hl-build');
    if (table.contains(document.activeElement)) return; // 入力中は作り直さない
    const rows = [];
    rows.push('<tr><th></th><th class="hl-low">低め（赤）</th><th class="hl-std">標準（黄）</th></tr>');
    const cell = (set, field, index, value) =>
      `<td><input type="number" min="0" max="${field === 'ground' ? H.MAX_GROUND_TO_FIRST_FLOOR_MM : H.MAX_STORY_HEIGHT_MM}" step="10"`
      + ` data-set="${set}" data-field="${field}" data-index="${index}" value="${value}" /></td>`;
    rows.push(`<tr><th>GL → 1FL</th>${cell('low', 'ground', 0, s.build.low.groundToFirstFloorMM)}${cell('standard', 'ground', 0, s.build.standard.groundToFirstFloorMM)}</tr>`);
    const story = (set, i) => {
      const hs = s.build[set].storyHeightsMM;
      return hs[Math.min(i, hs.length - 1)];
    };
    floors.forEach((f, i) => {
      const label = i === floors.length - 1 ? `${f.id} 床 → 軒` : `${f.id} 階高`;
      rows.push(`<tr><th>${label}</th>${cell('low', 'story', i, story('low', i))}${cell('standard', 'story', i, story('standard', i))}</tr>`);
    });
    table.innerHTML = rows.join('');
  }

  _syncResult(s, floors) {
    const plan = this._plan();
    const rules = H.resolveRules(s);
    const res = H.floorClearances(plan, s);
    const byLevel = new Map(res.map((r) => [r.level, r]));
    const rows = ['<tr><th>階</th><th>壁上端<br><small>低め / 標準</small></th><th class="hl-low">赤</th><th class="hl-std">黄</th></tr>'];
    // 上の階から並べる（厳しい階が先に目に入るように）
    for (const f of [...floors].reverse()) {
      const r = byLevel.get(f.level || 0);
      if (!r) continue;
      const cur = f.id === this.ui.floorId ? ' class="current"' : '';
      rows.push(`<tr data-floor="${f.id}"${cur} title="クリックでこの階を表示">`
        + `<td>${f.id}</td>`
        + `<td>${fmtHeight(r.low.topMM)} / ${fmtHeight(r.standard.topMM)}</td>`
        + `<td class="hl-low">${fmtDistance(r.low.fromSiteMM, rules.absMaxMM)}</td>`
        + `<td class="hl-std">${fmtDistance(r.standard.fromSiteMM, rules.absMaxMM)}</td></tr>`);
    }
    $('#hl-result').innerHTML = rows.join('');

    const zone = H.ZONE_PRESETS.find((z) => z.id === s.zoneId);
    const district = s.district.kind === 'none'
      ? '高度地区なし'
      : (s.district.kind === 'custom' ? '高度地区（自分で入力）' : H.DISTRICT_PRESETS[s.district.city].kinds.find((k) => k.id === s.district.kind).name);
    const maxH = s.district.maxHeightMM !== null ? `・${s.district.maxHeightMM / 1000}m` : '';
    const north = rules.north ? '' : (zone.north ? '・北側斜線は適用除外' : '');
    const lo = s.build.low, st = s.build.standard;
    $('#hl-assumption').textContent = `前提: ${zone.name}${north}、${district}${maxH}。`
      + `低め 1FL ${lo.groundToFirstFloorMM}・階高 ${lo.storyHeightsMM[0]}、標準 1FL ${st.groundToFirstFloorMM}・階高 ${st.storyHeightsMM[0]}（mm）、余白 ${s.marginMM}。`
      + `距離は真北方向に測り、${this._roadAssumption()}。`;
  }

  /** 前面道路が北側にあるか（plan.site.road を使う。道路の選択は駐車シミュレーター側） */
  _roadInfo() {
    const site = this._plan()?.site;
    const boundary = site?.boundary || [];
    if (!SITE.isValidSite(boundary)) return { hasSite: false };
    const road = H.roadForLimit(site.road, boundary);
    if (!road) return { hasSite: true, road: null };
    return { hasSite: true, road, north: H.northRoadOffset(site) };
  }

  _roadAssumption() {
    const info = this._roadInfo();
    if (info.north) {
      const slant = Math.abs(info.north.offsetMM - info.north.widthMM) >= 10 ? `、真北方向に ${fmtM(info.north.offsetMM)}` : '';
      return `北側の道路（幅員 ${fmtM(info.north.widthMM)}${slant}）の分を差し引いた、敷地の北端からの距離`;
    }
    return '北側は隣地として計算';
  }

  _syncRoadStatus() {
    const info = this._roadInfo();
    const el = $('#hl-road-status');
    if (!info.hasSite) {
      el.textContent = '敷地を描くと、図面に置けない範囲を重ねられます（フェーズ 3）。上の距離は敷地がなくても出ます。';
    } else if (!info.road) {
      el.textContent = '前面道路が未設定です。北側が道路なら、駐車シミュレーターで道路を設定してください（未設定だと北側は隣地として計算し、実際より厳しく出ます）。';
    } else if (info.north) {
      el.textContent = `北側の道路: あり（幅員 ${fmtM(info.road.widthMM)}）。斜線は道路の反対側の境界から測り、下の表は道路の分を引いた敷地の北端からの距離です。`;
    } else {
      el.textContent = '北側の道路: なし（前面道路は北側以外。北側は隣地として計算）。';
    }
  }

  /** main.js の refreshPanels から呼ばれる */
  syncPanel() {
    if (!this._plan()) return;
    const s = this.settings();
    const floors = this._floors();
    $('#hl-enabled').checked = s.enabled;
    $('#hl-detail').hidden = !s.enabled;
    if (!s.enabled) return;

    const zone = H.ZONE_PRESETS.find((z) => z.id === s.zoneId);
    $('#hl-zone').value = s.zoneId;
    $('#hl-lowrise-row').hidden = !zone.lowRise;
    $('#hl-lowrise-max').value = String(s.lowRiseAbsMaxMM);
    $('#hl-shadow-row').hidden = !zone.midRise;
    $('#hl-shadow').checked = s.shadowRegulated;
    $('#hl-shadow-note').hidden = !(zone.midRise && s.shadowRegulated);

    $('#hl-district').value = s.district.kind;
    const preset = H.DISTRICT_PRESETS[s.district.city].kinds.find((k) => k.id === s.district.kind);
    $('#hl-district-max-row').hidden = !preset;
    $('#hl-free-max-row').hidden = !!preset;
    if (preset) {
      const sel = $('#hl-district-max');
      sel.innerHTML = '';
      for (const v of preset.maxHeightOptionsMM) sel.appendChild(option(v === null ? '' : String(v), v === null ? 'なし' : `${v / 1000}m`));
      sel.value = s.district.maxHeightMM === null ? '' : String(s.district.maxHeightMM);
    } else {
      this._setValue($('#hl-free-max'), s.district.maxHeightMM ?? '');
    }
    $('#hl-custom').hidden = s.district.kind !== 'custom';
    if (s.district.kind === 'custom' && s.district.custom) {
      const [a, b] = s.district.custom;
      this._setValue($('#hl-custom-base'), a.baseMM);
      this._setValue($('#hl-custom-slope'), a.slope);
      this._setValue($('#hl-custom-switch'), b ? b.fromMM : '');
      this._setValue($('#hl-custom-slope2'), b ? b.slope : '');
      $('#hl-custom-slope2-row').hidden = !b;
    }

    this._syncBuildTable(s, floors);
    this._setValue($('#hl-margin'), s.marginMM);
    $('#hl-show-2d').checked = s.show.contour2d;
    this._syncRoadStatus();
    this._syncResult(s, floors);
  }
}
