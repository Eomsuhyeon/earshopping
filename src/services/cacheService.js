/**
 * 단순 TTL 인메모리 캐시. 프로세스가 여러 개로 스케일아웃되면 Redis 등으로
 * 교체해야 하지만, 단일 인스턴스 기준으로는 API 호출량을 크게 줄여준다.
 */
class TtlCache {
  constructor(ttlMs) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }
  get(key) {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }
  set(key, value) {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
  get size() {
    return this.store.size;
  }
}

module.exports = { TtlCache, searchCache: new TtlCache(5 * 60 * 1000) };

