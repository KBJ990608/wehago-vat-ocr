// 매입세액 1차 판정 규칙.
//
// 이 파일에는 LLM, 머신러닝, 확률 모델이 없다. 아래 judgeVat()는 위에서부터
// 조건을 검사하고 먼저 충족된 규칙에서 즉시 반환하는 순수 규칙 기반 함수다.
// 자동 공제와 자동 불공제의 범위를 좁게 잡고, 조건이 명확하게 맞아떨어지지
// 않는 거래는 전부 '검토필요'로 남긴다.

const LEGAL_PREFIX = '부가가치세법상 매입세액 공제는 사업 관련 과세매입이고 불공제 사유가 없는 경우 인정됩니다.';
const LEGAL_BASIS = {
  generalTaxablePurchase: { label: '부가가치세법 제38조 및 제39조', articles: ['article38', 'article39'] },
  nonDeductible: { label: '부가가치세법 제39조 제1항', articles: ['article39'] },
  vehicle: { label: '부가가치세법 제39조 제1항', articles: ['article39'] },
  taxExempt: { label: '부가가치세법 제26조 및 제39조', articles: ['article26', 'article39'] },
  unrelatedBusiness: { label: '부가가치세법 제39조', articles: ['article39'] },
  review: { label: '부가가치세법 제38조 및 제39조', articles: ['article38', 'article39'] },
};

// 신뢰도는 머신러닝 확률이나 통계적 예측값이 아니다.
// 어떤 규칙에서 판정이 확정되었는지를 나타내는 고정 점수이며, 구조화된 항목이
// 모두 일치한 규칙일수록 높고 정보가 부족해 검토로 넘긴 규칙일수록 낮다.
// 같은 규칙으로 판정된 거래는 항상 같은 값을 가진다.
const CONFIDENCE = {
  supplierOrMandatory: 95, // 1순위: 사업자유형 또는 국세청 당연불공제
  clearTaxExempt: 92, // 2순위: 면세구분 + 세액 0 + 비과세 존재
  entertainmentPair: 90, // 3-1: 국세청 불공제 + 접대비 계정 + 접대성 거래내용
  ntsNonDeductibleUnclear: 50, // 3-2: 국세청 불공제이지만 근거 정보 부족
  ntsDeductibleRisk: 45, // 4-1: 국세청 공제이지만 위험 키워드 존재
  clearBusinessPurchase: 85, // 4-2: 국세청 공제 + 과세 + 세액 + 품명·계정 조합 일치
  ntsDeductibleUnclear: 45, // 4-3: 국세청 공제이지만 조합 불일치
  ntsUnknown: 35, // 5순위: 국세청 구분 없음
};

// 3-1의 조건 B. 접대성 지출임을 보여주는 거래 내용.
const ENTERTAINMENT_CONTENT_KEYWORDS = [
  '접대',
  '거래처 선물',
  '선물',
  '유흥',
  '주점',
  '룸살롱',
  '골프',
];

// 3-1의 조건 A. 접대성 지출로 처리된 계정과목.
const ENTERTAINMENT_ACCOUNT_KEYWORDS = ['접대비', '기업업무추진비'];

// 4-1. 국세청이 공제로 분류했더라도 실제 사용 목적이나 법정 불공제 여부를
// 사람이 확인해야 하는 신호. 하나라도 걸리면 자동 공제하지 않는다.
const REVIEW_RISK_KEYWORDS = [
  '접대비',
  '기업업무추진비',
  '접대',
  '선물',
  '유흥',
  '주점',
  '골프',
  '개인',
  '사적',
  '가사',
  '업무무관',
  '식대',
  '음식점',
  '식당',
  '카페',
  '커피',
  '회의비',
  '주유',
  '차량',
  '자동차',
  '렌트',
  '리스',
  '주차',
  '톨게이트',
  '숙박',
  '호텔',
  '항공',
  '여행',
  '화환',
  '꽃',
  '보험료',
  '공과금',
];

