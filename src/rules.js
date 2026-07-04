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
const LEGAL_PREFIX = 'Under the Korean VAT Act, input VAT is deductible when the purchase is a taxable business-related purchase and no non-deductible reason applies.';
const LEGAL_BASIS = {
  generalTaxablePurchase: { label: 'VAT Act Articles 38 and 39', articles: ['article38', 'article39'] },
  nonDeductible: { label: 'VAT Act Article 39(1)', articles: ['article39'] },
  vehicle: { label: 'VAT Act Article 39(1)', articles: ['article39'] },
  taxExempt: { label: 'VAT Act Articles 26 and 39', articles: ['article26', 'article39'] },
  unrelatedBusiness: { label: 'VAT Act Article 39', articles: ['article39'] },
  review: { label: 'VAT Act Articles 38 and 39', articles: ['article38', 'article39'] },
};

export function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function rowText(row) {
  return Object.values(row).map(normalizeText).filter(Boolean).join(' ');
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

  return missing.length ? `Missing ${missing.join('/')} information. Final confirmation is required.` : '';
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
    line: excerpts.length ? `Law text checked: ${excerpts.join(' / ')}` : '',
  };
}

function result(decision, confidence, reason, evidenceKeywords, warning = '', legalBasisKey = 'review', articleReferences = {}) {
  const legalBasis = buildLegalBasis(legalBasisKey, articleReferences);
  const evidenceLine = evidenceKeywords.length ? `Evidence keywords: ${evidenceKeywords.join(', ')}` : 'Evidence keywords: -';
  const warningLine = warning ? `Warning: ${warning}` : '';
  const confidenceLine = `Confidence: ${confidence}%`;
  const legalBasisLine = `Legal clause: ${legalBasis.label}`;

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
    근거키워드: evidenceKeywords.join(', '),
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

  if (isNtsNonDeductible) {
    return result(
      '불공제',
      95,
      taxExempt.length
        ? `Tax-exempt goods or services generally do not generate deductible input VAT. The NTS status is also ${ntsStatus}, so this is classified as non-deductible.`
        : `${LEGAL_PREFIX} The NTS status is ${ntsStatus}, so excluding this input VAT from deduction is reasonable.`,
      [`NTS ${ntsStatus}`, ...taxExempt, ...nonDeductible],
      warning,
      taxExempt.length ? 'taxExempt' : 'nonDeductible',
      articleReferences,
    );
  }

  if (taxExempt.length) {
    return result(
      '불공제',
      hasNts ? 92 : 78,
      `Tax-exempt goods or services generally do not generate deductible input VAT. The keywords ${taxExempt.join(', ')} suggest a likely tax-exempt transaction, so this is estimated as non-deductible. Confirm whether a taxable invoice was issued or whether the item was actually taxable.`,
      taxExempt,
      warning || 'Confirm tax-exempt status and VAT amount on the source document.',
      'taxExempt',
      articleReferences,
    );
  }

  if (nonDeductible.length) {
    return result(
      '불공제',
      hasNts ? 90 : 72,
      `${LEGAL_PREFIX} The keywords ${nonDeductible.join(', ')} indicate entertainment, private spending, penalties, dues, or similar non-deductible characteristics. ${hasNts ? 'The NTS value was also considered.' : 'This is an estimated decision, so source evidence should be checked.'}`,
      nonDeductible,
      warning || 'Estimated decision. Check actual business purpose and supporting evidence.',
      'nonDeductible',
      articleReferences,
    );
  }

  if (isNtsDeductible && !review.length) {
    return result(
      '공제',
      88,
      `${LEGAL_PREFIX} The NTS status is deductible and no risk keywords were found, so this is classified as deductible.`,
      ['NTS deductible', ...deductible],
      warning,
      'generalTaxablePurchase',
      articleReferences,
    );
  }

  if (review.length) {
    return result(
      '검토필요',
      hasNts ? 78 : 60,
      `${LEGAL_PREFIX} The keywords ${review.join(', ')} can include either business expenses or entertainment/private expenses. Check the actual purpose of use. This is an estimated decision.`,
      review,
      warning || 'Check purpose of use, attendees, vehicle use, or other supporting details.',
      review.some((keyword) => ['주유', '차량', '자동차', '렌트', '리스', '주차', '톨게이트'].includes(keyword))
        ? 'vehicle'
        : 'review',
      articleReferences,
    );
  }

  if (deductible.length) {
    const hasInventory = deductible.some((keyword) => ['상품', '원재료', '재료비', '매입'].includes(keyword));
    return result(
      '공제',
      hasInventory && !hasNts ? 65 : 72,
      hasInventory
        ? `${LEGAL_PREFIX} Inventory or purchase-related account keywords suggest a taxable business purchase. If NTS status or VAT amount is missing, verify the supporting document. This is an estimated decision.`
        : `${LEGAL_PREFIX} The keywords ${deductible.join(', ')} suggest an ordinary taxable business operating expense. This is an estimated decision.`,
      deductible,
      warning,
      'generalTaxablePurchase',
      articleReferences,
    );
  }

  if (weakPayments.length && !deductible.length && !nonDeductible.length && !review.length) {
    return result(
      '검토필요',
      35,
      `${LEGAL_PREFIX} ${weakPayments.join(', ')} are payment or settlement terms, so they are weak evidence for deciding deductibility. Check item, account, or business type to understand the transaction.`,
      weakPayments,
      warning || 'Payment method alone is not enough to decide.',
      'review',
      articleReferences,
    );
  }

  return result(
    '검토필요',
    40,
    `${LEGAL_PREFIX} The remaining words are not enough to estimate deductibility or non-deductibility with confidence.`,
    [],
    warning || 'Check NTS status, item, account, or business type.',
    'review',
    articleReferences,
  );
}
