const config = require("../config");
const { withRetry, fetchWithTimeout, ExternalApiError, isRetryableStatus } = require("../utils/retry");
const logger = require("../utils/logger");

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Gemini의 OpenAI 호환 엔드포인트 — 요청/응답 형태가 동일해서 같은 코드로 호출 가능하다.
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
// OpenRouter도 OpenAI 호환. "openrouter/free" 모델은 그 시점에 살아있는 무료 모델을 자동으로 골라준다.
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** 이 코드/문구가 뜨면 "다시 시도"가 아니라 "다른 모델/제공자로 바꿔야" 해결된다. */
const MODEL_UNAVAILABLE_CODES = ["model_permission_blocked_org", "model_not_found", "model_decommissioned"];
// Gemini 등 일부 제공자는 코드 대신 문구로만 폐기를 알린다 (예: "is no longer available", status NOT_FOUND).
const MODEL_UNAVAILABLE_PHRASES = ["no longer available", "\"status\": \"NOT_FOUND\"", "is not found for API version"];

function isModelUnavailableError(message) {
  return (
    MODEL_UNAVAILABLE_CODES.some((code) => message.includes(code)) ||
    MODEL_UNAVAILABLE_PHRASES.some((phrase) => message.includes(phrase))
  );
}

/**
 * 시도할 (제공자, 모델) 후보 목록을 현재 설정값으로 매번 새로 만든다(캐시하지 않음 —
 * 테스트에서 config를 바꿔치기해도 즉시 반영되도록, 그리고 실제로도 설정은 자주 안 바뀌므로 무해함).
 * 순서: Groq 1순위 모델 → Groq 폴백 모델들 → (설정돼 있으면) Gemini.
 */
function buildProviderCandidates() {
  const candidates = [];
  if (config.groq.apiKey) {
    for (const model of [config.groq.model, ...config.groq.fallbackModels]) {
      candidates.push({ provider: "groq", baseUrl: GROQ_URL, apiKey: config.groq.apiKey, model });
    }
  }
  if (config.gemini.apiKey) {
    candidates.push({ provider: "gemini", baseUrl: GEMINI_URL, apiKey: config.gemini.apiKey, model: config.gemini.model });
  }
  if (config.openrouter.apiKey) {
    candidates.push({ provider: "openrouter", baseUrl: OPENROUTER_URL, apiKey: config.openrouter.apiKey, model: config.openrouter.model });
  }
  return candidates;
}

async function callProviderOnce(messages, { jsonMode, temperature, timeoutMs, baseUrl, apiKey, model }) {
  return withRetry(async () => {
    const body = { model, messages, temperature };
    if (jsonMode) body.response_format = { type: "json_object" };

    const res = await fetchWithTimeout(
      baseUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body)
      },
      timeoutMs
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ExternalApiError(`LLM_HTTP_${res.status}: ${text}`, "HTTP_ERROR", { retryable: isRetryableStatus(res.status) });
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  });
}

/**
 * 등록된 (제공자, 모델) 후보를 순서대로 시도한다.
 * - 모델 자체를 쓸 수 없다는 에러(조직 차단/폐기/존재하지 않음)면 바로 다음 후보 하나로 넘어간다.
 * - 그 외 에러(인증 실패, 네트워크 등 "계정 자체"의 문제)면, 같은 API 키를 쓰는 나머지 후보는
 *   전부 건너뛰고 API 키가 다른 다음 후보(=다른 제공자, 예: Groq→Gemini)로 바로 넘어간다.
 *   같은 키를 계속 재시도해봐야 결과가 같으므로 낭비하지 않기 위함이다.
 */
