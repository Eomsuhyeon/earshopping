# EarShopping — 전체 아키텍처

시각장애인을 위한 음성 기반 온라인 쇼핑 + 오프라인 백화점 매장 안내 서비스.
Node.js/Express 백엔드 하나가 정적 프론트엔드(순수 HTML/CSS/JS) 세 페이지를 서빙하고,
동일 서버가 REST API로 온라인·오프라인 두 도메인의 로직을 모두 처리하는 **모놀리식 구조**다.

## 1. 최상위 구조

```
earshopping/
├── public/                  프론트엔드 (정적 파일, 빌드 도구 없음)
│   ├── index.html + landing.js      랜딩 — 온라인/오프라인 모드 선택
│   ├── online.html + online.js       온라인 쇼핑 (음성 검색·설명·가격·취향·체형)
│   ├── offline.html + offline.js     오프라인 매장 내비게이션 (6화면 + 카메라 AI)
│   ├── theme.css                      3페이지 공유 디자인 시스템
│   ├── manifest.json, sw.js, icon.svg  PWA
├── src/
│   ├── config.js              환경변수 로드·검증 (zod), 유일한 설정 출처
│   ├── server.js               Express 앱 조립 (보안/로깅/에러 처리)
│   ├── index.js                 엔트리포인트 (기동, graceful shutdown)
│   ├── data/stores.json         실제 백화점 4곳 데이터 (로컬 DB 대용)
│   ├── routes/                   HTTP 요청 처리 (8개 라우터)
│   ├── services/                  비즈니스 로직 (7개 서비스)
│   └── utils/                      재시도/캐시/퍼지매칭/로거
└── tests/                    node:test 단위 테스트 61개
```

## 2. 클라이언트 아키텍처

세 페이지는 서로 완전히 독립된 정적 HTML+JS이며, 프레임워크나 번들러가 없다. 공유하는 것은
`theme.css`(디자인 토큰)와 `manifest.json`/`sw.js`(PWA)뿐이다.

| 페이지 | 역할 | 브라우저 API 직접 사용 |
| --- | --- | --- |
| `index.html` | 온라인/오프라인 진입점, 음성으로도 선택 가능 | Web Speech API |
| `online.html` | 음성 쇼핑 전체 (검색→상세→가격/취향/체형→오프라인 전환) | Web Speech API |
| `offline.html` | 매장 선택→메뉴→찾기→경로→층별안내→카메라 동행 6화면 | Web Speech API, `getUserMedia`, Geolocation, Vibration |

**음성 우선 상태 머신 패턴**: 두 메인 페이지(`online.js`, `offline.js`) 모두 동일한 패턴을 쓴다.
1. 발화 인식(STT) → 로컬에서 처리 가능한 명령(설정 변경 등)인지 먼저 확인
2. 아니면 서버의 `/api/command`(또는 `/api/offline/command`)로 보내 액션으로 분류
3. 액션에 따라 화면 갱신 + 결과를 TTS로 낭독
4. 낭독이 끝나면 자동으로 다시 듣기 시작(연속 듣기 모드), 마이크 클릭/Space는 재생 중인 TTS를 즉시 끊고 끼어들기(barge-in) 가능

**카메라 AI 모드(오프라인 6번 화면)**만 예외적으로 무거운 외부 라이브러리를 클라이언트에서 직접 로드한다:
TensorFlow.js + coco-ssd(물체 인식, jsdelivr CDN), Tesseract.js(OCR, jsdelivr CDN). 이미지 자체는
서버로 전송되지 않고, 인식된 라벨/색상만 `/api/offline/browse/describe-scene`으로 보내 문장을 만든다.

## 3. 서버 아키텍처

```
server.js
 ├─ helmet (CSP: 폰트·AI모델 CDN 화이트리스트)
 ├─ compression, morgan, express-rate-limit
 ├─ express.static(public/)
 └─ routes/*  (모두 zod로 요청 검증 후 services/* 호출)
```

### 라우트 (8개)

| 라우트 | 담당 |
| --- | --- |
| `command.js` | 온라인 자연어 명령 분류 (20개 액션) |
| `searchProducts.js` | 온라인 검색 파이프라인 (검색조건 이해→eBay→정규화→최저가) |
| `describeProduct.js` | 상품 상세 음성 설명 (+ 후속 제안) |
| `onlineExtras.js` | 스타일 설명 / 취향 매칭 / 체형 비교 |
| `offline.js` | 매장 목록/상세/층/검색/경로/명령분류/장면설명/간판인식 (오프라인 전체) |
| `status.js` | 각 LLM·eBay 연결 상태 확인 |

### 서비스 (7개) — 실제 로직이 있는 곳

