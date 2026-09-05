const express = require("express");
const { z } = require("zod");
const groq = require("../services/groqService");

const router = express.Router();

const ProductSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  price: z.number().nullable().optional(),
  brand: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  style: z.string().nullable().optional(),
  material: z.string().nullable().optional(),
  modelNumber: z.string().nullable().optional(),
  store: z.string().nullable().optional(),
  sellerFeedbackPercentage: z.number().nullable().optional(),
  sellerFeedbackScore: z.number().nullable().optional(),
  sizeInfo: z
    .object({
      length: z.number().nullable().optional(),
      shoulder: z.number().nullable().optional(),
      chest: z.number().nullable().optional(),
      sleeve: z.number().nullable().optional()
    })
    .nullable()
    .optional()
});

const BodySchema = z.object({
  product: ProductSchema,
  fitNote: z.string().max(200).nullable().optional()
});

router.post("/describe-product", async (req, res, next) => {
  try {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "잘못된 요청입니다.", details: parsed.error.flatten() });
    }
    const { product, fitNote } = parsed.data;

    const factLines = [
      `상품명: ${product.name}`,
      `가격: ${product.price != null ? `${product.price} 달러` : "정보 없음"}`,
      product.brand ? `브랜드: ${product.brand}` : null,
      product.category ? `카테고리: ${product.category}` : null,
      product.color ? `색상: ${product.color}` : null,
      product.style ? `스타일: ${product.style}` : null,
      product.material ? `소재: ${product.material}` : null,
      product.modelNumber ? `모델번호: ${product.modelNumber}` : null,
      product.store ? `판매자: ${product.store}` : null,
      product.sellerFeedbackPercentage != null ? `판매자 평점(리뷰 기반 긍정 비율): ${product.sellerFeedbackPercentage}%` : null,
      product.sellerFeedbackScore != null ? `판매자 거래 건수 지표: ${product.sellerFeedbackScore}` : null,
      product.sizeInfo
        ? `사이즈 정보: ${
            Object.entries(product.sizeInfo)
              .filter(([, v]) => v != null)
              .map(([k, v]) => `${k} ${v}cm`)
              .join(", ") || "없음"
          }`
        : null
    ].filter(Boolean);

    try {
      const description = await groq.describeProductWithGroq(factLines, fitNote);
      return res.json({
        description,
        fallback: false,
        facts: factLines,
        suggestion: { text: "비슷한 상품도 찾아드릴까요?", action: "similar_item" }
      });
    } catch (e) {
      const sentence =
        `${product.name}입니다. 가격은 ${product.price != null ? `${product.price}달러` : "확인되지 않았어요"}이고, ` +
        `${product.brand ? `${product.brand} 브랜드의 ` : ""}` +
        `${product.color ? `${product.color} 색상, ` : ""}` +
        `${product.material ? `${product.material} 소재입니다. ` : "소재 정보는 확인되지 않았어요. "}` +
        `${product.store ? `판매자는 ${product.store}입니다. ` : ""}` +
        `${product.sellerFeedbackPercentage != null ? `판매자 평점은 ${product.sellerFeedbackPercentage}%예요. ` : ""}` +
        (fitNote || "정확한 실측 사이즈는 상품 페이지에서 다시 확인해보시는 걸 권장해요.");
      return res.json({
        description: sentence,
        fallback: true,
        reason: e.message || e.code,
        facts: factLines,
        suggestion: { text: "비슷한 상품도 찾아드릴까요?", action: "similar_item" }
      });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
