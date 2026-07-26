const HIGH_DEDUCTIBLE_KEYWORDS = [
  '상품',
  '원재료',
  '재료비',
  '매입',
  '운반비',
  '택배',
  '배송',
  '소포',
  '우정사업본부',
  '소모품',
  '사무용품',
  '지급수수료',
  '통신비',
  '광고선전비',
  '임차료',
  '외주비',
  '인쇄비',
  '복사',
  '택배비',
];
const HIGH_NON_DEDUCTIBLE_KEYWORDS = [
  '접대비',
  '기업업무추진비',
  '유흥',
  '주점',
  '룸살롱',
  '골프',
  '선물',
  '기부금',
  '벌금',
  '과태료',
  '세금과공과금',
  '공과금',
  '개인',
  '사적',
  '보험료',
];
const TAX_EXEMPT_KEYWORDS = [
  '면세',
  '꽃',
  '생화',
  '화환',
  '화분',
  '꽃다발',
  '플라워',
  '화훼',
  '쌀',
  '현미',
  '잡곡',
  '채소',
  '과일',
  '농산물',
  '축산물',
  '수산물',
  '수돗물',
  '상수도',
  '수도요금',
];
const REVIEW_KEYWORDS = [
  '식대',
  '음식점',
  '식당',
  '카페',
  '커피',
  '회의비',
  '복리후생비',
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
];
const WEAK_PAYMENT_KEYWORDS = ['현금', '카드', '보통예금', '미지급금'];
const LEGAL_PREFIX = '부가가치세법상 매입세액 공제는 사업 관련 과세매입이고 불공제 사유가 없는 경우 인정됩니다.';
const LEGAL_BASIS = {
  generalTaxablePurchase: { label: '부가가치세법 제38조 및 제39조', articles: ['article38', 'article39'] },
  nonDeductible: { label: '부가가치세법 제39조 제1항', articles: ['article39'] },
  vehicle: { label: '부가가치세법 제39조 제1항', articles: ['article39'] },
  taxExempt: { label: '부가가치세법 제26조 및 제39조', articles: ['article26', 'article39'] },
  unrelatedBusiness: { label: '부가가치세법 제39조', articles: ['article39'] },
  review: { label: '부가가치세법 제38조 및 제39조', articles: ['article38', 'article39'] },
};

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// 판정 결과로 생성된 칼럼은 판정 입력에서 제외한다.
// 이 칼럼들에는 '매입세액', '면세' 같은 설명 문구가 들어 있어서, 그대로 다시 넣으면
// 원본 거래에 없던 키워드가 검출되어 판정이 스스로를 되먹임한다.
const NON_INPUT_KEYS = new Set([
  'id',
  '판정', '신뢰도', '근거조항', '근거키워드', '주의', '법령근거', '법 기준 사유', '사유',
  'decision', 'confidence', 'reason', 'evidenceKeywords', 'warning', 'legalBasis',
]);

function rowText(row) {
  return Object.entries(row)
    .filter(([key]) => !NON_INPUT_KEYS.has(key))
    .map(([, value]) => normalizeText(value))
    .filter(Boolean)
    .join(' ');
}

function findKeywords(text, keywords) {
  const normalized = normalizeText(text).toLowerCase();
  return keywords.filter((keyword) => normalized.includes(keyword.toLowerCase()));
}

function hasAnyKeyword(keywords, targets) {
  return keywords.some((keyword) => targets.includes(keyword));
}

function hasAmount(row) {
  return ['공급가액', '세액', '비과세', '합계'].some((column) => {
    const value = row[column];
    return typeof value === 'number' ? value !== 0 : /[1-9]\d*/.test(normalizeText(value));
  });
}