| 서비스 | 책임 |
| --- | --- |
| `groqService.js` | LLM 호출 통합 창구. **Groq→Gemini→OpenRouter 3단계 폴백**, 검색조건 추출, 명령 분류, 설명 생성 |
| `ebayService.js` | eBay OAuth 토큰 캐싱 + Browse API 검색 |
| `storeDataService.js` | 매장 데이터 조회, 거리순 정렬, 편집거리 기반 브랜드 검색, 경로 스크립트 생성 |
| `pricingService.js` | 배송비 포함 최저가 계산, 체형 비교 답변 — **AI 아닌 순수 코드 로직** |
| `commandService.js` | Groq 없이도 동작하는 규칙 기반 명령 분류 폴백, Product 정규화 |
| `demoService.js` | eBay 키 미설정/실패 시 검색어 인식 가능한 데모 데이터 |
| `cacheService.js` | 5분 TTL 인메모리 캐시 (검색 결과 재사용) |

`storeDataService.js`의 `loadStores()` 함수 하나만 Firestore 조회로 바꾸면 로컬 JSON 대신
실제 DB로 전환 가능하도록 어댑터 형태로 분리되어 있다.

## 4. 핵심 데이터 흐름

### 온라인 검색 (`POST /api/search-products`)
```
발화(한국어) → groqService.extractIntent (한→영 번역+조건추출)
            → ebayService.searchEbayRaw (실패시 demoService 폴백)
            → groqService.enrichProductsWithGroq (브랜드/색상/소재 추출)
            → commandService.toProduct (표준 스키마 정규화)
            → pricingService.computeLowestPrice (배송비 포함, 코드 계산)
```

### 오프라인 매장 경로 안내 (`POST /api/offline/stores/:id/route`)
```
목적지 발화 → storeDataService.searchBrandInStore (편집거리 매칭)
   ├─ 매칭 성공 → 정문→엘리베이터→도착→문의 4단계 스크립트
   └─ 매칭 실패 → 층별 tags로 카테고리 폴백 ("노란색 옷" → 여성패션 층 안내)
```

### 랜드마크 기반 실내 경로 재탐색 (`POST /api/offline/stores/:id/landmark-route`)
```
카메라 OCR로 간판 인식(예: "아디다스") → routeGraphService.buildGraph (매장을
  층=허브/브랜드=리프 노드 그래프로 모델링) → dijkstra(from=인식된 간판, to=목적지)
  → narratePath (계산된 경로만 문장으로 변환, LLM은 여기서 아무 역할도 하지 않음)
```
경로 계산은 전부 코드(다익스트라)가 담당하고, LLM은 이 계산 결과를 다듬는 것조차 하지 않는다
(narratePath가 이미 사람이 읽기 자연스러운 문장을 만들기 때문). 실측 도면 좌표가 없는 상태의
근사 모델이라 실제 최단 동선과는 다를 수 있지만, "없는 길을 지어내는" 위험은 원천적으로 없다.

### 명령 분류 (`/api/command`, `/api/offline/command`)
```
발화 → groqService.classifyCommand(Offline) (AI, 화면 맥락 반영)
     실패 시 → commandService.classifyCommand(Offline)Fallback (정규식 기반)
     → 지원 액션 목록에 없으면 반드시 unsupported
```

### 온라인 ↔ 오프라인 상호 연계
```
온라인 "직접 입어보고 싶어" → 상품의 브랜드로 findBrandAcrossStores 조회
                            → sessionStorage로 오프라인 화면에 handoff → 자동 매장 안내

오프라인 매장에서 브랜드 확인/카메라로 옷 색상 확인 → state.lastContextQuery 갱신
오프라인 "온라인에서 보고싶어" → sessionStorage로 온라인 화면에 handoff → 자동 검색 실행
```

## 5. 안정성 설계

- **재시도 정책** (`utils/retry.js`): 429/5xx만 재시도, 401/403/404 등 "다시 해도 똑같은" 에러는 즉시 포기
- **LLM 폴백**: 같은 계정 내 모델 문제는 다음 모델로, 계정 자체 문제(인증 실패 등)는 같은 키를 쓰는 나머지 후보를 건너뛰고 곧장 다른 제공자로
- **입력 검증**: 모든 라우트가 zod 스키마로 요청 본문 검증
- **PWA 캐싱**: 서비스워커는 **네트워크 우선** 전략 — 온라인이면 항상 최신 파일, 오프라인일 때만 캐시 폴백(배포 후 캐시 무효화 문제 방지)

## 6. 테스트

`tests/` 아래 69개 단위 테스트(node:test, 외부 의존성 없음)가 핵심 로직을 커버한다: 최저가/체형
계산, 온·오프라인 명령 분류(AI 없이도), 매장 검색/경로, 랜드마크 그래프 최단경로 계산(다익스트라),
데모 데이터 검색어 반영, LLM 3단계 폴백 전환 로직(fetch 모킹). 프론트엔드 쪽 DOM 동작은 Playwright로
수동 검증한다(자동화 스위트에는 미포함).

## 7. 알려진 스코프 조정

- YOLOv8n/CLIP 대신 coco-ssd(TensorFlow.js) — 검증 가능한 경량 모델로 대체
- Firebase Firestore 대신 로컬 JSON 기본값 (어댑터 인터페이스는 준비됨)
- 매장 데이터 4곳만 실제 데이터, 나머지는 확장 필요
