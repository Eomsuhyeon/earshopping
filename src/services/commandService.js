const ORD = { 첫: 1, 하나: 1, 일: 1, 둘: 2, 두: 2, 이: 2, 셋: 3, 세: 3, 삼: 3, 넷: 4, 네: 4, 사: 4, 다섯: 5, 오: 5 };

/** "가장 싼/비싼", "N번째로 싼/비싼" 형태를 {rank, direction} 으로 파싱. 매칭 안 되면 null. */
function parsePriceRank(text) {
  if (/가장\s*(싸|싼)|제일\s*(싸|싼)/.test(text)) return { rank: 1, direction: "asc" };
  if (/가장\s*(비싸|비싼)|제일\s*(비싸|비싼)/.test(text)) return { rank: 1, direction: "desc" };
  const digitAsc = text.match(/(\d+)\s*번째로\s*(싸|싼)/);
  if (digitAsc) return { rank: parseInt(digitAsc[1], 10), direction: "asc" };
  const digitDesc = text.match(/(\d+)\s*번째로\s*(비싸|비싼)/);
  if (digitDesc) return { rank: parseInt(digitDesc[1], 10), direction: "desc" };
  for (const [w, n] of Object.entries(ORD)) {
    if (new RegExp(w + "\\s*번째로\\s*(싸|싼)").test(text)) return { rank: n, direction: "asc" };
    if (new RegExp(w + "\\s*번째로\\s*(비싸|비싼)").test(text)) return { rank: n, direction: "desc" };
  }
  return null;
}

/** "5만원 이하/이상/5만원대" 형태를 {min,max} 로 파싱. 매칭 안 되면 null. */
function parsePriceRange(text) {
  const m = text.match(/(\d+)\s*만원\s*(이하|이상|대)/);
  if (!m) return null;
  const value = parseInt(m[1], 10) * 10000;
  if (m[2] === "이하") return { min: null, max: value };
  if (m[2] === "이상") return { min: value, max: null };
  return { min: value, max: value + 9999 };
}

/** Groq 없이도 동작하는 규칙 기반 명령 분류기 (온라인 쇼핑). 애매한 발화는 보수적으로 unsupported로 보낸다. */
function classifyCommandFallback(text, { mode }) {
  if (/정지|그만|멈춰/.test(text)) return { action: "stop", itemNumber: null, rawQuery: null };
  if (/도움말|명령어|사용법/.test(text)) return { action: "help", itemNumber: null, rawQuery: null };
  if (/처음으로|초기화/.test(text)) return { action: "reset", itemNumber: null, rawQuery: null };
  if (/더\s*찾|더\s*보여|더\s*있|더\s*없/.test(text)) return { action: "more_results", itemNumber: null, rawQuery: null };

  if (/직접\s*입어|매장에서\s*보고|가서\s*보고|입어보고\s*싶/.test(text)) {
    return { action: "go_offline", itemNumber: null, rawQuery: null };
  }
  if (/구매|결제|주문|(이거|이것|이\s*상품|이\s*옷).*?(살래|살게요|사고\s*싶)/.test(text)) {
    const numMatch0 = text.match(/(\d+)\s*번/);
    return { action: "go_purchase", itemNumber: numMatch0 ? parseInt(numMatch0[1], 10) : null, rawQuery: null };
  }
  if (/취향|좋아할\s*만/.test(text)) {
    const numMatch0 = text.match(/(\d+)\s*번/);
    return { action: "taste_match", itemNumber: numMatch0 ? parseInt(numMatch0[1], 10) : null, rawQuery: null };
  }
  if (/내\s*키|나한테|소매가?\s*(길|짧)|기장이?\s*(길|짧)|클까|작을까|맞을까/.test(text)) {
    const numMatch0 = text.match(/(\d+)\s*번/);
    return { action: "body_fit_query", itemNumber: numMatch0 ? parseInt(numMatch0[1], 10) : null, rawQuery: text };
  }
  if (/어떤\s*느낌|어떤\s*스타일|스타일이야/.test(text)) {
    const numMatch0 = text.match(/(\d+)\s*번/);
    return { action: "describe_style", itemNumber: numMatch0 ? parseInt(numMatch0[1], 10) : null, rawQuery: null };
  }

  const priceRange = parsePriceRange(text);
  if (priceRange) return { action: "filter_price_range", priceMin: priceRange.min, priceMax: priceRange.max };

  const priceRank = parsePriceRank(text);
  if (priceRank) return { action: "sort_price", priceRank: priceRank.rank, priceDirection: priceRank.direction };

  const numMatch = text.match(/(\d+)\s*번/);
  if (/유사|비슷/.test(text)) {
    const hasFilter = /더\s*(싸|싼)|더\s*(비싸|비싼)|검은|블랙|하양|화이트|빨강|레드|파랑|블루|노랑|옐로우/.test(text);
    if (hasFilter) {
      return { action: "similar_with_filter", itemNumber: numMatch ? parseInt(numMatch[1], 10) : null, filterHint: text };
    }
    return { action: "similar_item", itemNumber: numMatch ? parseInt(numMatch[1], 10) : null, rawQuery: null };
  }
  if (/다시\s*(듣|읽|들려)|한\s*번\s*더/.test(text)) return { action: "repeat", itemNumber: null, rawQuery: null };
  if (/목록|뒤로|리스트/.test(text)) return { action: "back_to_list", itemNumber: null, rawQuery: null };
  if (/다시\s*검색|새로\s*검색|검색하기/.test(text)) return { action: "new_search", itemNumber: null, rawQuery: null };

  // 짧은 긍정/부정 응답 (직전 AI 제안에 대한 응답)
  if (text.length <= 6) {
    if (/^(응|어|그래|좋아|네|예)$/.test(text)) return { action: "confirm_yes", itemNumber: null, rawQuery: null };
    if (/^(아니|아니요|안\s*돼|괜찮아|싫어)$/.test(text)) return { action: "confirm_no", itemNumber: null, rawQuery: null };
  }

  if (numMatch) return { action: "select_item", itemNumber: parseInt(numMatch[1], 10), rawQuery: null };
  for (const w of Object.keys(ORD)) {
    if (new RegExp(w + "\\s*(번째|번)").test(text)) return { action: "select_item", itemNumber: ORD[w], rawQuery: null };
  }

  const looksLikeSearch = /찾아|검색|보여줘|추천|사고\s*싶|입고\s*싶|필요해/.test(text);
  if (mode === "idle" || looksLikeSearch) return { action: "search", itemNumber: null, rawQuery: text };
  return { action: "unsupported", itemNumber: null, rawQuery: null };
}

