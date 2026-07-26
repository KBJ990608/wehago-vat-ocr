type KoreanLawTarget = 'law' | 'expc' | 'prec';

declare const __LAW_API_OC__: string;
declare const __KSKILL_PROXY_BASE_URL__: string;

type SearchParams = {
  target: KoreanLawTarget;
  query: string;
  display?: number;
};

type DetailParams = {
  target: KoreanLawTarget;
  mst?: string;
  id?: string;
  serialNumber?: string;
  extraParams?: Record<string, string>;
};

export type KoreanLawResult = {
  target: KoreanLawTarget;
  title: string;
  lawId: string;
  mst: string;
  date: string;
  summary: string;
  raw: Record<string, unknown>;
};

export type VoucherLegalBasisResult = {
  legalBasis: KoreanLawResult[];
  lawResults: KoreanLawResult[];
  interpretationResults: KoreanLawResult[];
  precedentResults: KoreanLawResult[];
  errors: string[];
};

const LAW_API_OC = typeof __LAW_API_OC__ === 'string' ? __LAW_API_OC__ : '';
const KSKILL_PROXY_BASE_URL =
  typeof __KSKILL_PROXY_BASE_URL__ === 'string'
    ? __KSKILL_PROXY_BASE_URL__.replace(/\/$/, '')
    : 'https://k-skill-proxy.nomadamas.org';
const FALLBACK_LAW_API_BASE = import.meta.env.DEV ? '/DRF' : 'https://www.law.go.kr/DRF';
const KSKILL_API_BASE = import.meta.env.DEV ? '/kskill' : KSKILL_PROXY_BASE_URL;

function normalizeText(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function collectObjects(node: unknown, results: Record<string, unknown>[] = []) {
  if (!node || typeof node !== 'object') return results;

  if (Array.isArray(node)) {
    node.forEach((item) => collectObjects(item, results));
    return results;
  }

  const record = node as Record<string, unknown>;
  const hasSearchLikeShape = Object.keys(record).some((key) =>
    /법령명|안건명|해석례명|판례|사건명|질의|회신|제목|lawNm|title|case/i.test(key),
  );

  if (hasSearchLikeShape) results.push(record);
  Object.values(record).forEach((value) => collectObjects(value, results));
  return results;
}

function pickFirst(raw: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = normalizeText(raw[key]);
    if (value) return value;
  }
  return '';
}

function normalizeLawResult(raw: Record<string, unknown>, target: KoreanLawTarget): KoreanLawResult {
  return {
    target,
    title: pickFirst(raw, [
      '법령명한글',
      '법령명',
      '안건명',
      '해석례명',
      '판례명',
      '사건명',
      '제목',
      'lawNm',
      'title',
    ]),
    lawId: pickFirst(raw, ['법령ID', 'ID', 'id', 'lawId']),
    mst: pickFirst(raw, ['법령일련번호', 'MST', 'mst', 'lsiSeq', '일련번호', '판례일련번호', '해석례일련번호']),
    date: pickFirst(raw, ['시행일자', '공포일자', '선고일자', '의결일자', '생성일자', 'date']),
    summary: pickFirst(raw, ['요약', '질의요지', '회신요지', '판시사항', '판결요지', 'summary', '내용']),
    raw,
  };
}

function readSearchCandidates(payload: unknown, target: KoreanLawTarget) {
  if (!isRecord(payload)) return [];
  const lawSearch = isRecord(payload.LawSearch) ? payload.LawSearch : {};
  const expcSearch = isRecord(payload.Expc) ? payload.Expc : {};
  const precSearch = isRecord(payload.PrecSearch) ? payload.PrecSearch : {};
  const targetRoot = target === 'law' ? lawSearch : target === 'expc' ? expcSearch : precSearch;
  const directResults = [
    ...toArray(targetRoot[target] as Record<string, unknown> | Record<string, unknown>[]),
    ...toArray(targetRoot.law as Record<string, unknown> | Record<string, unknown>[]),
    ...toArray(targetRoot.expc as Record<string, unknown> | Record<string, unknown>[]),
    ...toArray(targetRoot.prec as Record<string, unknown> | Record<string, unknown>[]),
    ...toArray(payload[target] as Record<string, unknown> | Record<string, unknown>[]),
  ];

  return directResults.length ? directResults : collectObjects(payload);
}

