const { test } = require("node:test");
const assert = require("node:assert/strict");
const { answerBodyFitQuestion } = require("../src/services/pricingService");

test("answerBodyFitQuestion: bodyProfile이 없으면 answered:false", () => {
  const r = answerBodyFitQuestion({ sizeInfo: { sleeve: 60 } }, null, "소매가 길까?");
  assert.equal(r.answered, false);
});

test("answerBodyFitQuestion: sizeInfo가 없으면 answered:false", () => {
  const r = answerBodyFitQuestion({ sizeInfo: null }, { heightCm: 170 }, "기장 어때?");
  assert.equal(r.answered, false);
});

test("answerBodyFitQuestion: 소매 질문은 은/는 조사가 '는'으로 올바르게 붙는다", () => {
  const r = answerBodyFitQuestion({ sizeInfo: { sleeve: 60 } }, { heightCm: 170 }, "소매가 길까?");
  assert.match(r.text, /소매는/);
});

test("answerBodyFitQuestion: 기장 질문은 은/는 조사가 '은'으로 올바르게 붙는다", () => {
  const r = answerBodyFitQuestion({ sizeInfo: { length: 68 } }, { heightCm: 170 }, "기장 어때?");
  assert.match(r.text, /기장은/);
});

test("answerBodyFitQuestion: 가슴둘레는 bodyProfile.chestCm과 직접 비교한다", () => {
  const r = answerBodyFitQuestion({ sizeInfo: { chest: 100 } }, { chestCm: 95 }, "가슴둘레 어때?");
  assert.equal(r.answered, true);
  assert.match(r.text, /잘 맞을 것 같아요/);
});

test("answerBodyFitQuestion: 질문이 애매하면 기장 기준으로 판단한다", () => {
  const r = answerBodyFitQuestion({ sizeInfo: { length: 68 } }, { heightCm: 170 }, "이거 어때?");
  assert.equal(r.answered, true);
  assert.match(r.text, /기장/);
});
