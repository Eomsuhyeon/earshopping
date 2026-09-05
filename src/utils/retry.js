/** 지수 백오프 재시도. retryable:false로 표시된 에러(예: 401/403 인증 오류)는 즉시 포기한다 — 재시도해도 결과가 같기 때문. */
async function withRetry(fn, { retries = 2, baseDelayMs = 400 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e && e.retryable === false) break;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

/** AbortController 기반 fetch 타임아웃 래퍼. 응답 없는 외부 API에 무한정 매달리지 않도록 한다. */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

class ExternalApiError extends Error {
  constructor(message, code, { retryable = true } = {}) {
    super(message);
    this.name = "ExternalApiError";
    this.code = code; // "NO_KEY" | "HTTP_ERROR" | "TIMEOUT" | ...
    this.retryable = retryable; // false면 withRetry가 즉시 포기 (예: 401/403/404 같은 영구적 오류)
  }
}

/** HTTP 상태코드로 재시도 가치가 있는지 판단 — 429(rate limit)/5xx만 재시도, 나머지 4xx는 즉시 포기 */
function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

module.exports = { withRetry, fetchWithTimeout, ExternalApiError, isRetryableStatus };
