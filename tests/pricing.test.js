const { test } = require("node:test");
const assert = require("node:assert/strict");
const { computeLowestPrice, computeFitNotes } = require("../src/services/pricingService");

test("computeLowestPrice: 배송비 포함 총액이 가장 낮은 상품을 고른다", () => {
  const rawItems = [
    { id: "a", priceValue: 30, shippingCost: 0 },   // 총액 30
    { id: "b", priceValue: 25, shippingCost: 8 },   // 총액 33
    { id: "c", priceValue: 28, shippingCost: 1 }    // 총액 29 <- 최저
  ];
  const result = computeLowestPrice(rawItems);
  assert.equal(result.productId, "c");
  assert.equal(result.totalWithShipping, 29);
});

test("computeLowestPrice: 가격 정보가 전혀 없으면 null", () => {
  const result = computeLowestPrice([{ id: "a", priceValue: null, shippingCost: 0 }]);
  assert.equal(result, null);
});

test("computeLowestPrice: 빈 배열이면 null", () => {
  assert.equal(computeLowestPrice([]), null);
});

test("computeFitNotes: bodyProfile이 없으면 빈 객체", () => {
  const products = [{ id: "a", sizeInfo: { length: 100 } }];
  assert.deepEqual(computeFitNotes(products, null), {});
});

test("computeFitNotes: sizeInfo가 없는 상품은 건너뛴다", () => {
  const products = [{ id: "a", sizeInfo: null }];
  const notes = computeFitNotes(products, { heightCm: 170 });
  assert.deepEqual(notes, {});
});

test("computeFitNotes: 키에 맞는 기장이면 '잘 맞을 것 같아요'를 포함한다", () => {
  const products = [{ id: "a", sizeInfo: { length: 68 } }]; // 170*0.4=68 -> 정확히 일치
  const notes = computeFitNotes(products, { heightCm: 170 });
  assert.match(notes.a, /잘 맞을 것 같아요/);
});