/** 브랜드명이 아닌 상품군 질문을 규칙 기반으로 걸러내기 위한 카테고리 키워드 (stores.json의 tags와 느슨하게 대응). */
const CATEGORY_KEYWORDS = [
  "여성", "남성", "아동", "유아", "키즈", "의류", "옷", "패션", "화장품", "향수", "뷰티",
  "스포츠", "운동화", "신발", "가방", "잡화", "쥬얼리", "명품", "가전", "리빙", "가구",
  "식당", "푸드코트", "식품", "카페", "아웃도어"
];

/** Groq 없이도 동작하는 규칙 기반 명령 분류기 (오프라인 매장 내비게이션, 화면별 맥락 반영). */
function classifyOfflineCommandFallback(text, { screen }) {
  if (/정지|그만|멈춰/.test(text)) return { action: "stop", itemNumber: null, rawText: null };
  if (/도움말|명령어|사용법/.test(text)) return { action: "help", itemNumber: null, rawText: null };
  if (/설정|속도|글자|진동|음성\s*안내/.test(text)) return { action: "settings", itemNumber: null, rawText: text };
  if (/다시\s*(듣|읽|말해)/.test(text)) return { action: "repeat", itemNumber: null, rawText: null };
  if (/뒤로/.test(text)) return { action: "back", itemNumber: null, rawText: null };
  if (/^다음$|다음\s*층|다음으로/.test(text)) return { action: "next", itemNumber: null, rawText: null };

  if (/동행\s*시작/.test(text)) return { action: "start_companion", itemNumber: null, rawText: null };
  if (/층별\s*안내|층\s*안내/.test(text)) return { action: "floor_guide", itemNumber: null, rawText: null };
  if (/매장\s*찾기|찾아줘$/.test(text) && !screen) return { action: "find_store", itemNumber: null, rawText: null };
  if (/직원\s*불러/.test(text)) return { action: "call_staff", itemNumber: null, rawText: null };
  if (/그냥\s*둘러|둘러볼래/.test(text)) return { action: "free_browse", itemNumber: null, rawText: null };
  if (/보이는\s*것?\s*설명|뭐가?\s*보여/.test(text)) return { action: "describe_scene", itemNumber: null, rawText: null };
  if (/간판\s*읽어/.test(text)) return { action: "read_sign", itemNumber: null, rawText: null };
  if (/온라인.*?(보고\s*싶|검색|찾아|가고\s*싶|쇼핑)/.test(text)) return { action: "go_online", itemNumber: null, rawText: null };

  const numMatch = text.match(/(\d+)\s*번/);
  const ORD2 = { 첫: 1, 하나: 1, 일: 1, 둘: 2, 두: 2, 이: 2, 셋: 3, 세: 3, 삼: 3 };
  let ord = numMatch ? parseInt(numMatch[1], 10) : null;
  if (!ord) {
    for (const w of Object.keys(ORD2)) {
      if (new RegExp(w + "\\s*(번째|번)").test(text)) { ord = ORD2[w]; break; }
    }
  }
  if (ord) {
    if (screen === "find") return { action: "select_search_result", itemNumber: ord, rawText: null };
    return { action: "select_store", itemNumber: ord, rawText: null };
  }

  const looksLikeCategory = CATEGORY_KEYWORDS.some((k) => text.includes(k));
  if (screen === "home" || screen === "store") {
    return { action: looksLikeCategory ? "category_search" : "brand_search", itemNumber: null, rawText: text };
  }
  if (screen === "browse") return { action: "set_destination", itemNumber: null, rawText: text };
  if (screen === "find") {
    return { action: looksLikeCategory ? "category_search" : "brand_search", itemNumber: null, rawText: text };
  }
  return { action: "unsupported", itemNumber: null, rawText: null };
}

/** eBay/데모 원본 아이템 + Groq 속성 보강 결과 → types.ts의 Product로 정규화 */
function toProduct(raw, enrich) {
  return {
    id: raw.id,
    name: raw.title,
    price: raw.priceValue ?? 0,
    image: raw.image ?? null,
    link: raw.link ?? null,
    store: raw.store ?? null,
    sellerFeedbackPercentage: raw.sellerFeedbackPercentage ?? null,
    sellerFeedbackScore: raw.sellerFeedbackScore ?? null,
    brand: enrich?.brand ?? null,
    category: enrich?.category ?? raw.categoryPath ?? null,
    color: enrich?.color ?? null,
    style: enrich?.style ?? null,
    modelNumber: enrich?.modelNumber ?? null,
    material: enrich?.material ?? null,
    sizeInfo: enrich?.sizeInfo ?? null
  };
}

module.exports = { classifyCommandFallback, classifyOfflineCommandFallback, toProduct };