// 차량 관련 신호는 근거 조항을 제39조 제1항으로 표시하기 위해 따로 구분한다.
const VEHICLE_KEYWORDS = ['주유', '차량', '자동차', '렌트', '리스', '주차', '톨게이트'];

// 4-2. 자동 공제를 허용하는 품명·차변계정 조합.
// 품명만 맞거나 계정만 맞으면 공제하지 않는다. 같은 조합 안에서 둘 다 맞아야 한다.
const DEDUCTIBLE_PAIRS = [
  { label: '재고·원재료 매입', 품명: ['상품', '제품', '원재료', '재료'], 차변계정: ['상품', '제품', '원재료', '재료비'] },
  { label: '배송·운반', 품명: ['택배', '배송', '운송'], 차변계정: ['운반비', '배송비'] },
  { label: '사무용품', 품명: ['복사용지', '사무용품', '소모품'], 차변계정: ['소모품비', '사무용품비'] },
  { label: '통신비', 품명: ['전화', '인터넷', '통신'], 차변계정: ['통신비'] },
  { label: '인쇄·복사', 품명: ['인쇄', '복사'], 차변계정: ['인쇄비', '소모품비'] },
  { label: '광고비', 품명: ['광고', '홍보'], 차변계정: ['광고선전비'] },
];

// 판정에 사용하는 입력 항목. 이 목록 밖의 값은 판정 근거로 쓰지 않는다.
const JUDGEMENT_INPUT_KEYS = ['국세청', '사업자유형', '구분', '품명', '차변계정', '업태', '종목', '세액', '비과세'];

// 판정 결과로 생성된 칼럼은 판정 입력에서 제외한다.
// 이 칼럼들에는 '매입세액', '면세' 같은 설명 문구가 들어 있어서, 그대로 다시 넣으면
// 원본 거래에 없던 키워드가 검출되어 판정이 스스로를 되먹임한다.
const NON_INPUT_KEYS = new Set([
  'id',
  '판정', '신뢰도', '근거조항', '근거키워드', '주의', '법령근거', '법 기준 사유', '사유',
  'decision', 'confidence', 'reason', 'evidenceKeywords', 'warning', 'legalBasis',
]);

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// 판정 입력 항목 하나를 읽는다.
// 결과 칼럼과 판정 입력 목록 밖의 칼럼은 어떤 경우에도 판정 근거로 읽지 않는다.
function readInput(row, key) {
  if (NON_INPUT_KEYS.has(key) || !JUDGEMENT_INPUT_KEYS.includes(key)) return '';
  return normalizeText(row?.[key]);
}

// 공백을 제거한 비교용 문자열. '선택 불공제'처럼 띄어쓴 값도 같게 취급한다.
function compact(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function toAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const cleaned = String(value ?? '').replace(/[^\d.-]/g, '');
  if (!cleaned || /^[-.]+$/.test(cleaned)) return null;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : null;
}

// 지정한 입력 항목들에서 키워드를 찾아 [{ keyword, field }] 로 돌려준다.
// 사전을 하나로 합치지 않고 호출부마다 검사 대상 항목과 사전을 명시한다.
function findKeywordsIn(row, fields, keywords) {
  const matches = [];
  fields.forEach((field) => {
    const text = readInput(row, field).toLowerCase();
    if (!text) return;
    keywords.forEach((keyword) => {
      if (text.includes(keyword.toLowerCase())) matches.push({ keyword, field });
    });
  });
  return matches;
}

function uniqueKeywords(matches) {
  return Array.from(new Set(matches.map((match) => match.keyword)));
}

/**
 * 국세청 공제구분을 정확히 정규화한다.
 * '불공제' 안에 '공제'가 들어 있으므로 반드시 아래 순서를 지켜야 한다.
 * 당연불공제 → 선택불공제 → 불공제 → 공제 → 그 외(빈 문자열).
 */
export function normalizeNtsStatus(row) {
  const raw = compact(readInput(row, '국세청'));
  if (!raw) return '';
  if (/(당연|필요적|의무)(적)?(불공제|비공제)/.test(raw)) return '당연불공제';
  if (/(선택|임의)(적)?(불공제|비공제)/.test(raw)) return '선택불공제';
  if (/(불공제|비공제)/.test(raw)) return '불공제';
  if (/공제/.test(raw)) return '공제';
  return '';
}

