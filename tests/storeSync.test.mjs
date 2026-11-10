// 複数の窓での保存・容量超過・画像の移動・バックアップの確認（模擬ストレージで実行）
import test from 'node:test';
import assert from 'node:assert/strict';

const LS_KEY = 'myhome-clone:v1';
let quota = Infinity;
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    if (v.length > quota) throw new Error('QuotaExceededError');
    mem.set(k, v);
  },
};
console.warn = () => {};

const { Store, selectBackupsToDrop } = await import('../js/store.js');

function fakeDb({ failImages = false } = {}) {
  const images = new Map();
  let backups = [];
  return {
    images,
    getImage: async (id) => images.get(id) ?? null,
    putImage: async (id, url) => { if (failImages) return false; images.set(id, url); return true; },
    listImageMeta: async () => [...images.keys()].map((id) => ({ id, savedAt: 0 })),
    deleteImages: async (ids) => ids.forEach((id) => images.delete(id)),
    addBackup: async (b) => { backups.push(b); return true; },
    listBackups: async () => backups.slice().sort((a, b) => b.savedAt - a.savedAt),
    deleteBackups: async (ts) => { backups = backups.filter((b) => !ts.includes(b.savedAt)); },
  };
}
const open = (db = fakeDb()) => new Store({ images: new Map(db.images), db });
const savedNames = () => {
  const r = JSON.parse(mem.get(LS_KEY));
  return r.order.map((i) => r.plans[i].meta.name);
};
const flush = () => new Promise((r) => setTimeout(r, 0));
const reset = () => { mem.clear(); quota = Infinity; };
const bgImage = (size) => ({ dataUrl: `data:image/jpeg;base64,${'A'.repeat(size)}`, naturalWidthPx: 1, naturalHeightPx: 1 });

test('古い窓で編集しても、別の窓で作ったプランは消えない', () => {
  reset();
  const a = open();
  const b = open();
  b.newPlan('窓Bの新プラン');
  a.updatePlanMeta({ memo: '窓Aの編集' });
  assert.ok(savedNames().includes('窓Bの新プラン'));
  assert.ok(a.list().some((p) => p.name === '窓Bの新プラン'));
  const reopened = open();
  assert.equal(reopened.plans[a.order.at(-1)].meta.memo, '窓Aの編集');
});

test('別々のプランを別の窓で編集すると、両方の変更が残る', async () => {
  reset();
  const a = open();
  const p2 = a.newPlan('P2');
  const p1 = a.order[1];
  const b = open();
  b.select(p1);
  a.select(p2);
  await new Promise((r) => setTimeout(r, 2));
  a.updatePlanMeta({ memo: 'P2の編集' }, p2);
  await new Promise((r) => setTimeout(r, 2));
  b.updatePlanMeta({ memo: 'P1の編集' }, p1);
  const r = open();
  assert.equal(r.plans[p1].meta.memo, 'P1の編集');
  assert.equal(r.plans[p2].meta.memo, 'P2の編集');
});

test('別の窓で削除したプランが、古い窓の保存で復活しない', () => {
  reset();
  const a = open();
  const p2 = a.newPlan('消すプラン');
  const keep = a.newPlan('残すプラン');
  const b = open();
  b.deletePlan(p2);
  a.select(keep);
  a.updatePlanMeta({ memo: 'x' }, keep);
  assert.ok(!savedNames().includes('消すプラン'));
});

test('別の窓の変更を受け取ると表示用のデータも更新される', () => {
  reset();
  const a = open();
  const b = open();
  let notified = 0;
  a.subscribe(() => { notified++; });
  b.newPlan('新');
  a.syncFromOtherWindows({ protectCurrent: true });
  assert.ok(a.list().some((p) => p.name === '新'));
  assert.equal(notified, 1);
});

test('容量超過の警告が出て、次の保存が成功すると消える', () => {
  reset();
  const db = fakeDb({ failImages: true });
  const s = open(db);
  const changes = [];
  s.onSaveErrorChange = (e) => changes.push(!!e);
  quota = mem.get(LS_KEY).length + 1000;
  s.newPlan('A'.repeat(5000));
  assert.ok(s.saveError);
  quota = Infinity;
  s.save();
  assert.equal(s.saveError, null);
  assert.deepEqual(changes, [true, false]);
  assert.equal(savedNames().length, 2);
});

