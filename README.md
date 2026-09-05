# EarShopping — 시각장애인을 위한 통합 음성 쇼핑·매장 안내 서비스

온라인 쇼핑(음성 검색 + 실제 데이터 기반 안내)과 오프라인 백화점 매장 내비게이션(음성 + 카메라 AI)을
하나의 웹사이트로 통합했습니다. 처음 화면에서 "온라인" 또는 "오프라인"을 말하거나 선택하면 각 모드로 이동합니다.

```
처음 화면(index.html) ──"온라인"──▶ online.html   (온라인1 + 온라인2 기능 통합)
                     └─"오프라인"─▶ offline.html  (오프라인 6화면 + 카메라 AI)
```

## 무엇이 정직하게 스코프 조정되었는지 (먼저 밝힙니다)

원본 명세와 실제 구현 사이에 아래 차이가 있습니다. 전부 "실제로 브라우저에서 동작이 검증 가능한
대안"으로 의도적으로 조정한 것이며, 숨기지 않고 밝힙니다.

| 명세 | 실제 구현 | 이유 |
| --- | --- | --- |
| YOLOv8n (onnxruntime-web) | **coco-ssd (TensorFlow.js)** | 명세에도 이미 "폴백"으로 명시된 모델이며, CDN에서 실제 로드·추론이 검증 가능함. 카메라·GPU가 없는 개발 환경에서는 YOLOv8n 자체를 실제 테스트할 수 없었음 |
| CLIP (transformers.js, 옷차림 추정) | **생략** — coco-ssd 라벨 + 색상 판별 결과를 Groq가 문장으로 조합 | CLIP 제로샷 분류를 별도로 검증할 방법이 없어, 이미 파이프라인에 있는 요소(물체 인식+색상+LLM)로 대체 |
| Tesseract.js (OCR) | 명세 그대로 구현 | 실제로 동작 검증 가능한 라이브러리 |
| Firebase Firestore | **로컬 JSON 기본 + Firestore 연동 지점만 준비** | 실제 Firebase 프로젝트를 대신 만들어드릴 수 없어, 명세에 적힌 대로("로컬 데이터 자동 대체") 로컬 데이터를 기본값으로 두고, `storeDataService.js`의 `loadStores()` 함수 하나만 교체하면 Firestore로 전환되도록 어댑터 구조로 분리 |

나머지 기능(음성 인터페이스, 매장 검색/경로 안내, 온라인 쇼핑 파이프라인, 명령 분류, 가격 정렬/필터,
유사상품, 스타일 설명, 취향 매칭, 체형 비교, 온라인↔오프라인 연동)은 실제로 서버를 띄워 curl로
검증했고, 핵심 로직은 자동 테스트(`npm test`, 49개)로 커버됩니다. 다만 카메라 기반 기능(물체 인식,
OCR, 진동 경고)은 실제 카메라·모바일 기기에서만 최종 확인이 가능하므로, 코드 구현과 로직 검증까지는
마쳤지만 실기기 동작은 사용자가 직접 확인해야 합니다.

## 디자인

세 페이지(랜딩/온라인/오프라인) 모두 공통 디자인 시스템(`public/theme.css`)을 사용합니다 — 다크
배경에 퍼플→핑크 그라데이션을 포인트로 쓴 스타일입니다. 기능 로직(`online.js`/`offline.js`/`landing.js`)은
전혀 건드리지 않고 마크업과 CSS만 교체했으며, 모든 DOM id/클래스가 JS와 정확히 일치하는지 자동
비교로 검증했습니다.

## 프로젝트 구조

