import { DEFAULT_LAW_BASELINE } from './lawBaseline.js';
import { normalizeText } from './rules.js';

export const APPROVED_BASELINE_STORAGE_KEY = 'wehago-vat-approved-law-baseline';
export const LAW_REVIEWED_STORAGE_KEY = 'wehago-vat-law-change-reviewed';

export const LAW_IMPACT_MAP = {
  'vat-act-26': {
    rules: ['면세 재화·용역', '면세 키워드', '과세·면세 구분'],
    keywords: ['면세', '꽃', '생화', '화환', '화분', '꽃다발', '플라워', '화훼', '쌀', '현미', '잡곡', '채소', '과일', '농산물', '축산물', '수산물', '수돗물', '상수도', '수도요금'],
    decisions: ['불공제'],
    description: '면세 재화·용역과 과세·면세 구분에 사용되는 규칙',
  },
  'vat-act-38': {
    rules: ['일반적인 매입세액 공제', '사업 관련 과세매입', '공제 기본 요건'],
    keywords: ['상품', '원재료', '재료비', '매입', '운반비', '택배', '배송', '소모품', '사무용품', '지급수수료', '통신비', '광고선전비', '임차료', '외주비', '인쇄비', '복사'],
    decisions: ['공제'],
    matchDecision: true,
    description: '사업 관련 과세매입의 일반 공제 요건에 사용되는 규칙',
  },
  'vat-act-39': {
    rules: ['접대비·기업업무추진비', '업무무관 지출', '비영업용 승용자동차', '면세사업 관련 매입세액', '기타 불공제'],
    keywords: ['접대비', '기업업무추진비', '업무무관', '사업무관', '개인', '사적', '승용차', '자동차', '차량', '주유', '렌트', '리스', '주차', '톨게이트', '면세사업', '유흥', '주점', '룸살롱', '골프', '선물', '기부금', '벌금', '과태료'],
    decisions: ['불공제'],
    matchDecision: true,
    description: '업무무관·승용차·기업업무추진비·면세사업 관련 불공제 규칙',
  },
  'vat-decree-79': {
    rules: ['접대비', '기업업무추진비', '유사한 비용'],
    keywords: ['접대비', '기업업무추진비', '유흥', '주점', '룸살롱', '골프', '선물'],
    decisions: ['불공제'],
    description: '기업업무추진비와 유사 비용의 범위에 사용되는 규칙',
  },
};

const OUTPUT_KEYS = new Set([
  'id', '판정', '신뢰도', '근거조항', '근거키워드', '주의', '법령근거', '법 기준 사유',
  'decision', 'confidence', 'reason', 'evidenceKeywords', 'warning', 'legalBasis',
  '_userModifiedDecision', '_lawGuard',
]);

