const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyCommandFallback, classifyOfflineCommandFallback } = require("../src/services/commandService");

test("sort_price: '가장 싼 거'는 asc rank 1", () => {
  const r = classifyCommandFallback("가장 싼 거 알려줘", { mode: "results" });
  assert.equal(r.action, "sort_price");
  assert.equal(r.priceDirection, "asc");
  assert.equal(r.priceRank, 1);
});

test("sort_price: '세 번째로 싼 거'는 asc rank 3", () => {
  const r = classifyCommandFallback("세 번째로 싼 거", { mode: "results" });
  assert.equal(r.action, "sort_price");
  assert.equal(r.priceRank, 3);
});

test("filter_price_range: '5만원 이하'는 priceMax 50000", () => {
  const r = classifyCommandFallback("5만원 이하", { mode: "results" });
  assert.equal(r.action, "filter_price_range");
  assert.equal(r.priceMax, 50000);
  assert.equal(r.priceMin, null);
});

test("filter_price_range: '5만원대'는 min 50000 max 59999", () => {
  const r = classifyCommandFallback("5만원대 보여줘", { mode: "results" });
  assert.equal(r.priceMin, 50000);
  assert.equal(r.priceMax, 59999);
});

test("similar_with_filter: '비슷한데 더 싼 거'는 필터 포함으로 분류", () => {
  const r = classifyCommandFallback("비슷한데 더 싼 거 없어?", { mode: "results" });
  assert.equal(r.action, "similar_with_filter");
});

test("similar_item: 필터 조건 없는 순수 유사상품 요청", () => {
  const r = classifyCommandFallback("이거랑 비슷한 거 보여줘", { mode: "detail" });
  assert.equal(r.action, "similar_item");
});

test("describe_style / taste_match / body_fit_query 분류", () => {
  assert.equal(classifyCommandFallback("이거 어떤 느낌이야?", { mode: "detail" }).action, "describe_style");
  assert.equal(classifyCommandFallback("내 취향에 맞아?", { mode: "detail" }).action, "taste_match");
  assert.equal(classifyCommandFallback("소매가 길까?", { mode: "detail" }).action, "body_fit_query");
});

test("go_offline: '직접 입어보고 싶어'", () => {
  assert.equal(classifyCommandFallback("직접 입어보고 싶어", { mode: "detail" }).action, "go_offline");
});

test("confirm_yes/confirm_no: 짧은 응답만 인식", () => {
  assert.equal(classifyCommandFallback("응", { mode: "detail" }).action, "confirm_yes");
  assert.equal(classifyCommandFallback("아니요", { mode: "detail" }).action, "confirm_no");
});

test("offline: 숫자는 화면에 따라 select_store 또는 select_search_result로 분류", () => {
  assert.equal(classifyOfflineCommandFallback("1번", { screen: "home" }).action, "select_store");
  assert.equal(classifyOfflineCommandFallback("1번", { screen: "find" }).action, "select_search_result");
});

test("offline: 브랜드명을 바로 말하면 brand_search로 분류", () => {
  const r = classifyOfflineCommandFallback("나이키", { screen: "store" });
  assert.equal(r.action, "brand_search");
  assert.equal(r.rawText, "나이키");
});

test("offline: browse 화면에서 목적지 발화는 set_destination으로 분류", () => {
  const r = classifyOfflineCommandFallback("노란색 옷 사고 싶어요", { screen: "browse" });
  assert.equal(r.action, "set_destination");
});

test("offline: 화면별 메뉴 키워드 분류", () => {
  assert.equal(classifyOfflineCommandFallback("동행 시작해줘", { screen: "store" }).action, "start_companion");
  assert.equal(classifyOfflineCommandFallback("층별 안내", { screen: "store" }).action, "floor_guide");
  assert.equal(classifyOfflineCommandFallback("직원 불러줘", { screen: "store" }).action, "call_staff");
  assert.equal(classifyOfflineCommandFallback("그냥 둘러볼래요", { screen: "browse" }).action, "free_browse");
  assert.equal(classifyOfflineCommandFallback("지금 보이는 것 설명해줘", { screen: "browse" }).action, "describe_scene");
  assert.equal(classifyOfflineCommandFallback("간판 읽어줘", { screen: "browse" }).action, "read_sign");
});

test("offline: 음성/진동/속도/글자 관련 발화는 store 화면에서도 brand_search로 오분류되지 않고 settings로 분류된다", () => {
  assert.equal(classifyOfflineCommandFallback("음성 안내 꺼줘", { screen: "store" }).action, "settings");
  assert.equal(classifyOfflineCommandFallback("진동 켜줘", { screen: "store" }).action, "settings");
  assert.equal(classifyOfflineCommandFallback("속도 빠르게 해줘", { screen: "store" }).action, "settings");
  assert.equal(classifyOfflineCommandFallback("글자 크게 해줘", { screen: "home" }).action, "settings");
});
