/** 표준 레벤슈타인 편집거리 */
function levenshtein(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/** 0~1 유사도 (1이면 완전 일치). 부분 문자열 포함 시 가산점을 준다 — 발음 오차/오타에 관대하게. */
function similarity(a, b) {
  const al = a.toLowerCase().trim();
  const bl = b.toLowerCase().trim();
  if (!al || !bl) return 0;
  if (al === bl) return 1;
  if (bl.includes(al) || al.includes(bl)) return 0.9;
  const dist = levenshtein(al, bl);
  const maxLen = Math.max(al.length, bl.length);
  return 1 - dist / maxLen;
}

/**
 * candidates: [{ id, name, ...raw }] 형태의 배열에서 query와 가장 유사한 항목들을 반환.
 * threshold(기본 0.45) 이상만 후보로 남기고, 유사도 내림차순 정렬.
 */
function findBestMatches(query, candidates, { key = "name", threshold = 0.45, limit = 5 } = {}) {
  const scored = candidates
    .map((c) => ({ item: c, score: similarity(query, c[key]) }))
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => ({ ...s.item, matchScore: Math.round(s.score * 100) / 100 }));
}

module.exports = { levenshtein, similarity, findBestMatches };