/**
 * 공급자 사업자유형을 정규화한다.
 * '사업자유형' 칸만 읽는다. 거래처명, 업태, 종목으로 간이과세자나 면세사업자를
 * 추정하지 않는다. 값이 없으면 빈 문자열을 돌려주고 판단하지 않는다.
 */
export function normalizeBusinessType(row) {
  const raw = compact(readInput(row, '사업자유형'));
  if (!raw) return '';
  if (/간이/.test(raw)) return '간이과세자';
  if (/면세/.test(raw)) return '면세사업자';
  if (/일반/.test(raw)) return '일반과세자';
  return '';
}

function isTaxableDivision(row) {
  const division = compact(readInput(row, '구분'));
  if (!division) return false;
  // '비과세'와 '면세'에도 '세'가 들어가므로 과세 여부는 배제 조건과 함께 본다.
  if (/비과세|면세|불공제/.test(division)) return false;
  return /과세/.test(division);
}

/**
 * 거래 자체가 명확한 면세거래인지 확인한다.
 * '쌀', '꽃' 같은 품명 단어 하나로는 판단하지 않고 구조화된 세 조건을 모두 본다.
 * 세액 칸이 비어 있으면 0원이라고 단정하지 않고 면세 확정에서 제외한다.
 */
export function isClearlyTaxExemptTransaction(row) {
  const division = compact(readInput(row, '구분'));
  const tax = toAmount(row?.['세액']);
  const exemptAmount = toAmount(row?.['비과세']);
  return /면세/.test(division) && tax === 0 && exemptAmount !== null && exemptAmount > 0;
}

/**
 * 3-1. 접대성 불공제가 계정과목과 거래 내용에서 함께 확인되는지 본다.
 * 조건 A(차변계정)와 조건 B(품명·업태·종목)가 모두 맞아야 참이다.
 */
export function hasStrongEntertainmentNonDeductiblePair(row) {
  const accountMatches = findKeywordsIn(row, ['차변계정'], ENTERTAINMENT_ACCOUNT_KEYWORDS);
  if (!accountMatches.length) return null;
  const contentMatches = findKeywordsIn(row, ['품명', '업태', '종목'], ENTERTAINMENT_CONTENT_KEYWORDS);
  if (!contentMatches.length) return null;
  return { keywords: uniqueKeywords([...accountMatches, ...contentMatches]) };
}

/**
 * 4-1. 사용 목적이나 법정 불공제 여부를 사람이 확인해야 하는 신호를 찾는다.
 */
export function hasReviewRiskSignal(row) {
  const matches = findKeywordsIn(row, ['품명', '차변계정', '업태', '종목'], REVIEW_RISK_KEYWORDS);
  if (!matches.length) return null;
  const keywords = uniqueKeywords(matches);
  return { keywords, isVehicle: keywords.some((keyword) => VEHICLE_KEYWORDS.includes(keyword)) };
}

/**
 * 4-2. 품명과 차변계정이 같은 조합 안에서 함께 일치하는지 확인한다.
 * 한쪽만 맞으면 공제로 보지 않는다.
 */
export function matchesDeductiblePair(row) {
  const productName = readInput(row, '품명');
  const account = readInput(row, '차변계정');
  if (!productName || !account) return null;

  for (const pair of DEDUCTIBLE_PAIRS) {
    const productKeyword = pair.품명.find((keyword) => productName.includes(keyword));
    const accountKeyword = pair.차변계정.find((keyword) => account.includes(keyword));
    if (productKeyword && accountKeyword) {
      return { label: pair.label, keywords: uniqueKeywords([{ keyword: productKeyword }, { keyword: accountKeyword }]) };
    }
  }
  return null;
}

