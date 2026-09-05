const { test } = require("node:test");
const assert = require("node:assert/strict");

// config를 먼저 몽키패치한 뒤 groqService를 로드해야 model/fallbackModels가 반영된다.
const config = require("../src/config");
config.groq.apiKey = "test-key";
config.groq.model = "blocked-model";
config.groq.fallbackModels = ["fallback-model-1", "fallback-model-2"];

const groq = require("../src/services/groqService");

function mockFetchSequence(handlers) {
  let call = 0;
  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    const handler = handlers[call++];
    return handler(body);
  };
}

function okResponse(content) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] })
  };
}
function errResponse(status, code) {
  return {
    ok: false,
    status,
    text: async () => JSON.stringify({ error: { message: `blocked`, code } })
  };
}

test("callGroq(저수준): 차단 에러 시 폴백 모델로 넘어가 성공한다", async () => {
  mockFetchSequence([
    async (body) => { assert.equal(body.model, "blocked-model"); return errResponse(403, "model_permission_blocked_org"); },
    async (body) => { assert.equal(body.model, "fallback-model-1"); return okResponse("fallback 성공"); }
  ]);
  // groqService는 callGroq를 내부에서만 export하지 않으므로, describeProductWithGroq처럼
  // 공개된 함수를 통해 간접 검증한다.
  const desc = await groq.describeProductWithGroq(["상품명: 테스트"], null);
  assert.equal(desc, "fallback 성공");
});

test("callGroq(저수준): 인증 오류(401)는 모델을 바꿔도 소용없으므로 즉시 실패한다", async () => {
  let calls = 0;
  global.fetch = async () => { calls++; return errResponse(401, "invalid_api_key"); };
  await assert.rejects(() => groq.describeProductWithGroq(["상품명: 테스트"], null));
  assert.equal(calls, 1, "401은 재시도도, 모델 전환도 하지 않고 1번만 호출되어야 함");
});

test("callGroq(저수준): 모든 모델이 다 차단되면 마지막 에러를 던진다", async () => {
  mockFetchSequence([
    async () => errResponse(403, "model_permission_blocked_org"),
    async () => errResponse(403, "model_permission_blocked_org"),
    async () => errResponse(403, "model_permission_blocked_org")
  ]);
  await assert.rejects(
    () => groq.describeProductWithGroq(["상품명: 테스트"], null),
    /model_permission_blocked_org/
  );
});

test("callGroq(저수준): Groq 모델이 전부 막혀도 Gemini(다른 계정)가 있으면 자동 전환해서 성공한다", async () => {
  config.gemini.apiKey = "gemini-test-key";
  config.gemini.model = "gemini-2.0-flash";
  try {
    mockFetchSequence([
      async (body) => { assert.equal(body.model, "blocked-model"); return errResponse(403, "model_permission_blocked_org"); },
      async (body) => { assert.equal(body.model, "fallback-model-1"); return errResponse(403, "model_permission_blocked_org"); },
      async (body) => { assert.equal(body.model, "fallback-model-2"); return errResponse(403, "model_permission_blocked_org"); },
      async (body) => { assert.equal(body.model, "gemini-2.0-flash"); return okResponse("Gemini로 성공"); }
    ]);
    const desc = await groq.describeProductWithGroq(["상품명: 테스트"], null);
    assert.equal(desc, "Gemini로 성공");
  } finally {
    config.gemini.apiKey = ""; // 다른 테스트에 영향 주지 않도록 원복
  }
});

test("callGroq(저수준): Groq 키가 401로 완전히 무효여도(모델 문제 아님) Gemini는 시도한다", async () => {
  config.gemini.apiKey = "gemini-test-key";
  try {
    mockFetchSequence([
      async (body) => { assert.equal(body.model, "blocked-model"); return errResponse(401, "invalid_api_key"); },
      async (body) => { assert.equal(body.model, "gemini-2.0-flash"); return okResponse("Gemini로 성공(401 우회)"); }
    ]);
    const desc = await groq.describeProductWithGroq(["상품명: 테스트"], null);
    assert.equal(desc, "Gemini로 성공(401 우회)");
  } finally {
    config.gemini.apiKey = "";
  }
});

test("callGroq(저수준): Groq·Gemini 둘 다 계정 문제여도 OpenRouter(세 번째 계정)로 넘어간다", async () => {
  config.gemini.apiKey = "gemini-test-key";
  config.openrouter.apiKey = "openrouter-test-key";
  config.openrouter.model = "openrouter/free";
  try {
    mockFetchSequence([
      async (body) => { assert.equal(body.model, "blocked-model"); return errResponse(403, "PERMISSION_DENIED"); },
      async (body) => { assert.equal(body.model, "gemini-2.0-flash"); return errResponse(403, "PERMISSION_DENIED"); },
      async (body) => { assert.equal(body.model, "openrouter/free"); return okResponse("OpenRouter로 성공"); }
    ]);
    const desc = await groq.describeProductWithGroq(["상품명: 테스트"], null);
    assert.equal(desc, "OpenRouter로 성공");
  } finally {
    config.gemini.apiKey = "";
    config.openrouter.apiKey = "";
  }
});

test("isModelUnavailableError 판단: '폐기됨' 문구도 모델 문제로 분류해 같은 제공자의 다음 모델부터 시도한다", async () => {
  // 같은 제공자(Groq) 안에 모델이 2개 있을 때, "문구 기반 폐기 감지"가 제대로 되면
  // 곧장 Gemini로 건너뛰지 않고 Groq의 두 번째 모델을 먼저 시도해야 한다.
  config.groq.apiKey = "test-key";
  config.groq.model = "model-a";
  config.groq.fallbackModels = ["model-b"];
  config.gemini.apiKey = "gemini-test-key";
  try {
    mockFetchSequence([
      async (body) => {
        assert.equal(body.model, "model-a");
        return {
          ok: false, status: 404,
          text: async () => JSON.stringify([{ error: { code: 404, message: "This model models/model-a is no longer available. Please update your code.", status: "NOT_FOUND" } }])
        };
      },
      async (body) => { assert.equal(body.model, "model-b"); return okResponse("같은 제공자의 다음 모델로 성공"); }
    ]);
    const desc = await groq.describeProductWithGroq(["상품명: 테스트"], null);
    assert.equal(desc, "같은 제공자의 다음 모델로 성공");
  } finally {
    config.gemini.apiKey = "";
    config.groq.model = "blocked-model";
    config.groq.fallbackModels = ["fallback-model-1", "fallback-model-2"];
  }
});