async function callGroq(messages, { jsonMode = false, temperature = 0.3, timeoutMs = 12000 } = {}) {
  const candidates = buildProviderCandidates();
  if (!candidates.length) throw new ExternalApiError("NO_LLM_PROVIDER_CONFIGURED", "NO_KEY");

  let i = 0;
  let lastErr;
  while (i < candidates.length) {
    const c = candidates[i];
    try {
      const result = await callProviderOnce(messages, { jsonMode, temperature, timeoutMs, ...c });
      if (i > 0) {
        logger.warn("1순위 LLM을 쓸 수 없어 대체 제공자/모델로 성공", { used: `${c.provider}:${c.model}` });
      }
      return result;
    } catch (e) {
      lastErr = e;
      let nextIndex;
      if (isModelUnavailableError(e.message || "")) {
        nextIndex = i + 1; // 모델 문제 → 바로 다음 후보 하나만 건너뛴다
      } else {
        // 계정 자체 문제(예: 401) → 같은 키를 쓰는 나머지 후보는 다 건너뛰고 다른 계정으로
        nextIndex = i + 1;
        while (nextIndex < candidates.length && candidates[nextIndex].apiKey === c.apiKey) nextIndex++;
      }
      if (nextIndex >= candidates.length) throw e;
      logger.warn("LLM 호출 실패 - 다음 후보로 전환", {
        failed: `${c.provider}:${c.model}`, next: `${candidates[nextIndex].provider}:${candidates[nextIndex].model}`, reason: e.message
      });
      i = nextIndex;
    }
  }
  throw lastErr;
}

/** 한국어 발화 → 검색 조건(SearchIntent). query는 반드시 영어로 번역해서 반환하도록 강제한다. */
async function extractIntent(transcript) {
  const content = await callGroq(
    [
      {
        role: "system",
        content:
          "너는 패션 쇼핑 어시스턴트다. 한국어 음성 요청을 분석해서 다음 JSON을 반환해라: " +
          '{"query": string, "category": string|null, "style": string[], "color": string|null}. ' +
          "query 필드는 반드시 eBay 검색에 쓸 수 있는 영어 키워드로 번역해서 작성해라 (한국어 금지). " +
          "category, style, color는 한국어로 작성해도 된다. " +
          '예 입력: "허리 밴딩 있는 편안한 데님 팬츠 찾아줘" → ' +
          '{"query":"denim pants elastic waist comfortable","category":"팬츠","style":["캐주얼","편안함"],"color":null}'
      },
      { role: "user", content: transcript }
    ],
    { jsonMode: true, temperature: 0.3 }
  );
  return JSON.parse(content);
}

/**
 * eBay 원본 아이템 배열을 한 번의 호출로 묶어 brand/color/material/style/category/
 * modelNumber/sizeInfo를 추출한다. 근거 없는 값은 반드시 null.
 */
async function enrichProductsWithGroq(rawItems) {
  const input = rawItems.map((it, i) => ({ index: i, title: it.title, condition: it.condition }));
  const content = await callGroq(
    [
      {
        role: "system",
        content:
          "너는 상품명 텍스트만 보고 속성을 추출하는 파서다. 절대 추측하거나 지어내지 마라. " +
          "상품명에 명시적으로 드러난 정보만 채우고, 근거가 없으면 반드시 null로 두어라. " +
          "각 상품에 대해 다음 스키마를 채운 배열을 {\"items\":[...]} 형태의 JSON 객체로 반환해라: " +
          "{index:number, brand:string|null, category:string|null, color:string|null, style:string|null, " +
          "material:string|null, modelNumber:string|null, " +
          "sizeInfo:{length:number|null, shoulder:number|null, chest:number|null, sleeve:number|null}|null} " +
          "sizeInfo의 숫자는 cm 단위로 상품명에 실측값이 명시된 경우에만 채우고, 그렇지 않으면 sizeInfo 전체를 null로 해라."
      },
      { role: "user", content: JSON.stringify(input) }
    ],
    { jsonMode: true, temperature: 0.1 }
  );
  const parsed = JSON.parse(content);
  const items = Array.isArray(parsed) ? parsed : parsed.items || [];
  const byIndex = new Map(items.map((it) => [it.index, it]));
  return rawItems.map((_, i) => byIndex.get(i) || null);
}

const SUPPORTED_ACTIONS = [
  "search", "more_results", "select_item", "similar_item",
  "repeat", "back_to_list", "new_search", "stop", "help", "reset",
  "sort_price", "filter_price_range", "similar_with_filter", "describe_style",
  "taste_match", "body_fit_query", "confirm_yes", "confirm_no", "go_offline",
  "go_purchase",
  "unsupported"
];

