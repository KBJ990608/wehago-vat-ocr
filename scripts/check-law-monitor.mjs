import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';

globalThis.crypto ??= webcrypto;
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const { DEFAULT_LAW_BASELINE } = await import('../src/lawBaseline.js');
const {
  applyLawChangeGuard,
  approveCurrentLawSnapshot,
  compareLawSnapshots,
  prepareLawSnapshots,
  readApprovedBaseline,
  resetApprovedLawSnapshot,
} = await import('../src/lawChangeMonitor.js');
const { judgeVat } = await import('../src/rules.js');

const preparedBaseline = await prepareLawSnapshots(DEFAULT_LAW_BASELINE);
for (const snapshot of preparedBaseline) {
  const expected = DEFAULT_LAW_BASELINE.find((item) => item.key === snapshot.key);
  assert.equal(snapshot.hash, expected.hash, `${snapshot.key} 기준 해시가 내용과 일치해야 합니다.`);
}

const unchanged = compareLawSnapshots(DEFAULT_LAW_BASELINE, preparedBaseline);
assert.equal(unchanged.every((item) => item.status === 'unchanged'), true);

const simulated = compareLawSnapshots(DEFAULT_LAW_BASELINE, preparedBaseline, { simulate: true });
assert.deepEqual(simulated.filter((item) => item.status === 'changed').map((item) => item.key), ['vat-act-39']);

const entertainmentRow = { 품명: '거래처 선물 접대비', 국세청: '불공제', 공급가액: 100000, 세액: 10000 };
const original = judgeVat(entertainmentRow);
const guarded = applyLawChangeGuard(entertainmentRow, original, simulated);
assert.equal(original.판정, '불공제');
assert.equal(guarded.판정, '검토필요');
assert.equal(guarded._lawGuard.originalDecision, '불공제');

const unrelatedRow = { 품명: '사무용품', 국세청: '공제', 공급가액: 100000, 세액: 10000 };
const unrelatedOriginal = judgeVat(unrelatedRow);
const unrelatedGuarded = applyLawChangeGuard(unrelatedRow, unrelatedOriginal, simulated);
assert.equal(unrelatedGuarded.판정, '공제');

const manuallyApproved = applyLawChangeGuard(
  { ...entertainmentRow, _userModifiedDecision: true },
  { ...original, 판정: '공제' },
  simulated,
);
assert.equal(manuallyApproved.판정, '공제');

approveCurrentLawSnapshot(preparedBaseline);
assert.equal(readApprovedBaseline().length, 4);
assert.throws(() => approveCurrentLawSnapshot(preparedBaseline.slice(0, 3)));
resetApprovedLawSnapshot();
assert.equal(readApprovedBaseline(), DEFAULT_LAW_BASELINE);

console.log('law monitor checks: 11 passed');