test('保存に失敗した間に作ったプランは、他の窓の保存があっても手元から消えない', () => {
  reset();
  const s = open();
  const other = open();
  const size = mem.get(LS_KEY).length;
  quota = size + 200;
  const id = s.newPlan('X'.repeat(1000));
  other.renamePlan('短');
  s.save();
  assert.ok(s.plans[id]);
  quota = Infinity;
  s.save();
  assert.ok(savedNames().includes('X'.repeat(1000)));
});

test('下絵は IndexedDB へ移り、LocalStorage には参照だけが残る', async () => {
  reset();
  const db = fakeDb();
  const s = open(db);
  s.update((p) => { p.site.backgroundImage = bgImage(100000); });
  assert.ok(mem.get(LS_KEY).length > 100000, '書き込み完了までは本体を保持');
  await flush();
  assert.ok(mem.get(LS_KEY).length < 20000, '完了後は参照のみ');
  assert.equal(db.images.size, 1);
  const r = open(db);
  assert.equal(r.current().site.backgroundImage.dataUrl.length, bgImage(100000).dataUrl.length);
});

test('従来の画像入りデータは読み込み後の保存で移行され、画像は失われない', async () => {
  reset();
  const first = open();
  first.update((p) => { p.site.backgroundImage = bgImage(50000); });
  assert.ok(mem.get(LS_KEY).includes('AAAA'));
  const db = fakeDb();
  const s = open(db);
  s.save();
  await flush();
  assert.ok(!mem.get(LS_KEY).includes('AAAA'));
  assert.ok(open(db).current().site.backgroundImage.dataUrl);
});

test('IndexedDB が使えないときは画像を LocalStorage に持ち続ける', async () => {
  reset();
  const db = fakeDb({ failImages: true });
  const s = open(db);
  s.update((p) => { p.site.backgroundImage = bgImage(50000); });
  await flush();
  assert.ok(mem.get(LS_KEY).includes('AAAA'));
  assert.ok(open(db).current().site.backgroundImage.dataUrl);
});

test('画像が読めなくても参照は保存で失われない', async () => {
  reset();
  const db = fakeDb();
  const s = open(db);
  s.update((p) => { p.site.backgroundImage = bgImage(1000); });
  await flush();
  const noImages = fakeDb();
  const t = open(noImages);
  assert.ok(!t.current().site.backgroundImage.dataUrl);
  t.update((p) => { p.meta.memo = 'x'; });
  const again = open(db);
  assert.ok(again.current().site.backgroundImage.dataUrl);
});

test('削除の前にバックアップが取られ、別プランとして復元できる', async () => {
  reset();
  const db = fakeDb();
  const s = open(db);
  const id = s.newPlan('大事なプラン');
  s.newPlan('別のプラン');
  await new Promise((r) => setTimeout(r, 2));
  s.deletePlan(id);
  await flush();
  const list = await s.listBackups();
  const backup = list.find((b) => b.plans.some((p) => p.id === id));
  assert.ok(backup);
  const restored = await s.restorePlanFromBackup(backup.savedAt, id);
  assert.equal(s.plans[restored].meta.name, '大事なプラン（復元）');
  assert.ok(savedNames().includes('大事なプラン（復元）'));
  assert.equal(s.order[0], restored);
});

test('バックアップの間引き: 最新10件と直近14日の各日の最新を残す', () => {
  const now = new Date(2026, 10, 10, 12).getTime();
  const hour = 3600e3;
  const times = Array.from({ length: 24 * 20 }, (_, i) => now - i * hour);
  const drop = new Set(selectBackupsToDrop(times, now));
  const kept = times.filter((t) => !drop.has(t));
  assert.ok(times.slice(0, 10).every((t) => !drop.has(t)));
  assert.ok(kept.every((t) => t >= now - 14 * 24 * hour || times.indexOf(t) < 10));
  assert.ok(kept.length >= 14 && kept.length <= 25);
});
