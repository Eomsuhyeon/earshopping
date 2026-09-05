const { test } = require("node:test");
const assert = require("node:assert/strict");
const { classifyCommandFallback, toProduct } = require("../src/services/commandService");

test("classifyCommandFallback: '정지'는 stop", () => {
  assert.equal(classifyCommandFallback("정지해줘", { mode: "results" }).action, "stop");
});

test("classifyCommandFallback: '다시 들려줘'는 repeat (들려 패턴 인식)", () => {
  assert.equal(classifyCommandFallback("다시 들려줘", { mode: "detail" }).action, "repeat");
});

test("classifyCommandFallback: '1번 자세히 들려줘'는 select_item + itemNumber 1", () => {
  const r = classifyCommandFallback("1번 자세히 들려줘", { mode: "results" });
  assert.equal(r.action, "select_item");
  assert.equal(r.itemNumber, 1);
});

test("classifyCommandFallback: '비슷한 상품 찾아줘' (번호 없음)는 similar_item + itemNumber null", () => {
  const r = classifyCommandFallback("비슷한 상품 찾아줘", { mode: "detail" });
  assert.equal(r.action, "similar_item");
  assert.equal(r.itemNumber, null);
});

test("classifyCommandFallback: '3번이랑 비슷한 옷 찾아줘'는 similar_item + itemNumber 3", () => {
  const r = classifyCommandFallback("3번이랑 비슷한 옷 찾아줘", { mode: "results" });
  assert.equal(r.action, "similar_item");
  assert.equal(r.itemNumber, 3);
});

test("classifyCommandFallback: idle 상태의 임의 발화는 search로 처리", () => {
  const r = classifyCommandFallback("허리 밴딩 있는 데님 팬츠", { mode: "idle" });
  assert.equal(r.action, "search");
});

test("classifyCommandFallback: results 상태에서 애매한 발화(날씨)는 unsupported", () => {
  const r = classifyCommandFallback("오늘 날씨 어때", { mode: "results" });
  assert.equal(r.action, "unsupported");
});

test("classifyCommandFallback: '더 찾아줘'는 more_results", () => {
  assert.equal(classifyCommandFallback("더 찾아줘", { mode: "results" }).action, "more_results");
});

test("toProduct: raw + enrichment을 Product 스키마로 정규화한다", () => {
  const raw = { id: "x1", title: "Test Pants", priceValue: 19.9, image: "img", link: "link", store: "shop" };
  const enrich = { brand: "Acme", category: "팬츠", color: "블랙", style: "캐주얼", material: "코튼", modelNumber: null, sizeInfo: null };
  const p = toProduct(raw, enrich);
  assert.equal(p.id, "x1");
  assert.equal(p.name, "Test Pants");
  assert.equal(p.price, 19.9);
  assert.equal(p.brand, "Acme");
  assert.equal(p.material, "코튼");
});

test("toProduct: enrichment이 없으면 null 필드로 채운다", () => {
  const raw = { id: "x2", title: "Plain Pants", priceValue: null };
  const p = toProduct(raw, null);
  assert.equal(p.price, 0);
  assert.equal(p.brand, null);
  assert.equal(p.sizeInfo, null);
});
