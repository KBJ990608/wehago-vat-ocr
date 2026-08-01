import { normalizeText } from './rules.js';

const LAW_API_OC = typeof __LAW_API_OC__ === 'string' ? __LAW_API_OC__ : '';
const KSKILL_PROXY_BASE_URL =
  typeof __KSKILL_PROXY_BASE_URL__ === 'string'
    ? __KSKILL_PROXY_BASE_URL__.replace(/\/$/, '')
    : 'https://k-skill-proxy.nomadamas.org';
const LAW_API_BASE = import.meta.env?.DEV ? '/DRF' : 'https://www.law.go.kr/DRF';
const KSKILL_API_BASE = import.meta.env?.DEV ? '/kskill' : KSKILL_PROXY_BASE_URL;

const MONITORED_LAW_QUERIES = [
  { title: '부가가치세법', articleNumbers: ['26', '38', '39'], keyPrefix: 'vat-act' },
  { title: '부가가치세법 시행령', articleNumbers: ['79'], keyPrefix: 'vat-decree' },
];

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getLawList(payload) {
  return toArray(payload?.LawSearch?.law ?? payload?.law ?? payload?.laws);
}

function getLawTitle(law) {
  return normalizeText(law?.법령명한글 ?? law?.법령명_한글 ?? law?.법령명 ?? law?.lawNm ?? law?.법령약칭명 ?? '');
}

function findFirstValue(node, keys) {
  if (!node || typeof node !== 'object') return '';
  for (const key of keys) {
    if (node[key] && typeof node[key] !== 'object') return normalizeText(node[key]);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findFirstValue(item, keys);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findFirstValue(value, keys);
      if (found) return found;
    }
  }
  return '';
}

function findArticleUnits(node, articleNumbers, units = []) {
  if (!node || typeof node !== 'object') return units;
  if (
    articleNumbers.includes(String(node.조문번호))
    && normalizeText(node.조문여부 || '조문') === '조문'
  ) {
    units.push(node);
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => findArticleUnits(item, articleNumbers, units));
    else if (value && typeof value === 'object') findArticleUnits(value, articleNumbers, units);
  }
  return units;
}

function collectArticleContent(node, parts = []) {
  if (!node || typeof node !== 'object') return parts;
  const contentKeys = ['조문내용', '항내용', '호내용', '목내용'];
  for (const key of contentKeys) {
    if (typeof node[key] === 'string' && normalizeText(node[key])) parts.push(node[key]);
  }
  for (const [key, value] of Object.entries(node)) {
    if (contentKeys.includes(key)) continue;
    if (Array.isArray(value)) value.forEach((item) => collectArticleContent(item, parts));
    else if (value && typeof value === 'object') collectArticleContent(value, parts);
  }
  return parts;
}

function pickExactLaw(laws, expectedTitle) {
  return laws.find((law) => getLawTitle(law) === expectedTitle);
}

async function fetchJson(path, params) {
  const searchParams = new URLSearchParams({ ...params });
  let url;
  if (KSKILL_API_BASE && path === 'lawSearch.do') {
    searchParams.delete('OC');
    searchParams.delete('type');
    url = `${KSKILL_API_BASE}/v1/korean-law/search?${searchParams.toString()}`;
  } else if (KSKILL_API_BASE && path === 'lawService.do') {
    searchParams.delete('OC');
    searchParams.delete('type');
    url = `${KSKILL_API_BASE}/v1/korean-law/detail?${searchParams.toString()}`;
  } else {
    searchParams.set('OC', LAW_API_OC);
    searchParams.set('type', 'JSON');
    url = `${LAW_API_BASE}/${path}?${searchParams.toString()}`;
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`법제처 API 요청 실패: ${response.status}`);
  return response.json();
}

async function fetchLawDetail(query) {
  const searchPayload = await fetchJson('lawSearch.do', {
    target: 'law',
    query: query.title,
    display: '20',
  });
  const law = pickExactLaw(getLawList(searchPayload), query.title);
  if (!law) throw new Error(`${query.title} 검색 결과를 찾지 못했습니다.`);

  const lawId = normalizeText(law?.법령ID ?? law?.ID ?? law?.lawId);
  const mst = normalizeText(law?.법령일련번호 ?? law?.MST ?? law?.mst ?? law?.lsiSeq);
  if (!lawId && !mst) throw new Error(`${query.title}의 법령ID 또는 MST를 찾지 못했습니다.`);

  let detailPayload;
  try {
    detailPayload = await fetchJson('lawService.do', {
      target: 'law',
      ...(mst ? { MST: mst } : { ID: lawId }),
    });
  } catch (error) {
    if (!lawId || mst === lawId) throw error;
    detailPayload = await fetchJson('lawService.do', { target: 'law', ID: lawId });
  }

  const units = findArticleUnits(detailPayload, query.articleNumbers);
  const checkedAt = new Date().toISOString();
  const snapshots = query.articleNumbers.map((articleNumber) => {
    const unit = units.find((candidate) => String(candidate.조문번호) === articleNumber);
    if (!unit) return null;
    return {
      key: `${query.keyPrefix}-${articleNumber}`,
      lawName: query.title,
      articleNumber,
      articleLabel: `${query.title} 제${articleNumber}조`,
      content: collectArticleContent(unit).join(' '),
      enforcementDate: normalizeText(unit.조문시행일자) || findFirstValue(detailPayload, ['시행일자', 'enforcementDate']),
      promulgationDate: findFirstValue(detailPayload, ['공포일자', 'promulgationDate']),
      lawId,
      mst,
      checkedAt,
    };
  });

  return {
    title: query.title,
    lawId,
    mst,
    promulgationDate: findFirstValue(detailPayload, ['공포일자', 'promulgationDate']),
    enforcementDate: findFirstValue(detailPayload, ['시행일자', 'enforcementDate']),
    ministry: findFirstValue(detailPayload, ['소관부처명', '소관부처', 'ministry']),
    snapshots,
    detail: detailPayload,
  };
}

export async function fetchMonitoredLaws() {
  if (!KSKILL_API_BASE && !LAW_API_OC) throw new Error('LAW_API_OC 환경변수가 설정되지 않았습니다.');

  const results = await Promise.allSettled(MONITORED_LAW_QUERIES.map(fetchLawDetail));
  const laws = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const errors = results
    .map((result, index) => (result.status === 'rejected' ? `${MONITORED_LAW_QUERIES[index].title}: ${result.reason?.message || '조회 실패'}` : ''))
    .filter(Boolean);
  const snapshots = laws.flatMap((law) => law.snapshots).filter(Boolean);
  if (!snapshots.length) throw new Error(errors.join(' / ') || '감시 대상 법령을 찾지 못했습니다.');

  const act = laws.find((law) => law.title === '부가가치세법');
  const articleReferences = Object.fromEntries(
    (act?.snapshots ?? []).map((snapshot) => [
      `article${snapshot.articleNumber}`,
      {
        label: snapshot.articleLabel,
        title: snapshot.content.split(/(?=①|②|③)/)[0],
        excerpt: snapshot.content,
      },
    ]),
  );

  return {
    title: act?.title || '부가가치세법',
    lawId: act?.lawId || '',
    mst: act?.mst || '',
    promulgationDate: act?.promulgationDate || '',
    enforcementDate: act?.enforcementDate || '',
    ministry: act?.ministry || '',
    articleReferences,
    snapshots,
    errors,
    checkedAt: new Date().toISOString(),
  };
}

export const fetchVatAct = fetchMonitoredLaws;
