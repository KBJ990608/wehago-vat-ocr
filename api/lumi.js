const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4.1-mini';
const LAW_PROXY = (process.env.KSKILL_PROXY_BASE_URL || 'https://k-skill-proxy.nomadamas.org').replace(/\/$/, '');
const MAX_QUERY_LENGTH = 800;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 8;

const buckets = globalThis.__WEHAGO_LUMI_RATE_LIMIT__ || new Map();
globalThis.__WEHAGO_LUMI_RATE_LIMIT__ = buckets;

// 고정하는 정보는 질문 키워드와 확인할 법령·조문 번호뿐이다.
// 조문 원문, 시행일자, 요약과 공제 여부 결론은 반드시 공식 API 응답에서 가져온다.
const OFFICIAL_ARTICLE_ROUTES = [
  {
    test: /(접대비|기업업무추진비|접대 목적|유사한 비용)/,
    articles: [
      { lawName: '부가가치세법', articleNumber: '39' },
      { lawName: '부가가치세법 시행령', articleNumber: '79' },
    ],
  },
  {
    test: /(사업과 직접 관련이 없|업무무관|사적 사용|개인적 지출)/,
    articles: [{ lawName: '부가가치세법', articleNumber: '39' }],
  },
  {
    test: /(비영업용.*승용|소형승용|승용차|자동차.*구입|자동차.*임차|자동차.*유지)/,
    articles: [{ lawName: '부가가치세법', articleNumber: '39' }],
  },
  {
    test: /(면세사업|면세 매출|토지.*관련|공통매입세액)/,
    articles: [{ lawName: '부가가치세법', articleNumber: '39' }],
  },
];

function sendJson(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
}

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (Array.isArray(forwarded)) return forwarded[0] || 'unknown';
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim() || 'unknown';
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(req) {
  const key = getClientIp(req);
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    buckets.set(key, { startedAt: now, count: 1 });
    return false;
  }
  current.count += 1;
  buckets.set(key, current);
  return current.count > RATE_LIMIT_MAX;
}

function collectRecords(node, output = []) {
  if (!node || typeof node !== 'object') return output;
  if (Array.isArray(node)) {
    node.forEach((item) => collectRecords(item, output));
    return output;
  }

  const keys = Object.keys(node);
  if (keys.some((key) => /법령명|안건명|해석례명|판례|사건명|질의|회신|제목|lawNm|title|case/i.test(key))) {
    output.push(node);
  }
  Object.values(node).forEach((value) => collectRecords(value, output));
  return output;
}

function collectStrings(node, output = []) {
  if (typeof node === 'string') {
    const value = normalize(node);
    if (value.length >= 20 && value.length <= 8000) output.push(value);
    return output;
  }
  if (!node || typeof node !== 'object') return output;
  if (Array.isArray(node)) {
    node.forEach((item) => collectStrings(item, output));
    return output;
  }
  Object.values(node).forEach((value) => collectStrings(value, output));
  return output;
}

