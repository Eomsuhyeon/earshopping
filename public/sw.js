/**
 * EarShopping 서비스 워커
 * ------------------------------------------------------------
 * 정적 파일(HTML/JS/아이콘)만 캐시해서 오프라인 상태에서도 앱 셸이 뜨도록 한다.
 * /api/* 요청은 항상 실제 데이터가 필요하므로 캐시하지 않고 네트워크로 그대로 보낸다.
 * (참고: 음성 인식·AI 모델·지도 연결은 인터넷이 반드시 필요하므로, 완전 오프라인
 *  동작은 되지 않는다 — 앱이 "뜨기만" 하는 수준의 캐싱이다.)
 *
 * 캐싱 전략은 "네트워크 우선"이다 — 온라인 상태면 항상 서버의 최신 파일을 받아오고,
 * 그 응답으로 캐시를 갱신해둔다. 네트워크 요청이 실패했을 때만(오프라인) 캐시로 폴백한다.
 * 예전의 "캐시 우선" 전략은 서버 파일을 업데이트해도 CACHE_NAME을 안 올리면 브라우저가
 * 계속 옛날 JS를 쓰는 문제가 있었다 — 이 방식이면 그 문제가 원천적으로 생기지 않는다.
 */
const CACHE_NAME = "earshopping-shell-v1";
const SHELL_FILES = [
  "/index.html",
  "/online.html",
  "/online.js",
  "/offline.html",
  "/offline.js",
  "/manifest.json",
  "/theme.css",
  "/icon.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 다른 출처 요청(웹폰트, CDN 등)은 가로채지 않고 브라우저가 원래 방식대로 처리하게 둔다.
  // 여기서 fetch()로 가로채면 요청이 서비스워커의 CSP(connect-src) 검사를 받게 되어,
  // 페이지가 <link>/<script>로는 허용된 출처(fonts.googleapis.com 등)여도 막혀버린다.
  if (url.origin !== self.location.origin) return;

  // API 요청은 항상 네트워크로 (캐시하지 않음 — 실시간 데이터 필요)
  if (url.pathname.startsWith("/api/")) return;

  // 그 외 정적 파일: 네트워크 우선 → 성공하면 캐시 갱신, 실패(오프라인)할 때만 캐시 사용
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
