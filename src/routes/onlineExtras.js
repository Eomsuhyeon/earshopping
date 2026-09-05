const express = require("express");
const { z } = require("zod");
const groq = require("../services/groqService");
const { answerBodyFitQuestion } = require("../services/pricingService");

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

/** POST /api/describe-style — "이거 어떤 느낌이야?" 같은 스타일/느낌 설명 요청 */
router.post("/describe-style", async (req, res, next) => {
  try {
    const parsed = z.object({ product: ProductSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "잘못된 요청입니다." });
    const { product } = parsed.data;

    const facts =
      `상품명: ${product.name}` +
      (product.color ? `, 색상: ${product.color}` : "") +
      (product.style ? `, 스타일: ${product.style}` : "") +
      (product.material ? `, 소재: ${product.material}` : "");

    try {
      const description = await groq.describeProductWithGroq(
        [`이 상품의 전반적인 스타일과 느낌만 짧게 설명해줘. ${facts}`],
        null
      );
      return res.json({ description, fallback: false });
    } catch (e) {
      const sentence = `${product.name}은(는) ${product.style ? `${product.style} 느낌의 ` : ""}${product.color ? `${product.color} 색상 ` : ""}아이템이에요. 정확한 스타일 정보는 상품명 기준으로 추정한 내용이에요.`;
      return res.json({ description: sentence, fallback: true, reason: e.message || e.code });
    }
  } catch (err) {
    next(err);
  }
});

/** POST /api/taste-match — "내 취향에 맞아?" */
router.post("/taste-match", async (req, res, next) => {
  try {
    const parsed = z
      .object({
        product: ProductSchema,
        tastePreferences: z
          .object({
            colors: z.array(z.string()).max(10).optional().default([]),
            styles: z.array(z.string()).max(10).optional().default([])
          })
          .optional()
          .default({})
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "잘못된 요청입니다." });
    const { product, tastePreferences } = parsed.data;

    try {
      const answer = await groq.tasteMatchWithGroq(product, tastePreferences);
      return res.json({ answer, fallback: false });
    } catch (e) {
      const colorMatch = product.color && tastePreferences.colors.some((c) => product.color.includes(c) || c.includes(product.color));
      const styleMatch = product.style && tastePreferences.styles.some((s) => product.style.includes(s) || s.includes(product.style));
      let answer;
      if (!tastePreferences.colors.length && !tastePreferences.styles.length) {
        answer = "아직 회원님의 취향(선호 색상·스타일)을 알려주지 않으셔서 판단하기 어려워요.";
      } else if (colorMatch || styleMatch) {
        answer = "회원님이 선호하시는 색상이나 스타일과 잘 맞는 편이에요.";
      } else {
        answer = "회원님이 말씀하신 취향과는 다소 다른 느낌일 수 있어요.";
      }
      return res.json({ answer, fallback: true, reason: e.message || e.code });
    }
  } catch (err) {
    next(err);
  }
});

/** POST /api/body-fit — "내 키에 길이가 어때?", "소매가 길까?" 등 구체적 체형 비교 질문 */
router.post("/body-fit", (req, res, next) => {
  try {
    const parsed = z
      .object({
        product: ProductSchema,
        bodyProfile: z
          .object({
            heightCm: z.number().positive().max(250).nullable().optional(),
            chestCm: z.number().positive().max(200).nullable().optional()
          })
          .nullable()
          .optional(),
        question: z.string().trim().max(200).optional().default("")
      })
      .safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "잘못된 요청입니다." });
    const { product, bodyProfile, question } = parsed.data;
    const result = answerBodyFitQuestion(product, bodyProfile, question);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