/** 자유 발화를 지원 액션(온라인 쇼핑 20종) 중 하나로 분류 (AI). */
async function classifyCommand(transcript, { mode, resultsCount }) {
  const content = await callGroq(
    [
      {
        role: "system",
        content:
          "너는 시각장애인을 위한 음성 쇼핑 비서의 명령 해석기다. 이 시스템이 지원하는 기능은 " +
          "정확히 다음과 같다: " +
          "search(새로운 옷 검색), more_results(현재 검색어로 상품 더 찾기), " +
          "select_item(목록에서 번호로 상품 선택해 설명 듣기), " +
          "similar_item(특정 번호 상품과 비슷한 상품 찾기), " +
          "sort_price(가격순 정렬 — 가장 싼 거/가장 비싼 거/N번째로 싼 거 등), " +
          "filter_price_range(가격대 조건 — 5만원 이하/이상/5만원대 등), " +
          "similar_with_filter(비슷하면서 추가 조건 — '비슷한데 더 싼 거', '비슷한데 검은색으로'), " +
          "describe_style(선택한 상품의 스타일·느낌 설명 요청 — '이거 어떤 느낌이야', '어떤 스타일이야'), " +
          "taste_match(사용자 취향과 상품이 맞는지 — '내 취향에 맞아?', '내가 좋아할 스타일이야?'), " +
          "body_fit_query(신체 치수와 상품 실측 비교 — '내 키에 길이가 어때', '나한테 클까', '소매가 길까'), " +
          "confirm_yes/confirm_no(직전에 시스템이 제안한 것에 대한 긍정/부정 응답 — '응','그래','좋아' 또는 '아니','아니요','괜찮아'), " +
          "go_offline(오프라인 매장에서 직접 보고 싶다는 의사 — '직접 입어보고 싶어', '매장에서 보고 싶어'), " +
          "go_purchase(선택한 상품을 사고 싶다는 의사 — '이거 살래', '구매할래', '결제하고 싶어', '주문해줘'), " +
          "repeat(방금 들은 내용 다시 듣기), back_to_list(상품 목록으로 돌아가기), " +
          "new_search(새로 검색 시작, 목록 초기화), stop(음성 멈춤), help(사용법 안내), " +
          "reset(전체 초기화), unsupported(위 기능들에 해당하지 않는 모든 요청). " +
          "사용자 발화를 분석해서 다음 JSON으로만 답하라: " +
          '{"action": 위 목록 중 하나, "itemNumber": 숫자 또는 null, "rawQuery": string 또는 null, ' +
          '"priceRank": number|null, "priceDirection": "asc"|"desc"|null, ' +
          '"priceMin": number|null, "priceMax": number|null, "filterHint": string|null}. ' +
          "itemNumber는 select_item/similar_item/similar_with_filter/describe_style/taste_match/body_fit_query/go_purchase일 때만 채우고 " +
          "(숫자나 '일번/첫번째/한번' 같은 한국어 서수도 숫자로 변환), 번호가 없으면 null로 두되 action은 바꾸지 마라 " +
          "(현재 보고 있는 상품을 가리키는 것으로 처리될 것이다). " +
          "sort_price일 때 '가장 싼'=priceDirection:asc priceRank:1, '가장 비싼'=desc/1, " +
          "'세 번째로 싼'=asc/3 처럼 채우고 만원 단위 표현(5만원 등)은 숫자로 변환해라(50000). " +
          "filter_price_range일 때 '5만원 이하'는 priceMax:50000, '5만원 이상'은 priceMin:50000, " +
          "'5만원대'는 priceMin:50000,priceMax:59999로 채워라. " +
          "similar_with_filter일 때 filterHint에 추가 조건을 짧은 한국어로 채워라(예: '더 싼', '검은색'). " +
          "rawQuery는 action이 search일 때 사용자가 말한 옷 특징 원문을 그대로 채워라. " +
          `현재 화면 상태는 "${mode}"이고 목록에는 상품이 ${resultsCount}개 있다. ` +
          "확신이 없거나 이 기능들과 무관한 요청(예: 날씨, 잡담, 결제, 배송조회 등)이면 반드시 unsupported로 분류해라."
      },
      { role: "user", content: transcript }
    ],
    { jsonMode: true, temperature: 0.1 }
  );
  const parsed = JSON.parse(content);
  if (!SUPPORTED_ACTIONS.includes(parsed.action)) parsed.action = "unsupported";
  return parsed;
}

