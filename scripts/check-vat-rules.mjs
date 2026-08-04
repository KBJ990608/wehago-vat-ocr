import assert from 'node:assert/strict';

const {
  judgeVat,
  normalizeNtsStatus,
  normalizeBusinessType,
  isClearlyTaxExemptTransaction,
  hasStrongEntertainmentNonDeductiblePair,
  hasReviewRiskSignal,
  matchesDeductiblePair,
} = await import('../src/rules.js');

let passed = 0;

function baseRow(overrides) {
  return {
    '일자': '2026-01-05',
    '거래처': '테스트거래처',
    '구분': '',
    '품명': '',
    '공급가액': '',
    '세액': '',
    '비과세': '',
    '합계': '',
    '국세청': '',
    '업태': '',
    '종목': '',
    '유형': '일반',
    '차변계정': '',
    '대변계정': '카드미지급금',
    '전표상태': '전표확정',
    '사업자유형': '',
    ...overrides,
  };
}

function expectDecision(label, overrides, expected) {
  const judgement = judgeVat(baseRow(overrides));
  assert.equal(judgement.판정, expected, `${label}: ${expected}이어야 하지만 ${judgement.판정}로 판정되었습니다.`);
  // 기존 UI가 사용하는 반환 필드가 모두 채워져 있어야 한다.
  assert.equal(judgement.decision, expected);
  assert.match(judgement.신뢰도, /^\d+%$/, `${label}: 신뢰도 형식이 유지되어야 합니다.`);
  assert.ok(judgement.근거조항, `${label}: 근거조항이 있어야 합니다.`);
  assert.equal(typeof judgement.근거키워드, 'string');
  assert.equal(typeof judgement.주의, 'string');
  assert.ok(judgement['법 기준 사유'].includes('판정 근거 키워드'), `${label}: 법 기준 사유 형식이 유지되어야 합니다.`);
  passed += 1;
  return judgement;
}

// 1. 사업자유형=간이과세자 → 불공제
expectDecision('01 간이과세자', { '사업자유형': '간이과세자', '품명': '사무용 복사용지', '차변계정': '소모품비', '구분': '과세', '세액': 1000 }, '불공제');

// 2. 사업자유형=면세사업자 → 불공제
expectDecision('02 면세사업자', { '사업자유형': '면세사업자', '품명': '택배비', '차변계정': '운반비', '국세청': '공제' }, '불공제');

// 3. 국세청=당연불공제 → 불공제
expectDecision('03 당연불공제', { '국세청': '당연불공제', '품명': '택배비', '차변계정': '운반비' }, '불공제');

// 4. 구분=면세, 세액=0, 비과세=32,800 → 불공제
expectDecision('04 면세거래', { '구분': '면세', '세액': 0, '비과세': 32800, '품명': '쌀', '차변계정': '상품' }, '불공제');

// 5. 국세청=선택불공제 + 차변계정=접대비 + 품명=거래처 선물 → 불공제
expectDecision('05 선택불공제 접대비', { '국세청': '선택불공제', '차변계정': '접대비', '품명': '거래처 선물' }, '불공제');

// 6. 국세청=선택불공제 + 차변계정=차량유지비 + 품명=주유 → 검토필요
expectDecision('06 선택불공제 주유', { '국세청': '선택불공제', '차변계정': '차량유지비', '품명': '주유' }, '검토필요');

// 7. 국세청=불공제 + 차변계정=운반비 + 품명=택배비 → 검토필요
expectDecision('07 불공제 택배비', { '국세청': '불공제', '차변계정': '운반비', '품명': '택배비' }, '검토필요');

// 8. 국세청=공제 + 차변계정=접대비 + 품명=거래처 선물 → 검토필요
expectDecision('08 공제 접대비', { '국세청': '공제', '차변계정': '접대비', '품명': '거래처 선물', '구분': '과세', '세액': 5000 }, '검토필요');

// 9. 국세청=공제 + 차변계정=차량유지비 + 품명=주유 → 검토필요
expectDecision('09 공제 주유', { '국세청': '공제', '차변계정': '차량유지비', '품명': '주유', '구분': '과세', '세액': 5000 }, '검토필요');

// 10. 국세청=공제, 구분=과세, 세액=1,000, 차변계정=운반비, 품명=고객 상품 택배비 → 공제
expectDecision('10 공제 운반비', { '국세청': '공제', '구분': '과세', '세액': 1000, '차변계정': '운반비', '품명': '고객 상품 택배비' }, '공제');

// 11. 국세청=공제, 구분=과세, 세액=1,000, 차변계정=소모품비, 품명=사무용 복사용지 → 공제
expectDecision('11 공제 소모품비', { '국세청': '공제', '구분': '과세', '세액': 1000, '차변계정': '소모품비', '품명': '사무용 복사용지' }, '공제');

// 12. 국세청=공제, 구분=과세, 세액=1,000, 차변계정=운반비, 품명=거래처 선물 → 검토필요
expectDecision('12 조합 불일치', { '국세청': '공제', '구분': '과세', '세액': 1000, '차변계정': '운반비', '품명': '거래처 선물' }, '검토필요');