function arrayOf(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function pick(raw, keys) {
  for (const key of keys) {
    const value = normalize(raw[key]);
    if (value) return value;
  }
  return '';
}

function readCandidates(payload, target) {
  if (!isRecord(payload)) return [];
  const lawSearch = isRecord(payload.LawSearch) ? payload.LawSearch : {};
  const expcSearch = isRecord(payload.Expc) ? payload.Expc : {};
  const precSearch = isRecord(payload.PrecSearch) ? payload.PrecSearch : {};
  const root = target === 'law' ? lawSearch : target === 'expc' ? expcSearch : precSearch;
  const direct = [
    ...arrayOf(root[target]),
    ...arrayOf(root.law),
    ...arrayOf(root.expc),
    ...arrayOf(root.prec),
    ...arrayOf(payload[target]),
  ].filter(isRecord);
  return direct.length ? direct : collectRecords(payload);
}

function normalizeHit(raw, target) {
  return {
    target,
    title: pick(raw, ['법령명한글', '법령명', '안건명', '해석례명', '판례명', '사건명', '제목', 'lawNm', 'title']),
    docId: pick(raw, ['판례일련번호', '해석례일련번호', '법령일련번호', '일련번호', 'MST', 'mst', 'ID', 'id', 'lawId']),
    mst: pick(raw, ['법령일련번호', '판례일련번호', '해석례일련번호', '일련번호', 'MST', 'mst', 'lsiSeq']),
    id: pick(raw, ['법령ID', 'ID', 'id', 'lawId']),
    date: pick(raw, ['시행일자', '공포일자', '선고일자', '의결일자', '생성일자', 'date']),
    summary: pick(raw, ['요약', '질의요지', '회신요지', '판시사항', '판결요지', 'summary', '내용', '본문']),
  };
}

function articleRoutesForQuery(query) {
  const seen = new Set();
  return OFFICIAL_ARTICLE_ROUTES
    .filter((route) => route.test.test(query))
    .flatMap((route) => route.articles)
    .filter((article) => {
      const key = `${article.lawName}|${article.articleNumber}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function expandQuery(query) {
  const additions = articleRoutesForQuery(query)
    .map(({ lawName, articleNumber }) => `${lawName} 제${articleNumber}조`);
  return normalize([query, ...additions].join(' '));
}

function queryTokens(query) {
  return Array.from(new Set(normalize(query).match(/[가-힣A-Za-z0-9]{2,}/g) || []));
}

function relevantDetailText(payload, query) {
  const tokens = queryTokens(query);
  const scored = collectStrings(payload)
    .map((text) => {
      const tokenScore = tokens.reduce(
        (sum, token) => sum + (text.includes(token) ? Math.min(token.length, 5) : 0),
        0,
      );
      const legalScore = /제\d+조|매입세액|공제하지|불공제|기업업무추진비|접대비/.test(text) ? 6 : 0;
      return { text, score: tokenScore + legalScore };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  const unique = [];
  for (const item of scored) {
    if (unique.some((existing) => existing.includes(item.text) || item.text.includes(existing))) continue;
    unique.push(item.text);
    if (unique.length >= 4 || unique.join('\n').length >= 5000) break;
  }
  return unique.join('\n');
}

async function searchLaw(target, query, display = 5) {
  const url = new URL(`${LAW_PROXY}/v1/korean-law/search`);
  url.searchParams.set('target', target);
  url.searchParams.set('query', query);
  url.searchParams.set('display', String(display));

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`law_search_${target}_${response.status}`);

  const payload = await response.json();
  return readCandidates(payload, target)
    .map((raw) => normalizeHit(raw, target))
    .filter((hit) => hit.title || hit.summary || hit.docId)
    .slice(0, display);
}

async function fetchLawDetail(hit, query) {
  if (!hit.mst && !hit.id) return hit;
  const url = new URL(`${LAW_PROXY}/v1/korean-law/detail`);
  url.searchParams.set('target', hit.target);
  if (hit.mst) url.searchParams.set('MST', hit.mst);
  if (hit.id) url.searchParams.set('ID', hit.id);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) return hit;
    const payload = await response.json();
    const detail = relevantDetailText(payload, query);
    return detail ? { ...hit, summary: detail } : hit;
  } catch {
    return hit;
  }
}

function findArticleNode(node, articleNumber) {
  if (!node || typeof node !== 'object') return null;
  if (
    normalize(node.조문번호) === String(articleNumber)
    && normalize(node.조문여부 || '조문') === '조문'
  ) return node;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findArticleNode(item, articleNumber);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findArticleNode(value, articleNumber);
      if (found) return found;
    }
  }
  return null;
}

function collectArticleText(node, output = []) {
  if (!node || typeof node !== 'object') return output;
  const contentKeys = ['조문내용', '항내용', '호내용', '목내용'];
  for (const key of contentKeys) {
    const value = normalize(node[key]);
    if (value) output.push(value);
  }
  for (const [key, value] of Object.entries(node)) {
    if (contentKeys.includes(key)) continue;
    if (Array.isArray(value)) value.forEach((item) => collectArticleText(item, output));
    else if (value && typeof value === 'object') collectArticleText(value, output);
  }
  return output;
}

function findValue(node, keys) {
  if (!node || typeof node !== 'object') return '';
  for (const key of keys) {
    const value = normalize(node[key]);
    if (value && typeof node[key] !== 'object') return value;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findValue(item, keys);
        if (found) return found;
      }
    } else if (value && typeof value === 'object') {
      const found = findValue(value, keys);
      if (found) return found;
    }
  }
  return '';
}

async function fetchOfficialArticle(reference) {
  const candidates = await searchLaw('law', reference.lawName, 10);
  const law = candidates.find((candidate) => normalize(candidate.title) === reference.lawName);
  if (!law?.mst && !law?.id) throw new Error(`official_law_not_found_${reference.lawName}`);

  const url = new URL(`${LAW_PROXY}/v1/korean-law/detail`);
  url.searchParams.set('target', 'law');
  if (law.mst) url.searchParams.set('MST', law.mst);
  if (law.id) url.searchParams.set('ID', law.id);
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error(`official_law_detail_${response.status}`);

  const payload = await response.json();
  const article = findArticleNode(payload, reference.articleNumber);
  if (!article) throw new Error(`official_article_not_found_${reference.lawName}_${reference.articleNumber}`);
  const content = normalize(collectArticleText(article).join(' '));
  if (!content) throw new Error(`official_article_empty_${reference.lawName}_${reference.articleNumber}`);

  return {
    target: 'law',
    title: `${reference.lawName} 제${reference.articleNumber}조`,
    docId: law.mst || law.id,
    mst: law.mst,
    id: law.id,
    date: normalize(article.조문시행일자) || findValue(payload, ['시행일자']),
    summary: content,
    officialArticle: true,
  };
}

async function officialArticleHits(query) {
  const routes = articleRoutesForQuery(query);
  const results = await Promise.allSettled(routes.map(fetchOfficialArticle));
  return {
    requested: routes.length,
    hits: results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []),
    errors: results.flatMap((result) => result.status === 'rejected' ? [result.reason?.message || 'official_article_failed'] : []),
  };
}

function dedupeHits(hits) {
  const seen = new Set();
  return hits.filter((hit) => {
    const key = `${hit.target}|${hit.docId}|${hit.title}|${hit.summary.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildContext(hits) {
  return hits.slice(0, 8).map((hit, index) => {
    const type = hit.target === 'law' ? '법령' : hit.target === 'expc' ? '해석례' : '판례';
    return [
      `[${index + 1}] ${type}${hit.officialArticle ? ' · 공식 최신 조문 원문' : ''}`,
      `제목: ${hit.title || '제목 없음'}`,
      hit.docId ? `문서번호: ${hit.docId}` : '',
      hit.date ? `일자: ${hit.date}` : '',
      hit.summary ? `내용: ${hit.summary.slice(0, 5000)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n---\n\n');
}

function extractChatText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || '').join('').trim();
  }
  return '';
}

async function askOpenAI(query, hits, apiKey) {
  const response = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        {
          role: 'system',
          content: [
            "당신은 한국 부가가치세 검토를 돕는 AI 어시스턴트 '루미'입니다.",
            '반드시 제공된 검색 근거 안에서만 답하고 근거가 부족하면 단정하지 마세요.',
            '공식 최신 조문 원문이 있으면 그 원문의 현재 문언을 최우선 근거로 사용하세요.',
            '코드에 미리 정해진 세무 결론이 있다고 가정하지 말고, 제공된 최신 원문에서만 결론을 도출하세요.',
            '시행일자와 조문 내용은 검색 근거에 표시된 값만 사용하고 추측하지 마세요.',
            '예외나 사실관계에 따라 달라질 수 있는 부분만 별도로 구분하세요.',
            '답변은 결론, 근거, 확인할 사항 순서로 간결한 한국어 존댓말로 작성하세요.',
            '근거는 [1], [2]처럼 자료 번호를 표시하세요.',
            '최종 신고 판단은 최신 법령과 원본 증빙을 확인한 세무 전문가가 해야 한다고 짧게 덧붙이세요.',
            '주민등록번호, 계좌번호, 실제 고객명 등 개인정보를 요구하지 마세요.',
          ].join(' '),
        },
        {
          role: 'user',
          content: `질문:\n${query}\n\n검색된 근거:\n${buildContext(hits)}\n\n위 근거만 사용해 질문에 직접 답하세요.`,
        },
      ],
      max_completion_tokens: 900,
      temperature: 0.1,
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`openai_${response.status}_${detail.slice(0, 500)}`);
  }

  const payload = await response.json();
  const text = extractChatText(payload);
  if (!text) {
    throw new Error(`openai_empty_chat_response_${JSON.stringify({ id: payload?.id, finish_reason: payload?.choices?.[0]?.finish_reason })}`);
  }
  return text;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'POST 요청만 지원합니다.' });
  }
  if (isRateLimited(req)) {
    return sendJson(res, 429, { error: '요청이 너무 많습니다. 약 10분 뒤 다시 시도해 주세요.' });
  }

  const apiKey = normalize(process.env.OPENAI_API_KEY);
  if (!apiKey) return sendJson(res, 503, { error: '서버에 OpenAI API 키가 설정되지 않았습니다.' });

  const body = isRecord(req.body) ? req.body : {};
  const query = normalize(body.query);
  if (!query) return sendJson(res, 400, { error: '질문을 입력해 주세요.' });
  if (query.length > MAX_QUERY_LENGTH) return sendJson(res, 400, { error: `질문은 ${MAX_QUERY_LENGTH}자 이내로 입력해 주세요.` });

  try {
    const expanded = expandQuery(query);
    const results = await Promise.allSettled([
      searchLaw('law', expanded, 5),
      searchLaw('expc', expanded, 5),
      searchLaw('prec', expanded, 5),
    ]);
    const searchedHits = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
    const detailedHits = await Promise.all(
      searchedHits.slice(0, 6).map((hit) => fetchLawDetail(hit, expanded)),
    );
    const officialArticles = await officialArticleHits(query);
    if (officialArticles.requested && !officialArticles.hits.length) {
      console.warn('Lumi official article lookup failed', officialArticles.errors);
      return sendJson(res, 200, {
        answer: '최신 공식 조문 원문을 확인하지 못해 공제 여부를 단정할 수 없습니다. 잠시 후 다시 질문하거나 국가법령정보센터에서 해당 조문을 직접 확인해 주세요.',
        generated: false,
        ai_connected: true,
        hits: [],
      });
    }
    const hits = dedupeHits([...officialArticles.hits, ...detailedHits, ...searchedHits]).slice(0, 10);

    if (!hits.length) {
      return sendJson(res, 200, {
        answer: '관련 법령·해석례·판례를 찾지 못했습니다. 거래 목적과 증빙 형태를 조금 더 구체적으로 입력해 주세요.',
        generated: false,
        ai_connected: true,
        hits: [],
      });
    }

    const answer = await askOpenAI(query, hits, apiKey);
    return sendJson(res, 200, {
      answer,
      generated: true,
      ai_connected: true,
      hits: hits.slice(0, 6).map((hit, index) => ({
        doc_id: hit.docId || `source-${index + 1}`,
        score: 0,
        title: hit.title || '관련 자료',
        doc_type: hit.target === 'law' ? '법령' : hit.target === 'expc' ? '해석례' : '판례',
        date: hit.date || '-',
      })),
    });
  } catch (error) {
    console.error('Lumi live API error', error);
    return sendJson(res, 500, { error: '루미 답변 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.' });
  }
}
