const express = require("express");
const { z } = require("zod");

const groq = require("../services/groqService");
const ebay = require("../services/ebayService");
const demo = require("../services/demoService");
const { computeLowestPrice, computeFitNotes } = require("../services/pricingService");
const { toProduct } = require("../services/commandService");
const { searchCache: cache } = require("../services/cacheService");
const logger = require("../utils/logger");

const router = express.Router();

const BodySchema = z
  .object({
    transcript: z.string().trim().max(300).optional(),
    query: z.string().trim().max(200).optional(),
    intent: z
      .object({
        query: z.string(),
        category: z.string().nullable().optional(),
        style: z.array(z.string()).optional(),
        color: z.string().nullable().optional()
      })
      .optional(),
    limit: z.coerce.number().int().min(1).max(5).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    bodyProfile: z
      .object({
        heightCm: z.coerce.number().positive().max(250).nullable().optional(),
        chestCm: z.coerce.number().positive().max(200).nullable().optional()
      })
      .nullable()
      .optional()
  })
  .refine((b) => (b.transcript && b.transcript.length > 0) || (b.query && b.query.length > 0), {
    message: "transcript 또는 query 중 하나는 필요합니다."
  });

router.post("/search-products", async (req, res, next) => {
  try {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "잘못된 요청입니다.", details: parsed.error.flatten() });
    }
    const { transcript, query: directQuery, intent: passedIntent, bodyProfile } = parsed.data;
    const limit = parsed.data.limit ?? 5;
    const offset = parsed.data.offset ?? 0;

    const cacheKey = `${(directQuery || transcript || "").toLowerCase()}::${offset}::${limit}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    let fallback = false;
    let intentFallbackReason = null;
    let ebayFallbackReason = null;

    // 1) 검색 조건 이해 (directQuery가 있으면 재추출 생략 — 더 찾기/유사상품 케이스)
    let intent;
    if (directQuery) {
      intent = passedIntent || { query: directQuery, category: null, style: [], color: null };
    } else {
      try {
        intent = await groq.extractIntent(transcript);
      } catch (e) {
        intent = demo.demoIntent(transcript);
        fallback = true;
        intentFallbackReason = e.message || e.code;
        logger.warn("검색조건 이해 실패(Groq) - 원문을 그대로 검색어로 사용", { reason: intentFallbackReason });
      }
    }

    // 2) 실제 상품 데이터 조회 (최대 5개, offset 페이지네이션)
    let rawItems, hasMore, total;
    try {
      const r = await ebay.searchEbayRaw(intent.query || transcript, limit, offset);
      if (!r.items.length) throw new Error("EMPTY_RESULT");
      ({ items: rawItems, hasMore, total } = r);
    } catch (e) {
      const r = demo.demoRawItems(intent.query || transcript, offset, limit);
      ({ items: rawItems, hasMore, total } = r);
      fallback = true;
      ebayFallbackReason = e.message || e.code;
      // intentFallbackReason과 절대 합치지 않는다 — 둘은 서로 다른 단계의 서로 다른 원인이다.
      logger.warn("eBay 검색 실패 - 데모로 폴백", { reason: ebayFallbackReason });
    }

    // 3) 속성 보강
    let enrichments;
    try {
      if (fallback) throw new Error("SKIP_GROQ_ENRICH_IN_DEMO");
      enrichments = await groq.enrichProductsWithGroq(rawItems);
    } catch (e) {
      enrichments = demo.demoEnrichment(rawItems);
    }

    // 4) Product[] 정규화
    const products = rawItems.map((raw, i) => toProduct(raw, enrichments[i]));

    // 5) 배송비 포함 최저가 (코드 로직)
    const lowestPrice = computeLowestPrice(rawItems);

    // 6) 착용감 안내 (선택)
    const fitNotes = computeFitNotes(products, bodyProfile);

    const response = {
      intent, products, lowestPrice, fitNotes, hasMore, total, offset, limit, fallback,
      // 두 단계의 실패 원인을 각각 그대로 노출한다 (하나로 합치면 뒤 단계 원인이 가려짐)
      fallbackReason: ebayFallbackReason || intentFallbackReason || null,
      intentFallbackReason,
      ebayFallbackReason
    };
    if (!fallback) cache.set(cacheKey, response);
    return res.json(response);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
