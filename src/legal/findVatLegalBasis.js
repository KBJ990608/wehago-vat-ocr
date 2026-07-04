import { searchKoreanLaw } from '../services/lawSearchService.ts';

function normalizeReason(reason) {
  return String(reason ?? '').replace(/\s+/g, ' ').trim();
}

export async function findVatLegalBasis(reason) {
  const cleanReason = normalizeReason(reason);
  if (!cleanReason) {
    return {
      lawResults: [],
      interpretationResults: [],
      errors: [],
    };
  }

  const [lawSearch, interpretationSearch] = await Promise.allSettled([
    searchKoreanLaw({
      target: 'law',
      query: `부가가치세법 ${cleanReason} 매입세액 불공제`,
    }),
    searchKoreanLaw({
      target: 'expc',
      query: `${cleanReason} 부가가치세 매입세액 공제`,
    }),
  ]);

  return {
    lawResults: lawSearch.status === 'fulfilled' ? lawSearch.value : [],
    interpretationResults: interpretationSearch.status === 'fulfilled' ? interpretationSearch.value : [],
    errors: [lawSearch, interpretationSearch]
      .filter((result) => result.status === 'rejected')
      .map((result) => result.reason?.message ?? String(result.reason)),
  };
}