function hasAmount(row) {
  return ['공급가액', '세액', '비과세', '합계'].some((column) => {
    const value = row?.[column];
    return typeof value === 'number' ? value !== 0 : /[1-9]\d*/.test(normalizeText(value));
  });
}

function buildWarning(row, hasNts) {
  const missing = [
    hasNts ? '' : '국세청 공제구분',
    hasAmount(row) ? '' : '세액/금액',
    readInput(row, '품명') ? '' : '품명',
    readInput(row, '업태') || readInput(row, '종목') ? '' : '업태/종목',
  ].filter(Boolean);

  return missing.length ? `${missing.join('/')} 정보가 부족하여 최종 확인이 필요합니다.` : '';
}

function buildLegalBasis(legalBasisKey, articleReferences = {}) {
  const basis = LEGAL_BASIS[legalBasisKey] ?? LEGAL_BASIS.review;
  const excerpts = basis.articles
    .map((articleKey) => articleReferences[articleKey])
    .filter(Boolean)
    .map((article) => {
      const excerpt = article.excerpt ? ` - ${article.excerpt.slice(0, 160)}${article.excerpt.length > 160 ? '...' : ''}` : '';
      return `${article.title || article.label}${excerpt}`;
    });

  return {
    label: basis.label,
    line: excerpts.length ? `법령 원문 확인: ${excerpts.join(' / ')}` : '',
  };
}

function result(decision, confidence, reason, evidenceKeywords, warning = '', legalBasisKey = 'review', articleReferences = {}) {
  const legalBasis = buildLegalBasis(legalBasisKey, articleReferences);
  const keywordSummary = evidenceKeywords.filter(Boolean).join(', ');
  const evidenceLine = `판정 근거 키워드: ${keywordSummary || '-'}`;
  const warningLine = warning ? `주의: ${warning}` : '';
  const confidenceLine = `신뢰도: ${confidence}%`;
  const legalBasisLine = `근거 조항: ${legalBasis.label}`;

  return {
    decision,
    confidence,
    reason,
    evidenceKeywords,
    warning,
    legalBasis: legalBasis.label,
    판정: decision,
    신뢰도: `${confidence}%`,
    근거조항: legalBasis.label,
    근거키워드: keywordSummary,
    주의: warning,
    '법 기준 사유': [evidenceLine, confidenceLine, legalBasisLine, legalBasis.line, warningLine, reason].filter(Boolean).join('\n'),
  };
}

/**
 * 매입세액 1차 판정.
 *
 * 판정 순서
 *   1. 사업자유형이 간이과세자·면세사업자이거나 국세청 구분이 당연불공제 → 불공제
 *   2. 구분 면세 + 세액 0원 + 비과세금액 존재 → 불공제
 *   3. 국세청 구분이 선택불공제 또는 불공제
 *        3-1. 접대비 계정 + 접대성 거래내용 → 불공제
 *        3-2. 그 외 → 검토필요
 *   4. 국세청 구분이 공제
 *        4-1. 위험·사용목적 확인 키워드 → 검토필요
 *        4-2. 과세 + 세액 존재 + 품명·계정 조합 일치 → 공제
 *        4-3. 그 외 → 검토필요
 *   5. 국세청 구분 없음 또는 알 수 없음 → 검토필요
 */
