const express = require("express");
const { z } = require("zod");
const groq = require("../services/groqService");
const { classifyCommandFallback } = require("../services/commandService");

const router = express.Router();

const BodySchema = z.object({
  transcript: z.string().trim().min(1).max(300),
  mode: z.enum(["idle", "results", "detail"]).default("idle"),
  resultsCount: z.coerce.number().int().min(0).max(1000).default(0)
});

router.post("/command", async (req, res, next) => {
  try {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "잘못된 요청입니다.", details: parsed.error.flatten() });
    }
    const { transcript, mode, resultsCount } = parsed.data;

    try {
      const result = await groq.classifyCommand(transcript, { mode, resultsCount });
      return res.json({ ...result, fallback: false });
    } catch (e) {
      const result = classifyCommandFallback(transcript, { mode, resultsCount });
      return res.json({ ...result, fallback: true, reason: e.message || e.code });
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
