// `/rag/ask`와 `/api/lumi`가 항상 같은 최신 공식 조문 기반 로직을 사용하도록
// 중복 구현을 두지 않고 단일 핸들러를 재사용한다.
export { default } from '../lumi.js';
