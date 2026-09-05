/**
 * 환경변수를 한 곳에서 읽고 검증한다. 나머지 코드는 이 모듈만 참조하고
 * process.env를 직접 읽지 않는다 — 설정 출처를 하나로 유지하기 위함.
 */
const { z } = require("zod");
require("dotenv").config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),

  // .trim()으로 값 끝의 개행/공백(특히 Windows에서 .env 편집 시 섞이기 쉬운 \r)을 제거한다.
  // 키 자체가 잘못된 게 아니라 이런 보이지 않는 문자 때문에 "invalid_client" 같은 인증 오류가
  // 나는 경우가 흔해서 방어적으로 넣었다.
  GROQ_API_KEY: z.string().optional().default("").transform((s) => s.trim()),
  GROQ_MODEL: z.string().optional().default("openai/gpt-oss-120b").transform((s) => s.trim()),
  // 1순위 모델이 조직 단위로 막혀있거나(model_permission_blocked_org) 폐기된 경우
  // 사람이 .env를 고치지 않아도 자동으로 다음 모델로 넘어가도록 하는 폴백 목록.
  GROQ_MODEL_FALLBACKS: z.string().optional().default("openai/gpt-oss-20b,qwen/qwen3.6-27b"),

  // Groq 계정/조직 자체에 문제가 있어 모델을 전부 못 쓸 때를 대비한 완전히 다른 무료 제공자.
  // https://aistudio.google.com/apikey 에서 개인 계정으로 즉시(조직 승인 없이) 발급 가능.
  GEMINI_API_KEY: z.string().optional().default("").transform((s) => s.trim()),
  GEMINI_MODEL: z.string().optional().default("gemini-3.7-flash").transform((s) => s.trim()),

  // Groq와 Gemini 둘 다 계정 문제로 막혀있을 때를 대비한 세 번째 무료 경로.
  // https://openrouter.ai/keys 에서 신용카드 없이 무료 발급. 기본 모델 "openrouter/free"는
  // 그 시점에 살아있는 무료 모델 중 하나를 OpenRouter가 자동으로 골라주는 라우터라서,
  // 특정 무료 모델이 나중에 없어져도 이 설정은 계속 유효하다.
  OPENROUTER_API_KEY: z.string().optional().default("").transform((s) => s.trim()),
  OPENROUTER_MODEL: z.string().optional().default("openrouter/free").transform((s) => s.trim()),

  EBAY_CLIENT_ID: z.string().optional().default("").transform((s) => s.trim()),
  EBAY_CLIENT_SECRET: z.string().optional().default("").transform((s) => s.trim()),
  EBAY_ENV: z.enum(["production", "sandbox"]).default("production"),

  CORS_ORIGINS: z.string().optional().default(""),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60)
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // 여기서 실패하는 건 타입이 잘못된 값(예: PORT=abc)을 넣었을 때뿐이다.
  // 키가 비어있는 것 자체는 정상(데모 모드)이므로 에러로 취급하지 않는다.
  console.error("환경변수 설정 오류:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

const env = parsed.data;

const config = {
  nodeEnv: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  port: env.PORT,

  groq: {
    apiKey: env.GROQ_API_KEY,
    model: env.GROQ_MODEL,
    fallbackModels: env.GROQ_MODEL_FALLBACKS.split(",").map((s) => s.trim()).filter(Boolean),
    connected: Boolean(env.GROQ_API_KEY)
  },

  gemini: {
    apiKey: env.GEMINI_API_KEY,
    model: env.GEMINI_MODEL,
    connected: Boolean(env.GEMINI_API_KEY)
  },

  openrouter: {
    apiKey: env.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL,
    connected: Boolean(env.OPENROUTER_API_KEY)
  },

  ebay: {
    clientId: env.EBAY_CLIENT_ID,
    clientSecret: env.EBAY_CLIENT_SECRET,
    env: env.EBAY_ENV,
    host: env.EBAY_ENV === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com",
    connected: Boolean(env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET)
  },

  corsOrigins: env.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
  rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE
};

module.exports = config;