export function normalizeLawContent(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function sha256(value) {
  const bytes = new TextEncoder().encode(normalizeLawContent(value));
  const buffer = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareLawSnapshots(snapshots) {
  return Promise.all((snapshots ?? []).map(async (snapshot) => {
    const normalizedContent = normalizeLawContent(snapshot.content ?? snapshot.normalizedContent);
    return {
      ...snapshot,
      normalizedContent,
      hash: await sha256(normalizedContent),
    };
  }));
}

export function readApprovedBaseline() {
  try {
    const parsed = JSON.parse(localStorage.getItem(APPROVED_BASELINE_STORAGE_KEY) || 'null');
    if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_LAW_BASELINE;
    const requiredKeys = Object.keys(LAW_IMPACT_MAP);
    const valid = parsed.length === requiredKeys.length
      && requiredKeys.every((key) => parsed.some((item) => item?.key === key && item?.hash && item?.normalizedContent));
    return valid ? parsed : DEFAULT_LAW_BASELINE;
  } catch {
    return DEFAULT_LAW_BASELINE;
  }
}

export function compareLawSnapshots(baseline, current, { simulate = false } = {}) {
  const baselineMap = new Map((baseline ?? []).map((item) => [item.key, item]));
  const currentMap = new Map((current ?? []).map((item) => [item.key, item]));

  return Object.keys(LAW_IMPACT_MAP).map((key) => {
    const base = baselineMap.get(key);
    const actual = currentMap.get(key);
    if (!actual) return { key, status: 'unavailable', baseline: base ?? null, current: null, impact: LAW_IMPACT_MAP[key] };
    if (!base) return { key, status: 'not_monitored', baseline: null, current: actual, impact: LAW_IMPACT_MAP[key] };

    const simulated = simulate && key === 'vat-act-39';
    const contentChanged = base.hash !== actual.hash || simulated;
    const dateChanged = normalizeText(base.enforcementDate) !== normalizeText(actual.enforcementDate);
    return {
      key,
      status: contentChanged || dateChanged ? 'changed' : 'unchanged',
      baseline: base,
      current: actual,
      impact: LAW_IMPACT_MAP[key],
      simulated,
      contentChanged,
      dateChanged,
    };
  });
}

export function getChangedLawImpacts(comparisons) {
  return (comparisons ?? []).filter((comparison) => comparison.status === 'changed');
}

function searchableRowText(row) {
  return Object.entries(row ?? {})
    .filter(([key]) => !OUTPUT_KEYS.has(key))
    .map(([, value]) => normalizeText(value).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

export function getRowLawImpacts(row, judgement, comparisons) {
  const text = searchableRowText(row);
  const decision = normalizeText(judgement?.판정 ?? judgement?.decision);
  return getChangedLawImpacts(comparisons).filter(({ impact }) => {
    const keywordMatch = impact.keywords.some((keyword) => text.includes(keyword.toLowerCase()));
    return keywordMatch || (impact.matchDecision && impact.decisions.includes(decision));
  });
}

export function applyLawChangeGuard(row, judgement, comparisons) {
  if (row?._userModifiedDecision) return { ...judgement, _userModifiedDecision: true };
  const impacts = getRowLawImpacts(row, judgement, comparisons);
  if (!impacts.length) return { ...judgement, _lawGuard: null };

  const labels = impacts.map(({ current, baseline }) => current?.articleLabel || `${baseline?.lawName} 제${baseline?.articleNumber}조`);
  const warning = '관련 법령의 변경이 감지되어 기존 자동 판정을 잠갔습니다. 최신 조문과 판정 규칙을 확인하세요.';
  const originalDecision = normalizeText(judgement.판정 || judgement.decision) || '검토필요';
  const confidenceNumber = Number.parseInt(judgement.신뢰도 || judgement.confidence, 10) || 40;
  const confidence = Math.min(confidenceNumber, 45);
  const guardReason = `기존 규칙상 ${originalDecision} 대상이지만 ${labels.join(', ')} 변경이 감지되어 자동 판정을 중단하고 검토필요로 전환했습니다.`;

  return {
    ...judgement,
    decision: '검토필요',
    confidence,
    warning,
    legalBasis: labels.join(', '),
    판정: '검토필요',
    신뢰도: `${confidence}%`,
    근거조항: labels.join(', '),
    주의: warning,
    '법 기준 사유': `${judgement['법 기준 사유'] || judgement.reason || ''}\n\n[법령 변경 판정 잠금]\n${guardReason}`.trim(),
    _lawGuard: { originalDecision, articleKeys: impacts.map((impact) => impact.key), labels },
  };
}

export function approveCurrentLawSnapshot(snapshots) {
  const requiredKeys = Object.keys(LAW_IMPACT_MAP);
  if (snapshots?.length !== requiredKeys.length || !requiredKeys.every((key) => snapshots.some((item) => item.key === key))) {
    throw new Error('모든 감시 대상 조문을 확인한 뒤 기준을 승인할 수 있습니다.');
  }
  const approvedAt = new Date().toISOString();
  const approved = (snapshots ?? []).map((snapshot) => ({
    key: snapshot.key,
    lawName: snapshot.lawName,
    articleNumber: snapshot.articleNumber,
    enforcementDate: snapshot.enforcementDate,
    normalizedContent: snapshot.normalizedContent,
    hash: snapshot.hash,
    lastApprovedAt: approvedAt,
  }));
  localStorage.setItem(APPROVED_BASELINE_STORAGE_KEY, JSON.stringify(approved));
  localStorage.removeItem(LAW_REVIEWED_STORAGE_KEY);
  return approved;
}

export function resetApprovedLawSnapshot() {
  localStorage.removeItem(APPROVED_BASELINE_STORAGE_KEY);
  localStorage.removeItem(LAW_REVIEWED_STORAGE_KEY);
  return DEFAULT_LAW_BASELINE;
}

export function splitChangedSentences(before, after) {
  const split = (value) => normalizeLawContent(value).split(/(?<=[.!?。]|다\.)\s+|(?=[①-⑳])/).map((item) => item.trim()).filter(Boolean);
  const beforeSet = new Set(split(before));
  const afterSet = new Set(split(after));
  return {
    removed: [...beforeSet].filter((sentence) => !afterSet.has(sentence)).slice(0, 8),
    added: [...afterSet].filter((sentence) => !beforeSet.has(sentence)).slice(0, 8),
  };
}
