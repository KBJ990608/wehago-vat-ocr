import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../api/lumi.js', import.meta.url), 'utf8');
const ragRouteSource = await readFile(new URL('../api/rag/ask.js', import.meta.url), 'utf8');
const routeBlock = source.match(/const OFFICIAL_ARTICLE_ROUTES = (\[[\s\S]*?\n\]);/)?.[1] || '';

assert.ok(routeBlock, '질문 키워드와 공식 조문 경로 매핑이 있어야 합니다.');
assert.doesNotMatch(source, /OFFICIAL_CORE_RULES|officialRuleHits/);
assert.doesNotMatch(routeBlock, /summary\s*:|date\s*:|공제하지|불공제 결론|원칙적으로/);
assert.doesNotMatch(source, /date:\s*['"]20\d{2}-\d{2}-\d{2}['"]/);
assert.match(source, /async function fetchOfficialArticle/);
assert.match(source, /findArticleNode\(payload, reference\.articleNumber\)/);
assert.match(source, /date:\s*normalize\(article\.조문시행일자\)/);
assert.match(source, /summary:\s*content/);
assert.match(source, /공식 최신 조문 원문/);
assert.match(source, /최신 공식 조문 원문을 확인하지 못해 공제 여부를 단정할 수 없습니다/);
assert.match(ragRouteSource, /export \{ default \} from '\.\.\/lumi\.js'/);
assert.match(source, /function formatLegalDate/);
assert.match(source, /date: formatLegalDate\(hit\.date\)/);
assert.match(source, /법률상 공제·불공제 사유와 세금계산서·카드전표 등 증빙 요건은 서로 다른 판단 단계로 구분/);
assert.match(source, /적격 증빙이 있다는 이유만으로 법률상 불공제 대상이 공제 대상으로 바뀐다고 설명하지 마세요/);

console.log('lumi grounding checks: 15 passed');