/** 실제 Product 데이터만 근거로 한국어 음성 안내 문장을 생성한다. */
async function describeProductWithGroq(factLines, fitNote) {
  return callGroq(
    [
      {
        role: "system",
        content:
          "너는 시각장애인 사용자를 위한 쇼핑 음성 안내 도우미다. 아래 제공된 사실 정보만 사용해서 " +
          "자연스러운 한국어 문장 4~6개로 상품을 소개해라. 목록에 없는 정보는 절대 지어내지 말고, " +
          "브랜드·색상·소재 등이 제공되지 않았으면 '정확한 정보는 확인되지 않았다' 정도로만 짧게 언급해라. " +
          "마크다운이나 목록 기호 없이, 소리 내어 읽었을 때 자연스러운 평서문으로만 작성해라."
      },
      { role: "user", content: factLines.join("\n") + (fitNote ? `\n착용감 참고: ${fitNote}` : "") }
    ],
    { temperature: 0.4 }
  );
}

const SUPPORTED_OFFLINE_ACTIONS = [
  "select_store", "start_companion", "floor_guide", "find_store", "call_staff",
  "brand_search", "category_search", "select_search_result", "set_destination", "free_browse",
  "describe_scene", "read_sign", "next", "back", "repeat", "help", "settings",
  "go_online", "stop", "unsupported"
];

/** 오프라인(매장 내비게이션) 발화를 화면(screen) 맥락에 맞는 액션으로 분류 (AI). */
async function classifyOfflineCommand(transcript, { screen }) {
  const content = await callGroq(
    [
      {
        role: "system",
        content:
          "너는 시각장애인을 위한 백화점 내비게이션 앱의 명령 해석기다. 화면(screen)은 " +
          "home(매장 선택)/store(매장 메인메뉴)/find(매장 찾기)/result(경로 안내)/floors(층별 안내)/browse(동행 모드) 중 하나다. " +
          "지원 액션: select_store(목록에서 매장 번호나 이름 선택), start_companion(동행 시작), " +
          "floor_guide(층별 안내 보기), find_store(매장 찾기 화면으로), call_staff(직원 불러줘), " +
          "brand_search(특정 브랜드명을 직접 말한 경우 — '프라다 몇 층이야', 메뉴 키워드가 아닌 브랜드명을 바로 말한 경우 포함), " +
          "category_search(브랜드명이 아니라 '여성 의류', '화장품', '아동복'처럼 상품군·매장 종류로 물은 경우 — " +
          "'5층에 어떤 매장 있어', '화장품 매장 어디 있어'처럼 특정 층의 구성이나 상품군 위치를 묻는 질문 포함), " +
          "select_search_result(검색 결과 목록에서 번호 선택), " +
          "set_destination(동행모드에서 목적지 브랜드/카테고리+색상 말하기), " +
          "free_browse(목적지 없이 그냥 둘러보기), describe_scene('지금 보이는 것 설명해줘'), " +
          "read_sign('간판 읽어줘'), next(다음으로 진행), back(뒤로가기), repeat(다시 듣기/다시 말해줘), " +
          "help(도움말), settings(설정 변경 요청 — 음성 속도/글자크기/진동 등), " +
          "go_online(방금 확인한 상품을 온라인에서 찾아보고 싶다는 의사 — '온라인에서 보고 싶어', '온라인으로 검색해줘'), " +
          "stop(그만/정지), " +
          "unsupported(위에 해당하지 않는 요청). " +
          '다음 JSON으로만 답하라: {"action": 위 목록 중 하나, "itemNumber": 숫자|null, "rawText": string|null}. ' +
          "itemNumber는 select_store/select_search_result일 때 번호(서수 포함)를 채우고, " +
          "rawText는 brand_search/category_search/set_destination일 때 사용자가 말한 원문을 그대로 채워라. " +
          `현재 화면은 "${screen}"이다. 이 화면에서 의미가 통하지 않는 액션이라도, 브랜드명을 직접 말한 것으로 ` +
          "보이면(store/home 화면에서 특히) brand_search로 분류해라. 확신이 없으면 unsupported로 분류해라."
      },
      { role: "user", content: transcript }
    ],
    { jsonMode: true, temperature: 0.1 }
  );
  const parsed = JSON.parse(content);
  if (!SUPPORTED_OFFLINE_ACTIONS.includes(parsed.action)) parsed.action = "unsupported";
  return parsed;
}