```
earshopping/
├── src/
│   ├── config.js               환경변수 로드 + 검증
│   ├── server.js                Express 앱 조립 (보안/로깅/에러 처리, 카메라 CDN용 CSP 포함)
│   ├── index.js                  엔트리포인트
│   ├── data/stores.json          예시 백화점 3곳 데이터 (안내서비스 여부, 층별 브랜드)
│   ├── services/
│   │   ├── groqService.js            온라인/오프라인 명령 분류, 검색조건 이해, 설명 생성, 장면 묘사
│   │   ├── ebayService.js            eBay 검색 (온라인2)
│   │   ├── demoService.js            온라인 쇼핑 데모 데이터
│   │   ├── storeDataService.js       매장 데이터 조회, 거리 정렬, 퍼지 브랜드 검색, 경로 생성
│   │   ├── pricingService.js          최저가 계산, 착용감/체형비교 답변 (순수 로직)
│   │   ├── commandService.js          규칙 기반 명령 분류 폴백 (온라인 20종 + 오프라인 18종)
│   │   └── cacheService.js            TTL 캐시
│   ├── routes/
│   │   ├── searchProducts.js, describeProduct.js, command.js, status.js   (온라인2, 기존)
│   │   ├── onlineExtras.js            describe-style / taste-match / body-fit (온라인1 확장)
│   │   └── offline.js                  매장/층/검색/경로/명령분류/장면설명/간판인식 (오프라인)
│   └── utils/ logger.js, retry.js, fuzzyMatch.js(편집거리)
├── public/
│   ├── index.html               랜딩 (온라인/오프라인 선택, 음성 인식)
│   ├── online.html / online.js    온라인 쇼핑 (음성검색 + 가격정렬/필터 + 유사상품 + 스타일/취향/체형 + 오프라인 전환)
│   └── offline.html / offline.js  오프라인 6화면(매장선택/메뉴/찾기/결과/층별안내/동행모드) + 설정 패널 + 카메라 AI
├── tests/                         단위 테스트 49개 (node:test)
├── types.ts                        API 계약 타입 문서
└── .env.example
```

## 실행 방법

```bash
npm install
cp .env.example .env   # 키 없어도 전부 데모/로컬 데이터로 동작
npm test                # 49개 테스트 통과 확인
npm start               # http://localhost:3000
```

**Chrome을 권장**하며, 오프라인 동행 모드(카메라)를 테스트하려면 **모바일 기기 또는 웹캠이 있는
PC + HTTPS 환경**이 필요합니다 (localhost는 예외적으로 HTTP에서도 카메라/마이크 권한이 허용됩니다).

## 온라인 모드 — 확장된 음성 명령

기존 기능(검색/상세/더 찾기/유사상품/다시 듣기/목록으로/다시 검색/정지/도움말/처음으로)에 더해:

| 말하면 | 동작 |
| --- | --- |
| "가장 싼 거 알려줘" / "세 번째로 싼 거" | 현재 목록을 가격순으로 정렬해 답변 (클라이언트에서 계산, AI 아님) |
| "5만원 이하" / "5만원대 보여줘" | 가격대 조건에 맞는 상품만 골라 안내 |
| "비슷한데 더 싼 거 없어?" / "비슷한데 검은색으로" | 유사 상품 검색에 조건을 추가로 결합 |
| "이거 어떤 느낌이야?" | 선택한 상품의 스타일/느낌 설명 |
| "내 취향에 맞아?" | 화면 상단에 입력한 선호 색상/스타일과 비교 |
| "내 키에 길이가 어때?" / "소매가 길까?" | 실측 사이즈와 신체 치수를 비교해 답변 |
| "직접 입어보고 싶어" | 해당 브랜드를 오프라인 매장에서 검색해 안내하고 오프라인 화면으로 전환 |
| (AI 제안 후) "응" / "아니" | 직전 제안("비슷한 상품도 찾아드릴까요?")에 대한 응답 |

## 오프라인 모드 — 6화면 요약

1. **매장 선택**: 위치 기반 거리순 + 안내서비스 우선 정렬, 지도 링크
2. **매장 메뉴**: 동행 시작/층별 안내/매장 찾기/직원 호출, 브랜드명 즉시 검색
3. **매장 찾기**: 편집거리 기반 오타 허용 검색, 검색 실패 시 화면 유지한 채 재질문, 최근 검색어 재사용
4. **경로 안내**: 정문→엘리베이터→도착→문의 단계별 텍스트+음성
5. **층별 안내**: 층별로 순차 음성 안내, "다음"/스페이스바/카드 클릭으로 진행
6. **동행 모드(카메라 AI)**: 목적지 안내 또는 자유 관람, "지금 보이는 것 설명해줘"(물체+색상 인식),
   "간판 읽어줘"(OCR), 사람·의자·캐리어 근접 시 자동 진동+음성 경고

