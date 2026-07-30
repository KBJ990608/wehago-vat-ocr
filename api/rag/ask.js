const OPENAI_URL = 'https://api.openai.com/v1/responses';
const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_LAW_PROXY = 'https://k-skill-proxy.nomadamas.org';
const MAX_QUERY_LENGTH = 800;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 8;

const requestBuckets = globalThis.__WEHAGO_CHAT_RATE_LIMIT__ || new Map();
globalThis.__WEHAGO_CHAT_RATE_LIMIT__ = requestBuckets;

function json(res, status, payload) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.json(payload);
}

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (Array.isArray(forwarded)) return forwarded[0] || 'unknown';
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim() || 'unknown';
  return req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(req) {
  const now = Date.now();
  const key = clientIp(req);
  const current = requestBuckets.get(key);

  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_MS) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return false;
  }

  current.count += 1;
  requestBuckets.set(key, current);
  return current.count > RATE_LIMIT_MAX;
}

function normalize(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function collectObjects(node, results = []) {
  if (!node || typeof node !== 'object') return results;
  if (Array.isArray(node)) {
    node.forEach((item) => collectObjects(item, results));
    return results;
  }

  const record = node;
  const keys = Object.keys(record);
  const looksLikeResult = keys.some((key) =>
    /법령명|안건명|해석례명|판례|사건명|질의|회신|제목|lawNm|title|case/i.test(key),
  );
  if (looksLikeResult) results.push(record);
  Object.values(record).forEach((value) => collectObjects(value, results));
  return results;
}

function pickFirst(raw, keys) {
  for (const key of keys) {
    const value = normalize(raw[key]);
    if (value) return value;
  }
  return '';
}

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function readCandidates(payload, target) {
  if (!isObject(payload)) return [];
  const lawSearch = isObject(payload.LawSearch) ? payload.LawSearch : {};
  const expcSearch = isObject(payload.Expc) ? payload.Expc : {};
  const precSearch = isObject(payload.PrecSearch) ? payload.PrecSearch : {};
  const targetRoot = target === 'law' ? lawSearch : target === 'expc' ? expcSearch : precSearch;
  const direct = [
    ...toArray(targetRoot[target]),
    ...toArray(targetRoot.law),
    ...toArray(targetRoot.expc),
    ...toArray(targetRoot.prec),
    ...toArray(payload[target]),
  ].filter(isObject);

  return direct.length ? direct : collectObjects(payload);
}

function normalizeResult(raw, target) {
  const title = pickFirst(raw, [
    '법령명한글', '법령명', '안건명', '해석례명', '판례명', '사건명', '제목', 'lawNm', 'title',
  ]);
  const docId = pickFirst(raw, [
    '판례일련번호', '해석례일련번호', '법령일련번호', '일련번호', 'MST', 'mst', 'ID', 'id', 'lawId',
  ]);
  const date = pickFirst(raw, ['시행일자', '공포일자', '선고일자', '의결일자', '생성일자', 'date']);
  const summary = pickFirst(raw, [
    '요약', '질의요지', '회신요지', '판시사항', '판결요지', 'summary', '내용', '본문',
  ]);

  return { target, title, docId, date, summary };
}

async function searchKoreanLaw(target, query, display = 3) {
  const base = (process.env.KSKILL_PROXY_BASE_URL || DEFAULT_LAW_PROXY).replace(/\/$/, '');
  const url = new URL(`${base}/v1/korean-law/search`);
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
    .map((raw) => normalizeResult(raw, target))
    .filter((item) => item.title || item.summary || item.docId)
    .slice(0, display);
}

function buildContext(hits) {
  return hits
    .map((hit, index) => {
      const typeLabel = hit.target === 'law' ? '법령' : hit.target === 'expc' ? '해석례' : '판례';
      return [
        `[${index + 1}] ${typeLabel}`,
        `제목: ${hit.title || '제목 없음'}`,
        hit.docId ? `문서번호: ${hit.docId}` : '',
        hit.date ? `일자: ${hit.date}` : '',
        hit.summary ? `요약: ${hit.summary.slice(0, 1400)}` : '',
      ].filter(Boolean).join('\n');
    })
    .join('\n\n---\n\n');
}

function extractOutputText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
    return payload.output_text.trim();
  }
  if (!Array.isArray(payload?.output)) return '';
  return payload.output
    .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
    .filter((content) => content?.type === 'output_text' && content?.text)
    .map((content) => content.text)
    .join('')
    .trim();
}

async function generateAnswer(query, hits, apiKey) {
  const context = buildContext(hits);
  const configuredModel = normalize(process.env.OPENAI_MODEL);
  const model = configuredModel && configuredModel !== 'gpt-5.6-sol' ? configuredModel : DEFAULT_MODEL;
  const response = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      instructions: [
        "당신은 한국 부가가치세 검토를 돕는 AI 어시스턴트 '루미'입니다.",
        '반드시 제공된 검색 근거 안에서만 답하고, 근거가 부족하면 단정하지 마세요.',
        '결론과 근거를 먼저 간결한 한국어 존댓말로 설명하세요.',
        '근거를 인용할 때는 [1], [2]처럼 자료 번호를 표시하세요.',
        '거래 목적, 공급받는 자, 증빙 형태 등 추가 사실관계가 필요하면 무엇을 확인해야 하는지 말하세요.',
        '최종 신고 판단은 최신 법령과 원본 증빙을 확인한 세무 전문가가 해야 한다는 문구를 짧게 덧붙이세요.',
        '사용자에게 주민등록번호, 계좌번호, 실제 고객명 같은 개인정보를 요구하지 마세요.',
      ].join(' '),
      input: `사용자 질문:\n${query}\n\n검색된 근거 자료:\n${context}\n\n위 자료만 근거로 답하세요.`,
      max_output_tokens: 700,
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`openai_${response.status}_${detail.slice(0, 300)}`);
  }

  const payload = await response.json();
  const text = extractOutputText(payload);
  if (!text) throw new Error('openai_empty_response');
  return text;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'POST 요청만 지원합니다.' });
  }

  if (isRateLimited(req)) {
    return json(res, 429, { error: '요청이 너무 많습니다. 약 10분 뒤 다시 시도해 주세요.' });
  }

  const apiKey = normalize(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    return json(res, 503, { error: '서버에 OpenAI API 키가 설정되지 않았습니다.' });
  }

  const body = isObject(req.body)
    ? req.body
    : (() => {
        try { return JSON.parse(req.body || '{}'); } catch { return {}; }
      })();
  const query = normalize(body.query);

  if (!query) return json(res, 400, { error: '질문을 입력해 주세요.' });
  if (query.length > MAX_QUERY_LENGTH) {
    return json(res, 400, { error: `질문은 ${MAX_QUERY_LENGTH}자 이내로 입력해 주세요.` });
  }

  try {
    const settled = await Promise.allSettled([
      searchKoreanLaw('law', '부가가치세법', 3),
      searchKoreanLaw('expc', query, 3),
      searchKoreanLaw('prec', query, 3),
    ]);
    const hits = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));

    if (!hits.length) {
      return json(res, 200, {
        answer: '질문과 관련된 법령·해석례·판례 자료를 찾지 못했습니다. 거래 목적과 증빙 형태를 조금 더 구체적으로 입력해 주세요.',
        generated: false,
        ai_connected: true,
        hits: [],
      });
    }

    const answer = await generateAnswer(query, hits, apiKey);
    return json(res, 200, {
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
    console.error('Lumi API error', error);
    return json(res, 500, {
      error: '루미 답변 생성 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }
}
