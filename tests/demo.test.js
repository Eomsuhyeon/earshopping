const { test } = require("node:test");
const assert = require("node:assert/strict");
const { demoRawItems, demoEnrichment } = require("../src/services/demoService");

test("demoRawItems: 'corduroy' 검색어를 넣으면 코듀로이 상품이 1순위로 온다", () => {
  const { items } = demoRawItems("corduroy pants", 0, 5);
  assert.match(items[0].title.toLowerCase(), /corduroy/);
});

test("demoRawItems: 한국어 '데님'도 태그 매칭되어 데님 상품이 상위에 온다", () => {
  const { items } = demoRawItems("데님 팬츠 찾아줘", 0, 5);
  const denimCount = items.filter((it) => it.title.toLowerCase().includes("denim")).length;
  assert.ok(denimCount >= 3, "상위 5개 중 데님이 다수여야 함");
});

test("demoRawItems: offset/limit으로 페이지네이션이 동작하고 hasMore가 정확하다", () => {
  const page1 = demoRawItems("pants", 0, 5);
  const page2 = demoRawItems("pants", 5, 5);
  assert.equal(page1.items.length, 5);
  assert.equal(page2.items.length, 5);
  assert.equal(page1.hasMore, true);
  assert.equal(page2.hasMore, false);
  const ids1 = page1.items.map((i) => i.id);
  const ids2 = page2.items.map((i) => i.id);
  assert.equal(new Set([...ids1, ...ids2]).size, 10, "두 페이지에 중복이 없어야 함");
});

test("demoRawItems: 이미지/링크가 실제로 로드/오픈 가능한 형태다", () => {
  const { items } = demoRawItems("denim", 0, 1);
  assert.match(items[0].image, /^https:\/\/picsum\.photos\//);
  assert.match(items[0].link, /^https:\/\/www\.ebay\.com\/sch\/i\.html\?_nkw=/);
});

test("demoEnrichment: 제목 기반으로 material/style/color를 채운다", () => {
  const rawItems = [{ title: "Black Tapered Chino Pants Slim Fit" }];
  const [enrich] = demoEnrichment(rawItems);
  assert.equal(enrich.color, "블랙");
  assert.equal(enrich.material, "치노");
});
