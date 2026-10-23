// siteOrientation.js（下絵の回転・方位）の単体テスト。実行: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../js/siteOrientation.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('rotatePointAbout は画面上で時計回り（右→下）', () => {
  const p = O.rotatePointAbout({ x: 10, z: 0 }, { x: 0, z: 0 }, 90);
  near(p.x, 0); near(p.z, 10);
});

test('straightenDeltaDeg は近いほうの水平/垂直へ', () => {
  near(O.straightenDeltaDeg({ x: 0, z: 0 }, { x: 100, z: 10 }), -Math.atan2(10, 100) * 180 / Math.PI);
  // 右下がり 80° → 垂直にするには +10°
  const a = { x: 0, z: 0 };
  const b = { x: Math.cos(80 * Math.PI / 180), z: Math.sin(80 * Math.PI / 180) };
  near(O.straightenDeltaDeg(a, b), 10);
  near(O.straightenDeltaDeg(a, { x: 5, z: 0 }), 0);
  assert.equal(O.straightenDeltaDeg(a, a), null);
  // 回したあとは本当に水平になる
  const p = { x: 1000, z: 300 };
  const d = O.straightenDeltaDeg(a, p);
  near(O.rotatePointAbout(p, a, d).z, 0);
});

test('azimuthFromNorthLine: 上=0, 右=90, 左=270', () => {
  near(O.azimuthFromNorthLine({ x: 0, z: 0 }, { x: 0, z: -10 }), 0);
  near(O.azimuthFromNorthLine({ x: 0, z: 0 }, { x: 10, z: 0 }), 90);
  near(O.azimuthFromNorthLine({ x: 0, z: 0 }, { x: -10, z: 0 }), 270);
  near(O.azimuthFromNorthLine({ x: 0, z: 0 }, { x: 10, z: -10 }), 45);
});

test('rotateSiteAbout: pivot は動かず、下絵・敷地・方位が一緒に回る', () => {
  const site = {
    azimuth: 350,
    boundary: [{ x: 0, z: 0 }, { x: 1000, z: 0 }, { x: 1000, z: 1000 }],
    backgroundImage: {
      naturalWidthPx: 200, naturalHeightPx: 100, scaleMMperPx: 10,
      offsetX: 0, offsetZ: 0, rotationDeg: 0,
    },
  };
  const pivot = { x: 300, z: 200 };
  // 回転前に pivot が下絵のどの画素にあるか
  const bg = site.backgroundImage;
  const toPixel = () => {
    const c = O.backgroundCenter(bg);
    const local = O.rotatePointAbout(pivot, c, -bg.rotationDeg);
    return { px: (local.x - c.x) / bg.scaleMMperPx + 100, py: (local.z - c.z) / bg.scaleMMperPx + 50 };
  };
  const before = toPixel();
  O.rotateSiteAbout(site, pivot, 20);
  const after = toPixel();
  near(before.px, after.px); near(before.py, after.py);
  near(bg.rotationDeg, 20);
  near(site.azimuth, 10);
  const q = O.rotatePointAbout({ x: 1000, z: 0 }, pivot, 20);
  near(site.boundary[1].x, q.x); near(site.boundary[1].z, q.z);
});

test('azimuthLabel', () => {
  assert.equal(O.azimuthLabel(0), '真上が北');
  assert.equal(O.azimuthLabel(30), '北は上から右へ 30°');
  assert.equal(O.azimuthLabel(330), '北は上から左へ 30°');
  assert.equal(O.azimuthLabel(349.9 + 19.7), '北は上から右へ 9.6°');
  assert.equal(O.azimuthLabel(359.99), '真上が北');
});