// 13. 국세청 빈칸, 차변계정=운반비, 품명=택배비 → 검토필요
expectDecision('13 국세청 빈칸', { '국세청': '', '차변계정': '운반비', '품명': '택배비', '구분': '과세', '세액': 1000 }, '검토필요');

// 14. '불공제' 안의 '공제' 문자열 때문에 공제로 인식되면 안 된다.
assert.equal(normalizeNtsStatus({ '국세청': '불공제' }), '불공제');
assert.equal(normalizeNtsStatus({ '국세청': '비공제' }), '불공제');
assert.equal(normalizeNtsStatus({ '국세청': '선택 불공제' }), '선택불공제');
assert.equal(normalizeNtsStatus({ '국세청': '당연 불공제' }), '당연불공제');
assert.equal(normalizeNtsStatus({ '국세청': '공제' }), '공제');
assert.equal(normalizeNtsStatus({ '국세청': '해당없음' }), '');
assert.equal(normalizeNtsStatus({ '국세청': '' }), '');
for (const status of ['불공제', '비공제', '선택불공제', '당연불공제']) {
  const judgement = judgeVat(baseRow({ '국세청': status, '구분': '과세', '세액': 1000, '차변계정': '운반비', '품명': '택배비' }));
  assert.notEqual(judgement.판정, '공제', `14: 국세청 ${status} 거래가 공제로 판정되면 안 됩니다.`);
}
passed += 1;

// 결과 칼럼이 다시 판정 입력으로 들어가지 않아야 한다(NON_INPUT_KEYS 유지).
const reJudged = judgeVat(baseRow({
  '국세청': '공제',
  '구분': '과세',
  '세액': 1000,
  '차변계정': '운반비',
  '품명': '고객 상품 택배비',
  '판정': '불공제',
  '근거키워드': '접대비, 선물, 면세',
  '법 기준 사유': '면세 재화 또는 용역은 공제되지 않습니다.',
}));
assert.equal(reJudged.판정, '공제', '결과 칼럼의 문구가 재판정에 영향을 주면 안 됩니다.');
passed += 1;

// 사업자유형 정보가 없을 때 거래처명이나 업종으로 간이·면세사업자를 추정하지 않는다.
assert.equal(normalizeBusinessType({ '거래처': '간이김밥', '종목': '면세농산물' }), '');
assert.equal(normalizeBusinessType({ '사업자유형': '간이과세자' }), '간이과세자');
assert.equal(normalizeBusinessType({ '사업자유형': '면세사업자' }), '면세사업자');
assert.equal(normalizeBusinessType({ '사업자유형': '일반과세자' }), '일반과세자');
passed += 1;

// 면세 확정은 품명 단어가 아니라 구조화된 세 조건으로만 판단한다.
assert.equal(isClearlyTaxExemptTransaction({ '구분': '면세', '세액': 0, '비과세': 32800 }), true);
assert.equal(isClearlyTaxExemptTransaction({ '구분': '과세', '품명': '쌀 농산물 꽃', '세액': 0, '비과세': 32800 }), false);
assert.equal(isClearlyTaxExemptTransaction({ '구분': '면세', '세액': 1000, '비과세': 32800 }), false);
assert.equal(isClearlyTaxExemptTransaction({ '구분': '면세', '세액': 0, '비과세': 0 }), false);
assert.equal(judgeVat(baseRow({ '품명': '쌀 화환 농산물', '구분': '과세', '국세청': '' })).판정, '검토필요');
passed += 1;

// 헬퍼가 사전별로 분리되어 동작하는지 확인한다.
assert.equal(hasStrongEntertainmentNonDeductiblePair({ '차변계정': '접대비', '품명': '거래처 선물' }) !== null, true);
assert.equal(hasStrongEntertainmentNonDeductiblePair({ '차변계정': '운반비', '품명': '거래처 선물' }), null);
assert.equal(hasStrongEntertainmentNonDeductiblePair({ '차변계정': '접대비', '품명': '택배비' }), null);
assert.equal(hasReviewRiskSignal({ '품명': '주유' }).isVehicle, true);
assert.equal(hasReviewRiskSignal({ '품명': '복사용지' }), null);
assert.equal(matchesDeductiblePair({ '품명': '택배비', '차변계정': '운반비' }).label, '배송·운반');
assert.equal(matchesDeductiblePair({ '품명': '택배비', '차변계정': '접대비' }), null);
assert.equal(matchesDeductiblePair({ '품명': '거래처 선물', '차변계정': '운반비' }), null);
passed += 1;

// 신뢰도는 규칙별 고정 점수이므로 같은 규칙이면 항상 같은 값이어야 한다.
const first = judgeVat(baseRow({ '국세청': '공제', '구분': '과세', '세액': 1000, '차변계정': '통신비', '품명': '인터넷 요금' }));
const second = judgeVat(baseRow({ '국세청': '공제', '구분': '과세', '세액': 99000, '차변계정': '통신비', '품명': '전화 요금' }));
assert.equal(first.판정, '공제');
assert.equal(first.신뢰도, second.신뢰도);
passed += 1;

console.log(`vat rule checks: ${passed} passed`);