모든 화면에서 텍스트 입력창으로도 전체 기능을 쓸 수 있고, 설정 패널(우측 상단 ⚙)에서 음성/진동
on-off, 속도, 글자 크기를 조절할 수 있습니다.

## 옷 카테고리 인식 (동행 모드 추가 기능)

동행 모드(카메라 AI)의 물체 인식(coco-ssd)은 "사람", "가방" 같은 일반 사물만 구분할 뿐 옷 종류는
알지 못합니다. 이를 보완하기 위해 **옷 카테고리 분류 전용 모델을 별도로 학습**시켜 추가했습니다.

- **모델**: Teachable Machine(Google)으로 학습한 MobileNet 기반 전이학습(transfer learning) 이미지
  분류 모델. TensorFlow.js로 export하여 `public/model/`에 배치.
- **클래스(8종)**: 티셔츠 · 니트 · 자켓 · 바지 · 청바지 · 원피스 · 스커트 · 신발
- **데이터셋**: Kaggle 공개 데이터셋 `paramaggarwal/fashion-product-images-small`에서 위 8개
  카테고리에 해당하는 이미지를 추출 (클래스당 128~300장, 총 2,186장).
- **연동 방식**: coco-ssd가 인식한 사람(person) 영역만 잘라서 이 모델에 입력 → 확률 60% 이상인
  경우에만 채택 → 색상(픽셀 평균 기반, 학습 불필요)과 함께 서버로 전달되어 LLM이 "회색 니트를
  입은 사람이 있어요" 같은 문장으로 조합합니다. 이미지 자체는 서버로 전송되지 않고, 클라이언트에서
  인식한 라벨/색상 텍스트만 전달됩니다.

## API 요약

| 엔드포인트 | 설명 |
| --- | --- |
| `POST /api/command` | 온라인 자연어 명령 분류 (20개 액션) |
| `POST /api/search-products` | 온라인 검색 파이프라인 |
| `POST /api/describe-product` | 온라인 상품 상세 음성 설명 (+ 후속 제안 포함) |
| `POST /api/describe-style` / `taste-match` / `body-fit` | 스타일 설명 / 취향 매칭 / 체형 비교 |
| `GET /api/offline/stores` | 매장 목록 (거리순) |
| `GET /api/offline/stores/:id`, `/floors` | 매장 상세, 층별 데이터 |
| `POST /api/offline/stores/:id/search`, `/route` | 브랜드 퍼지 검색, 경로 생성 |
| `GET /api/offline/brand-locations?brand=` | 전체 매장에서 브랜드 검색 (온라인→오프라인 연동) |
| `POST /api/offline/command` | 오프라인 자연어 명령 분류 (18개 액션, 화면별 맥락 반영) |
| `POST /api/offline/browse/describe-scene`, `/read-sign` | 카메라 인식 결과를 문장으로 변환, 간판-매장 대조 |

전체 스키마는 `types.ts` 참고.

## eBay 검색이 계속 데모로 폴백될 때

서버를 시작하면 이제 로그에 `groqKeyCheck`, `ebayClientIdCheck`, `ebaySecretCheck`가 함께 찍힙니다
(예: `gsk_***(길이 56)`). 전체 키는 절대 노출하지 않고 앞 4글자와 길이만 보여주는데, 이걸로
`.env`에 붙여넣은 값이 원래 발급받은 키와 길이가 다르면(특히 Windows에서 복사할 때 개행 문자
`\r`가 섞여 들어가는 경우가 흔합니다) 바로 알아챌 수 있습니다. 이번 업데이트에서 `.env` 값을 읽을 때
앞뒤 공백과 개행을 자동으로 제거하도록 고쳐서 이 문제 자체는 이제 발생하지 않지만, 길이가 이상하면
애초에 잘못된 값을 복사한 것이니 발급 페이지에서 다시 복사해보세요.

