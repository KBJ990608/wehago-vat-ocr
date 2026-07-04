import { normalizeText } from './rules';

const LAW_API_OC = typeof __LAW_API_OC__ === 'string' ? __LAW_API_OC__ : '';
const KSKILL_PROXY_BASE_URL =
  typeof __KSKILL_PROXY_BASE_URL__ === 'string' ? __KSKILL_PROXY_BASE_URL__.replace(/\/$/, '') : '';
const LAW_API_BASE = import.meta.env.DEV ? '/DRF' : 'https://www.law.go.kr/DRF';
const KSKILL_API_BASE = import.meta.env.DEV ? '/kskill' : KSKILL_PROXY_BASE_URL;

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function getLawList(payload) {
  return toArray(payload?.LawSearch?.law ?? payload?.law ?? payload?.laws);
}

function getLawTitle(law) {
  return normalizeText(law?.법령명한글 ?? law?.법령명 ?? law?.lawNm ?? law?.법령약칭명 ?? '');
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

function findArticleUnits(node, articles = {}) {
  if (!node || typeof node !== 'object') return articles;

  if (node.조문번호 && ['26', '38', '39'].includes(String(node.조문번호))) {
    const articleNumber = String(node.조문번호);
    const title = normalizeText(node.조문내용 ?? `제${articleNumber}조`);
    const paragraphs = toArray(node.항)
      .map((paragraph) => normalizeText(paragraph?.항내용))
      .filter(Boolean)
      .slice(0, 2);

    articles[`article${articleNumber}`] = {
      label: `부가가치세법 제${articleNumber}조`,
      title,
      excerpt: paragraphs.join(' '),
    };
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach((item) => findArticleUnits(item, articles));
    } else if (value && typeof value === 'object') {
      findArticleUnits(value, articles);
    }
  }

  return articles;
}

function pickVatAct(laws) {
  return laws
    .filter((law) => getLawTitle(law).includes('부가가치세법'))
    .sort((left, right) => {
      const leftTitle = getLawTitle(left);
      const rightTitle = getLawTitle(right);
      const leftExact = leftTitle === '부가가치세법' ? 1 : 0;
      const rightExact = rightTitle === '부가가치세법' ? 1 : 0;
      const leftSub = /시행령|시행규칙/.test(leftTitle) ? 1 : 0;
      const rightSub = /시행령|시행규칙/.test(rightTitle) ? 1 : 0;
      return rightExact - leftExact || leftSub - rightSub;
    })[0];
}

async function fetchJson(path, params) {
  const searchParams = new URLSearchParams({
    ...params,
  });
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
  if (!response.ok) {
    throw new Error(`법제처 API 요청 실패: ${response.status}`);
  }

  return response.json();
}

export async function fetchVatAct() {
  if (!KSKILL_API_BASE && !LAW_API_OC) {
    throw new Error('LAW_API_OC 환경변수가 설정되지 않았습니다.');
  }

  const searchPayload = await fetchJson('lawSearch.do', {
    target: 'law',
    query: '부가가치세법',
    display: '20',
  });
  const law = pickVatAct(getLawList(searchPayload));

  if (!law) {
    throw new Error('lawSearch.do 검색 결과에서 부가가치세법을 찾지 못했습니다.');
  }

  const lawId = normalizeText(law?.법령ID ?? law?.ID ?? law?.lawId);
  const mst = normalizeText(law?.법령일련번호 ?? law?.MST ?? law?.mst ?? law?.lsiSeq);

  if (!lawId && !mst) {
    throw new Error('부가가치세법 법령ID 또는 법령일련번호를 찾지 못했습니다.');
  }

  let detailPayload;
  try {
    detailPayload = await fetchJson('lawService.do', {
      target: 'law',
      ...(lawId ? { ID: lawId } : { MST: mst }),
    });
  } catch (error) {
    if (!mst || lawId === mst) throw error;
    detailPayload = await fetchJson('lawService.do', {
      target: 'law',
      MST: mst,
    });
  }

  return {
    title: getLawTitle(law),
    lawId,
    mst,
    promulgationDate: findFirstValue(detailPayload, ['공포일자', 'promulgationDate']),
    enforcementDate: findFirstValue(detailPayload, ['시행일자', 'enforcementDate']),
    ministry: findFirstValue(detailPayload, ['소관부처명', '소관부처', 'ministry']),
    articleReferences: findArticleUnits(detailPayload),
    searchResult: law,
    detail: detailPayload,
  };
}