const KOREAN_COCO_LABELS = {
  person: "사람", chair: "의자", "suitcase": "캐리어", backpack: "배낭",
  handbag: "핸드백", "cell phone": "휴대폰", bottle: "병", cup: "컵",
  "dining table": "테이블", bench: "벤치", "potted plant": "화분",
  umbrella: "우산", tie: "넥타이", book: "책", clock: "시계",
  laptop: "노트북", tv: "텔레비전", "traffic light": "신호등"
};

/**
 * 클라이언트(브라우저)에서 실행된 물체 인식(coco-ssd) 결과 + 색상 판별 결과를 받아
 * 자연스러운 한국어 상황 설명 문장을 만든다. 이미지 자체를 서버가 보는 것이 아니라,
 * 클라이언트가 이미 인식한 라벨/색상 데이터만 문장으로 다듬는 역할이다.
 */
async function describeSceneWithGroq(detections, dominantColor, personDetected, garmentText, clothingCategory) {
  const labelsKr = detections.map((d) => KOREAN_COCO_LABELS[d.class] || d.class).join(", ") || "특별히 인식된 사물 없음";
  const colorLine = personDetected
    ? `사람이 감지됨. 그 사람이 입은 옷의 대략적인 색상 추정: ${dominantColor || "확인 안 됨"} (정확한 옷차림 스타일까지는 인식하지 못함, 색상만 추정).`
    : `주된 색상: ${dominantColor || "확인 안 됨"}.`;
  const categoryLine = personDetected && clothingCategory
    ? ` 옷 카테고리 분류 모델 추정 결과: ${clothingCategory} (참고용 추정치).`
    : "";
  const garmentLine = garmentText ? ` 옷 위에서 인식된 문구(OCR): "${garmentText}".` : "";
  const fact = `인식된 사물: ${labelsKr}. ${colorLine}${categoryLine}${garmentLine}`;
  return callGroq(
    [
      {
        role: "system",
        content:
          "너는 시각장애인을 위한 주변 상황 설명 도우미다. 제공된 인식 결과(사물 목록, 색상, 사람 감지 여부, " +
          "옷 카테고리 추정, 옷 위 문구)만 바탕으로 2~3문장의 짧고 실용적인 한국어 설명을 만들어라. 인식되지 " +
          "않은 것은 언급하지 말고, 사람이 감지된 경우 안전을 위해 방향이나 정확한 거리는 추정하지 말고 " +
          "'가까이에 사람이 있다' 정도로만 설명하되, 옷차림 색상·카테고리 추정치가 있으면 '~색 ~를 입은 " +
          "사람이 있다' 정도로 참고용임을 알 수 있게 덧붙이고, 옷 위 문구가 인식됐다면 그 문구도 자연스럽게 " +
          "언급해라. OCR 문구와 옷 카테고리는 오인식일 수 있으니 '~인 것 같다' 정도로 완곡하게 표현해라."
      },
      { role: "user", content: fact }
    ],
    { temperature: 0.3 }
  );
}

/** 취향(선호 색상/스타일)과 상품이 맞는지 판단하는 짧은 한국어 판단 문장 */
async function tasteMatchWithGroq(product, tastePreferences) {
  const fact =
    `상품: ${product.name}, 색상: ${product.color || "정보 없음"}, 스타일: ${product.style || "정보 없음"}.\n` +
    `사용자 취향: 선호 색상 [${(tastePreferences.colors || []).join(", ") || "없음"}], ` +
    `선호 스타일 [${(tastePreferences.styles || []).join(", ") || "없음"}].`;
  return callGroq(
    [
      {
        role: "system",
        content:
          "너는 취향 매칭 도우미다. 제공된 사실만으로 이 상품이 사용자 취향에 맞는지 1~2문장으로 " +
          "판단해서 말해라. 상품 정보나 취향 정보가 부족하면 억지로 단정하지 말고 '정보가 부족해 확신하기 " +
          "어렵다'는 취지로 답해라. 과장하지 말고 담백하게 답해라."
      },
      { role: "user", content: fact }
    ],
    { temperature: 0.3 }
  );
}

module.exports = {
  extractIntent,
  enrichProductsWithGroq,
  classifyCommand,
  classifyOfflineCommand,
  describeProductWithGroq,
  describeSceneWithGroq,
  tasteMatchWithGroq,
  SUPPORTED_ACTIONS,
  SUPPORTED_OFFLINE_ACTIONS
};