function buildSearchUrl({ target, query, display = 5 }: SearchParams) {
  const searchParams = new URLSearchParams({
    target,
    query: normalizeText(query),
    display: String(display),
  });

  if (KSKILL_API_BASE) {
    return `${KSKILL_API_BASE}/v1/korean-law/search?${searchParams.toString()}`;
  }

  searchParams.set('OC', LAW_API_OC);
  searchParams.set('type', 'JSON');
  return `${FALLBACK_LAW_API_BASE}/lawSearch.do?${searchParams.toString()}`;
}

function buildDetailUrl({ target, mst, id, serialNumber, extraParams = {} }: DetailParams) {
  const searchParams = new URLSearchParams({
    target,
    ...extraParams,
  });
  const resolvedMst = normalizeText(mst || serialNumber);
  const resolvedId = normalizeText(id);
  if (resolvedMst) searchParams.set('MST', resolvedMst);
  if (resolvedId) searchParams.set('ID', resolvedId);

  if (KSKILL_API_BASE) {
    return `${KSKILL_API_BASE}/v1/korean-law/detail?${searchParams.toString()}`;
  }

  searchParams.set('OC', LAW_API_OC);
  searchParams.set('type', 'JSON');
  const path = target === 'law' ? 'lawService.do' : 'lawSearch.do';
  return `${FALLBACK_LAW_API_BASE}/${path}?${searchParams.toString()}`;
}

export async function searchKoreanLaw(params: SearchParams): Promise<KoreanLawResult[]> {
  const cleanQuery = normalizeText(params.query);
  if (!cleanQuery) return [];

  const response = await fetch(buildSearchUrl({ ...params, query: cleanQuery }));
  if (!response.ok) {
    throw new Error(`korean-law-search 검색 실패: ${response.status}`);
  }

  const payload = await response.json();
  return readSearchCandidates(payload, params.target)
    .map((item) => normalizeLawResult(item, params.target))
    .filter((item) => item.title || item.summary || item.lawId || item.mst)
    .slice(0, params.display ?? 5);
}

export async function getKoreanLawDetail(params: DetailParams): Promise<unknown> {
  const response = await fetch(buildDetailUrl(params));
  if (!response.ok) {
    throw new Error(`korean-law-search 상세 조회 실패: ${response.status}`);
  }
  return response.json();
}

export async function findVoucherLegalBasis(reason: string): Promise<VoucherLegalBasisResult> {
  const cleanReason = normalizeText(reason);
  if (!cleanReason) {
    return {
      legalBasis: [],
      lawResults: [],
      interpretationResults: [],
      precedentResults: [],
      errors: [],
    };
  }

  const evidenceTerms = Array.from(new Set(cleanReason.match(/[가-힣A-Za-z0-9]{2,}/g) ?? []))
    .filter((term) => !/판정|근거|키워드|신뢰도|주의|관련|부가가치세법|매입세액|공제|불공제|비공제|검토필요|추가|감지/.test(term))
    .slice(0, 5);
  const lawQuery = '부가가치세법';
  const caseQuery = evidenceTerms[0] || '매입세액 공제';
  const [lawSearch, interpretationSearch, precedentSearch] = await Promise.allSettled([
    searchKoreanLaw({ target: 'law', query: lawQuery, display: 3 }),
    searchKoreanLaw({ target: 'expc', query: caseQuery, display: 3 }),
    searchKoreanLaw({ target: 'prec', query: caseQuery, display: 3 }),
  ]);

  const lawResults = lawSearch.status === 'fulfilled' ? lawSearch.value : [];
  const interpretationResults = interpretationSearch.status === 'fulfilled' ? interpretationSearch.value : [];
  const precedentResults = precedentSearch.status === 'fulfilled' ? precedentSearch.value : [];

  return {
    legalBasis: [...lawResults, ...interpretationResults, ...precedentResults],
    lawResults,
    interpretationResults,
    precedentResults,
    errors: [lawSearch, interpretationSearch, precedentSearch]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason?.message ?? String(result.reason)),
  };
}