export function judgeVat(row, articleReferences = {}) {
  const ntsStatus = normalizeNtsStatus(row);
  const businessType = normalizeBusinessType(row);
  const hasNts = !!ntsStatus;
  const warning = buildWarning(row, hasNts);
  const decide = (decision, confidence, reason, evidenceKeywords, warningText, legalBasisKey) =>
    result(decision, confidence, reason, evidenceKeywords, warningText, legalBasisKey, articleReferences);

  // 1순위: 공급자 유형 또는 국세청 당연불공제.
  if (businessType === '간이과세자' || businessType === '면세사업자' || ntsStatus === '당연불공제') {
    const evidence = [
      businessType ? `사업자유형 ${businessType}` : '',
      ntsStatus === '당연불공제' ? '국세청 당연불공제' : '',
    ].filter(Boolean);
    return decide(
      '불공제',
      CONFIDENCE.supplierOrMandatory,
      '공급자 사업자유형 또는 국세청 구분상 당연불공제 거래입니다.',
      evidence,
      warning,
      businessType === '면세사업자' ? 'taxExempt' : 'nonDeductible',
    );
  }

  // 2순위: 구조화된 항목으로 확인되는 명확한 면세거래.
  if (isClearlyTaxExemptTransaction(row)) {
    return decide(
      '불공제',
      CONFIDENCE.clearTaxExempt,
      '면세 재화·용역 거래로 공제할 매입세액이 없습니다.',
      ['구분 면세', '세액 0원', '비과세금액 존재'],
      warning,
      'taxExempt',
    );
  }

  // 3순위: 국세청 구분이 선택불공제 또는 단순 불공제.
  if (ntsStatus === '선택불공제' || ntsStatus === '불공제') {
    const entertainment = hasStrongEntertainmentNonDeductiblePair(row);
    if (entertainment) {
      return decide(
        '불공제',
        CONFIDENCE.entertainmentPair,
        '국세청 불공제 구분과 접대성 지출의 계정·거래 내용이 함께 확인되었습니다.',
        [`국세청 ${ntsStatus}`, ...entertainment.keywords],
        warning,
        'nonDeductible',
      );
    }

    // 국세청이 불공제로 분류했다는 사실만으로 자동 불공제 처리하지 않는다.
    const risk = hasReviewRiskSignal(row);
    return decide(
      '검토필요',
      CONFIDENCE.ntsNonDeductibleUnclear,
      '국세청에서 불공제로 분류했으나 자동으로 확정할 객관적 거래 정보가 부족합니다.',
      [`국세청 ${ntsStatus}`, ...(risk?.keywords ?? [])],
      warning || '차변계정, 품명, 업태/종목으로 실제 거래 성격을 확인하세요.',
      risk?.isVehicle ? 'vehicle' : 'review',
    );
  }

  // 4순위: 국세청 구분이 공제.
  if (ntsStatus === '공제') {
    const risk = hasReviewRiskSignal(row);
    if (risk) {
      return decide(
        '검토필요',
        CONFIDENCE.ntsDeductibleRisk,
        '국세청은 공제로 분류했으나 실제 사용 목적 또는 법정 불공제 여부를 추가로 확인해야 합니다.',
        ['국세청 공제', ...risk.keywords],
        warning || '사용 목적, 참석자, 차량 용도 등 추가 증빙을 확인하세요.',
        risk.isVehicle ? 'vehicle' : 'review',
      );
    }

    const taxAmount = toAmount(row?.['세액']);
    const pair = matchesDeductiblePair(row);
    if (isTaxableDivision(row) && taxAmount !== null && taxAmount > 0 && pair) {
      return decide(
        '공제',
        CONFIDENCE.clearBusinessPurchase,
        `${LEGAL_PREFIX} 국세청 공제, 과세거래, 세액 존재 및 사업 관련 품명·계정과목 조합이 모두 일치합니다.`,
        ['국세청 공제', '구분 과세', '세액 존재', ...pair.keywords],
        warning,
        'generalTaxablePurchase',
      );
    }

    return decide(
      '검토필요',
      CONFIDENCE.ntsDeductibleUnclear,
      '국세청은 공제로 분류했으나 자동 공제에 필요한 거래 정보가 충분히 일치하지 않습니다.',
      ['국세청 공제'],
      warning || '구분, 세액, 품명과 차변계정의 일치 여부를 확인하세요.',
      'review',
    );
  }

  // 5순위: 국세청 구분이 없거나 정규화할 수 없는 값.
  // 품명에 택배비·사무용품 같은 키워드가 있어도 자동 공제하지 않는다.
  return decide(
    '검토필요',
    CONFIDENCE.ntsUnknown,
    '국세청 공제구분을 확인할 수 없어 추가 검토가 필요합니다.',
    [],
    warning || '국세청 공제구분, 사업자유형, 품명, 차변계정, 업태/종목을 확인하세요.',
    'review',
  );
}
