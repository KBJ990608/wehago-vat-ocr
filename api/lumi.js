const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_MODEL = 'gpt-4.1-mini';
const LAW_PROXY = (process.env.KSKILL_PROXY_BASE_URL || 'https://k-skill-proxy.nomadamas.org').replace(/\/$/, '');
const MAX_QUERY_LENGTH = 800;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX = 8;

const buckets = globalThis.__WEHAGO_LUMI_RATE_LIMIT__ || new Map();
globalThis.__WEHAGO_LUMI_RATE_LIMIT__ = buckets;

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
    date: pick(raw, ['시행일자', '공포일자', '선고일자', '의결일자', '생성일자', 'date']),
    summary: pick(raw, ['요약', '질의요지', '회신요지', '판시사항', '판결요지', 'summary', '내용', '본문']),
  };
}

async function searchLaw(target, query, display = 3) {
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

function buildContext(hits) {
  return hits.map((hit, index) => {
    const type = hit.target === 'law' ? '법령' : hit.target === 'expc' ? '해석례' : '판례';
    return [
      `[${index + 1}] ${type}`,
      `제목: ${hit.title || '제목 없음'}`,
      hit.docId ? `문서번호: ${hit.docId}` : '',
      hit.date ? `일자: ${hit.date}` : '',
      hit.summary ? `내용: ${hit.summary.slice(0, 1400)}` : '',
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
            '결론부터 간결한 한국어 존댓말로 답하고 [1], [2]처럼 근거 번호를 표시하세요.',
            '필요한 추가 사실관계와 증빙을 알려주고, 최종 신고 판단은 최신 법령과 원본 증빙을 확인한 세무 전문가가 해야 한다고 덧붙이세요.',
            '주민등록번호, 계좌번호, 실제 고객명 등 개인정보를 요구하지 마세요.',
          ].join(' '),
        },
        {
          role: 'user',
          content: `질문:\n${query}\n\n검색된 근거:\n${buildContext(hits)}\n\n위 근거만 사용해 답하세요.`,
        },
      ],
      max_completion_tokens: 700,
      temperature: 0.2,
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
    const results = await Promise.allSettled([
      searchLaw('law', '부가가치세법', 3),
      searchLaw('expc', query, 3),
      searchLaw('prec', query, 3),
    ]);
    const hits = results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);

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
