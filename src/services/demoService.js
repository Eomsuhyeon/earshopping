/**
 * Groq/eBay 키가 없거나 외부 호출이 실패했을 때 쓰는 데모 데이터.
 * 실제로 로드되는 이미지(picsum)와 실제로 열리는 eBay 검색 링크를 사용하며,
 * 검색어(한국어/영어 모두)에 맞춰 순서를 바꿔서 "검색이 실제로 반영되는 것처럼" 동작한다.
 */

function demoIntent(transcript) {
  return { query: transcript, category: "패션 아이템", style: ["요청 기반 추정"], color: null };
}

const DEMO_POOL = [
  { id: "demo-1", title: "Wide Straight Denim Pants Elastic Waist", priceValue: 32.0, condition: "New with tags", store: "denim.world.shop", categoryPath: "Pants", shippingCost: 4.5, tags: ["denim", "wide", "straight", "elastic", "waist"] },
  { id: "demo-2", title: "Comfort Fit Cotton Jogger Pants", priceValue: 24.5, condition: "New", store: "casualwear.co", categoryPath: "Pants", shippingCost: 0, tags: ["cotton", "jogger", "comfort", "casual"] },
  { id: "demo-3", title: "Stretch Panel Denim Pants Casual", priceValue: 28.9, condition: "New with tags", store: "denim.world.shop", categoryPath: "Pants", shippingCost: 3.0, tags: ["denim", "stretch", "casual"] },
  { id: "demo-4", title: "High Waist Banded Slacks", priceValue: 21.0, condition: "Pre-owned", store: "vintage.finds", categoryPath: "Pants", shippingCost: 6.0, tags: ["slacks", "banded", "waist", "vintage"] },
  { id: "demo-5", title: "Relaxed Fit Cargo Pants Elastic Waist", priceValue: 27.75, condition: "New", store: "streetstyle.us", categoryPath: "Pants", shippingCost: 0, tags: ["cargo", "relaxed", "elastic", "waist", "casual"] },
  { id: "demo-6", title: "Classic Straight Leg Blue Denim Jeans", priceValue: 35.0, condition: "New with tags", store: "denim.world.shop", categoryPath: "Pants", shippingCost: 5.0, tags: ["denim", "jeans", "straight", "blue", "classic"] },
  { id: "demo-7", title: "Soft Knit Lounge Pants Drawstring", priceValue: 19.99, condition: "New", store: "casualwear.co", categoryPath: "Pants", shippingCost: 0, tags: ["knit", "lounge", "soft", "comfort"] },
  { id: "demo-8", title: "Black Tapered Chino Pants Slim Fit", priceValue: 26.4, condition: "New with tags", store: "officeline.shop", categoryPath: "Pants", shippingCost: 4.0, tags: ["chino", "black", "slim", "tapered"] },
  { id: "demo-9", title: "Distressed Wide Leg Denim Pants", priceValue: 30.2, condition: "Pre-owned", store: "vintage.finds", categoryPath: "Pants", shippingCost: 3.5, tags: ["denim", "distressed", "wide", "vintage"] },
  { id: "demo-10", title: "Corduroy Straight Pants Comfort Waist", priceValue: 23.0, condition: "New", store: "streetstyle.us", categoryPath: "Pants", shippingCost: 0, tags: ["corduroy", "straight", "comfort", "waist"] }
];

const KOREAN_TAG_HINTS = {
  "데님": "denim", "청바지": "denim", "진": "denim", "조거": "jogger", "조깅": "jogger",
  "캐주얼": "casual", "밴딩": "elastic", "허리밴딩": "elastic", "슬랙스": "slacks",
  "치노": "chino", "카고": "cargo", "골덴": "corduroy", "코듀로이": "corduroy",
  "니트": "knit", "라운지": "lounge", "빈티지": "vintage", "찢어진": "distressed",
  "와이드": "wide", "일자": "straight", "블랙": "black", "검정": "black", "슬림": "slim",
  "편안": "comfort", "스트레치": "stretch"
};

function koreanQueryToTags(text) {
  const found = [];
  for (const [kr, en] of Object.entries(KOREAN_TAG_HINTS)) {
    if (text.includes(kr)) found.push(en);
  }
  return found;
}

function demoRawItems(query, offset = 0, limit = 5) {
  const qLower = (query || "").toLowerCase();
  const krTags = koreanQueryToTags(query || "");
  const scored = DEMO_POOL.map((it) => ({
    it,
    score: it.tags.filter((t) => qLower.includes(t) || krTags.includes(t)).length
  }));
  scored.sort((a, b) => b.score - a.score); // 안정 정렬: 동점이면 원래 순서 유지
  const sortedPool = scored.map((s) => s.it);

  const slice = sortedPool.slice(offset, offset + limit);
  const items = slice.map((it) => ({
    ...it,
    image: `https://picsum.photos/seed/voicefit-${it.id}/400/400`,
    link: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query || it.title)}`,
    // 데모 판매자 평점 — id 기반으로 고정값을 만들어 매번 같은 상품엔 같은 값이 나오게 한다
    sellerFeedbackPercentage: 90 + (parseInt(it.id.replace(/\D/g, ""), 10) % 10),
    sellerFeedbackScore: 100 + parseInt(it.id.replace(/\D/g, ""), 10) * 137
  }));
  return { items, hasMore: offset + limit < DEMO_POOL.length, total: DEMO_POOL.length };
}

const MATERIAL_MAP = [["denim", "데님"], ["cotton", "코튼"], ["corduroy", "코듀로이"], ["knit", "니트"], ["chino", "치노"]];
const STYLE_MAP = [
  ["casual", "캐주얼"], ["cargo", "카고"], ["jogger", "조거"], ["slacks", "슬랙스"],
  ["lounge", "라운지"], ["vintage", "빈티지"], ["distressed", "빈티지 워싱"]
];
const COLOR_MAP = [["black", "블랙"], ["blue", "블루"]];

function pick(titleLower, map) {
  for (const [en, kr] of map) if (titleLower.includes(en)) return kr;
  return null;
}

/** 데모 데이터는 이미 속성을 알고 있으므로 Groq 호출 없이 규칙 기반으로 채운다. */
function demoEnrichment(rawItems) {
  return rawItems.map((it) => {
    const t = it.title.toLowerCase();
    return {
      brand: null,
      category: "팬츠",
      color: pick(t, COLOR_MAP),
      style: pick(t, STYLE_MAP),
      material: pick(t, MATERIAL_MAP),
      modelNumber: null,
      sizeInfo: null
    };
  });
}

module.exports = { demoIntent, demoRawItems, demoEnrichment, DEMO_POOL };