`.env`에 eBay 키를 넣었는데도 로그에 `eBay 검색 실패 - 데모로 폴백`이 계속 뜬다면, 실제 eBay 에러
메시지가 로그에 그대로 찍히니 그 내용으로 원인을 좁힐 수 있습니다.

- **`invalid_client` (client authentication failed)**: Client ID와 Client Secret 조합이 틀렸다는 뜻입니다.
  - developer.ebay.com → **My Account → Application Keys**에서 **Production** 키셋의 App ID(Client ID)와
    Cert ID(Client Secret)를 **같은 키셋에서** 다시 복사해서 넣어보세요 (Sandbox와 Production 키를 섞어 넣으면
    이 에러가 납니다).
  - `.env`의 `EBAY_ENV`가 실제 키 종류와 일치하는지 확인하세요 (`production` 키인데 `EBAY_ENV=sandbox`로
    되어 있거나 그 반대인 경우도 이 에러가 납니다).
- **`errorId 2001 "Insufficient permissions to fulfill the request."`**: 키 자체는 맞지만 Buy API(Browse API)
  사용 권한이 아직 활성화되지 않은 경우입니다.
  1. **Alerts & Notifications** 메뉴에서 **Marketplace Account Deletion(계정 삭제 알림)** 옵트아웃을
     완료했는지 확인 (완료 안 하면 Buy API 계열이 통째로 막히는 경우가 많습니다)
  2. Browse API가 실제로 애플리케이션에 활성화되어 있는지 확인

Sandbox 키로 먼저 테스트해보고 싶다면 `.env`의 `EBAY_ENV=sandbox`로 바꾸고 Sandbox 전용 키를 넣으면
됩니다 (Sandbox는 이런 프로덕션 규정 확인 없이 바로 테스트 가능합니다).

## Groq 조직 계정 자체가 여러 모델을 전부 막고 있을 때

`GROQ_MODEL_FALLBACKS`에 있는 모델까지 전부 `model_permission_blocked_org`로 막혀있다면, 특정
모델의 문제가 아니라 **이 Groq 조직 계정 자체가 신규/기본 모델 접근을 제한하고 있는 것**입니다.
조직 관리자가 아니면 `console.groq.com/settings/limits`에서 직접 풀 수 없는 경우도 많습니다.

이럴 때를 대비해 **완전히 다른 무료 제공자로 순서대로 자동 전환**되도록 3단계 폴백을 만들어뒀습니다.

1. **Groq** (1순위 모델 → 폴백 모델들)
2. **Google Gemini** — https://aistudio.google.com/apikey (개인 Google 계정, 조직 승인 불필요)
3. **OpenRouter** — https://openrouter.ai/keys (신용카드 불필요, `openrouter/free`가 그 시점의
   무료 모델을 자동으로 골라줘서 특정 모델이 없어져도 안 깨짐)

`.env`에 필요한 만큼만 추가하세요:
```
GEMINI_API_KEY=발급받은키
OPENROUTER_API_KEY=발급받은키
```

Groq/Gemini가 계정 문제(권한 거부 등)로 실패하면 같은 계정의 나머지 모델은 건너뛰고 곧장 다음
제공자로 넘어갑니다. 로그에 `1순위 LLM을 쓸 수 없어 대체 제공자/모델로 성공 {"used":"openrouter:openrouter/free"}`
처럼 뜨면 정상 작동 중인 겁니다. 셋 다 설정 안 해도 데모 모드로 동작하니, 급하지 않으면 하나만
발급받아도 됩니다.



- 기존 체크리스트(HTTPS, CORS_ORIGINS, 캐시 공유 저장소 등)에 더해, 카메라 AI 모델
  CDN(jsdelivr, storage.googleapis.com, unpkg)이 접근 가능해야 하므로 사내망/방화벽 환경에서는
  해당 도메인을 허용해야 합니다.
- Firestore로 전환하려면 `src/services/storeDataService.js`의 `loadStores()` 함수만 교체하면 됩니다.
- 매장·층 데이터는 예시 3곳만 구축되어 있으며, 실제 서비스에는 데이터 추가가 필요합니다.