function buildWarning(row, hasNts) {
  const missing = [
    hasNts ? '' : '국세청 공제구분',
    hasAmount(row) ? '' : '세액/금액',
    normalizeText(row['품명']) ? '' : '품명',
    normalizeText(row['업태']) || normalizeText(row['종목']) ? '' : '업태/종목',
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

function result(decision, confidence, reason, evidenceKeywords, warning = '', legalBasisKey = 'review', articleReferences = {}, additionalKeywords = []) {
  const legalBasis = buildLegalBasis(legalBasisKey, articleReferences);
  const additionalText = additionalKeywords.length ? ` (추가 감지: ${additionalKeywords.join(', ')})` : '';
  const keywordSummary = `${evidenceKeywords.join(', ')}${additionalText}`.trim();
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

export function judgeVat(row, articleReferences = {}) {
  const text = rowText(row);
  const ntsStatus = normalizeText(row['국세청']);
  const isNtsNonDeductible = /비공제|불공제/.test(ntsStatus);
  const isNtsDeductible = /(^|[^불비])공제/.test(ntsStatus) && !isNtsNonDeductible;
  const hasNts = !!ntsStatus;
  const taxExempt = findKeywords(text, TAX_EXEMPT_KEYWORDS);
  const nonDeductible = findKeywords(text, HIGH_NON_DEDUCTIBLE_KEYWORDS);
  const review = findKeywords(text, REVIEW_KEYWORDS);
  const deductible = findKeywords(text, HIGH_DEDUCTIBLE_KEYWORDS);
  const weakPayments = findKeywords(text, WEAK_PAYMENT_KEYWORDS);
  const warning = buildWarning(row, hasNts);

  // 아래 사다리는 먼저 걸린 규칙에서 즉시 반환하므로, 다른 사전에서 감지됐지만
  // 판정에 쓰이지 않은 키워드는 그대로 버려진다. decide()가 그 잔여 키워드를
  // 모아 "(추가 감지: ...)"로 덧붙인다. 판정과 신뢰도에는 영향을 주지 않는다.
  const allSignals = Array.from(new Set([...taxExempt, ...nonDeductible, ...review, ...deductible]));
  const decide = (decision, confidence, reason, evidenceKeywords, warningText, legalBasisKey) =>
    result(
      decision,
      confidence,
      reason,
      evidenceKeywords,
      warningText,
      legalBasisKey,
      articleReferences,
      allSignals.filter((keyword) => !evidenceKeywords.includes(keyword)),
    );

  if (isNtsNonDeductible) {
    return decide(
      '불공제',
      95,
      taxExempt.length
        ? `면세 재화 또는 용역은 일반적으로 공제받을 매입세액이 발생하지 않습니다. 국세청 공제구분도 ${ntsStatus}로 확인되어 불공제로 판정했습니다.`
        : `${LEGAL_PREFIX} 국세청 공제구분이 ${ntsStatus}로 확인되어 매입세액을 불공제로 처리하는 것이 합리적입니다.`,
      [`국세청 ${ntsStatus}`, ...taxExempt, ...nonDeductible],
      warning,
      taxExempt.length ? 'taxExempt' : 'nonDeductible',
    );
  }

  if (taxExempt.length) {
    return decide(
      '불공제',
      hasNts ? 92 : 78,
      `면세 재화 또는 용역은 일반적으로 공제받을 매입세액이 발생하지 않습니다. ${taxExempt.join(', ')} 키워드가 면세 거래 가능성을 강하게 보여 불공제로 추정했습니다. 실제 과세 세금계산서 발급 여부와 품목의 과세 여부는 증빙으로 확인하세요.`,
      taxExempt,
      warning || '원본 증빙에서 면세 여부와 세액 기재 여부를 확인하세요.',
      'taxExempt',
    );
  }

  if (nonDeductible.length) {
    return decide(
      '불공제',
      hasNts ? 90 : 72,
      `${LEGAL_PREFIX} ${nonDeductible.join(', ')} 키워드는 접대성 지출, 사적 지출, 벌과금, 공과금 등 불공제 성격을 나타냅니다. ${hasNts ? '국세청 공제구분도 함께 고려했습니다.' : '추정 판정이므로 원본 증빙과 실제 사용 목적을 확인하세요.'}`,
      nonDeductible,
      warning || '추정 판정입니다. 실제 사용 목적과 증빙을 확인하세요.',
      'nonDeductible',
    );
  }

  if (isNtsDeductible && !review.length) {
    return decide(
      '공제',
      88,
      `${LEGAL_PREFIX} 국세청 공제구분이 공제이고 위험 키워드가 발견되지 않아 공제로 판정했습니다.`,
      ['국세청 공제', ...deductible],
      warning,
      'generalTaxablePurchase',
    );
  }

  if (review.length) {
    return decide(
      '검토필요',
      hasNts ? 78 : 60,
      `${LEGAL_PREFIX} ${review.join(', ')} 키워드는 업무 관련 비용일 수도 있지만 접대성, 사적 사용, 차량 용도 등 추가 확인이 필요한 성격도 포함할 수 있습니다. 실제 사용 목적을 확인해야 하므로 검토필요로 판정했습니다.`,
      review,
      warning || '사용 목적, 참석자, 차량 용도 등 추가 증빙을 확인하세요.',
      review.some((keyword) => ['주유', '차량', '자동차', '렌트', '리스', '주차', '톨게이트'].includes(keyword))
        ? 'vehicle'
        : 'review',
    );
  }

  if (deductible.length) {
    const hasInventory = deductible.some((keyword) => ['상품', '원재료', '재료비', '매입'].includes(keyword));
    return decide(
      '공제',
      hasInventory && !hasNts ? 65 : 72,
      hasInventory
        ? `${LEGAL_PREFIX} 상품, 원재료, 매입 등 재고 또는 매입 성격의 계정 키워드가 있어 사업 관련 과세매입 가능성이 있습니다. 국세청 공제구분 또는 세액 정보가 부족하면 증빙을 확인하세요. 추정 판정입니다.`
        : `${LEGAL_PREFIX} ${deductible.join(', ')} 키워드는 통상적인 사업 운영비 성격으로 보여 공제 가능성이 높습니다. 추정 판정입니다.`,
      deductible,
      warning,
      'generalTaxablePurchase',
    );
  }

  if (weakPayments.length && !deductible.length && !nonDeductible.length && !review.length) {
    return decide(
      '검토필요',
      35,
      `${LEGAL_PREFIX} ${weakPayments.join(', ')}는 결제수단 또는 정산 계정에 가까워 공제 여부를 판단하는 근거로는 약합니다. 품명, 계정과목, 업태/종목을 확인해야 거래 성격을 알 수 있습니다.`,
      weakPayments,
      warning || '결제수단만으로는 공제 여부를 판단하기 어렵습니다.',
      'review',
    );
  }

  return decide(
    '검토필요',
    40,
    `${LEGAL_PREFIX} 남아 있는 단어만으로는 공제 또는 불공제를 충분한 확신으로 추정하기 어렵습니다.`,
    [],
    warning || '국세청 공제구분, 품명, 계정과목, 업태/종목을 확인하세요.',
    'review',
  );
}
