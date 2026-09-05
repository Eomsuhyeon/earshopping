/**
 * EarShopping 프론트엔드
 * ------------------------------------------------------------
 * 모든 발화는 먼저 /api/command로 보내 AI(또는 규칙 기반 폴백)가 액션을 분류한다.
 * 지원하는 액션 이외의 요청은 unsupported로 분류되어 "지원하는 기능이 아닙니다"로 안내된다.
 * 클릭은 보조 수단일 뿐, 모든 기능은 음성만으로 동작한다.
 */
(function () {
  "use strict";
  const el = (id) => document.getElementById(id);

  /** 서수를 "1번" 대신 "첫번째"로 읽어야 TTS가 "한 번"(횟수)으로 잘못 읽지 않는다 */
  const KOREAN_ORDINAL_WORDS = ["", "첫번째", "두번째", "세번째", "네번째", "다섯번째", "여섯번째", "일곱번째", "여덟번째", "아홉번째", "열번째"];
  function speakOrdinal(n) {
    return KOREAN_ORDINAL_WORDS[n] || `${n}번째`;
  }

  /** 숫자를 한자어(사이노-코리안)로 변환 — TTS가 "15달러"를 "열다섯 달러"(고유어)가 아니라
   *  "십오 달러"(한자어, 화폐 단위에 맞는 자연스러운 읽기)로 읽게 하기 위함 */
  function sinoKoreanUnder10000(n) {
    if (n === 0) return "영";
    const digits = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
    const units = ["", "십", "백", "천"];
    const s = String(n).padStart(4, "0");
    let result = "";
    for (let i = 0; i < 4; i++) {
      const d = parseInt(s[i], 10);
      if (d === 0) continue;
      const unit = units[3 - i];
      result += (d === 1 && unit !== "") ? unit : digits[d] + unit;
    }
    return result;
  }
  function sinoKoreanInt(n) {
    if (n === 0) return "영";
    const man = Math.floor(n / 10000);
    const rest = n % 10000;
    let result = "";
    if (man > 0) result += (man === 1 ? "" : sinoKoreanUnder10000(man)) + "만";
    if (rest > 0) result += sinoKoreanUnder10000(rest);
    return result;
  }
  function speakPrice(price) {
    if (price == null || isNaN(price)) return "가격 정보 없음";
    const [intStr, decStr] = String(price).split(".");
    let result = sinoKoreanInt(parseInt(intStr, 10));
    if (decStr) {
      const digitWords = ["영", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"];
      result += "점" + decStr.split("").map((d) => digitWords[parseInt(d, 10)]).join("");
    }
    return result + "달러";
  }

  /** 네트워크가 멈춰도 음성 루프가 무한정 대기하지 않도록 타임아웃 있는 fetch */
  async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  /** 외부 API(eBay)에서 온 텍스트를 innerHTML에 넣기 전 이스케이프 — XSS 방지 */
  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  /** eBay 검색 결과 URL만 허용 (javascript: 등 악성 스킴 차단) */
  function safeUrl(url) {
    if (!url) return "";
    try {
      const u = new URL(url, window.location.origin);
      return u.protocol === "https:" || u.protocol === "http:" ? u.href : "";
    } catch (e) {
      return "";
    }
  }

  const state = {
    mode: "idle", // idle -> results -> detail
    lastResults: [],
    lastIntentQuery: null,
    nextOffset: 0,
    hasMore: false,
    lowestPrice: null,
    fitNotes: {},
    currentProduct: null,
    lastSpokenText: "",
    pendingSuggestion: null,
    alwaysListen: true,
    isSpeaking: false,
    isProcessing: false
  };

  // ---------------- TTS ----------------
  function speak(text, { onend } = {}) {
    state.lastSpokenText = text;
    // STT와 TTS가 동시에 켜져 있으면 마이크가 이 발화 자체를 다시 주워듣는 "겹침" 문제가 생긴다.
    // 말을 시작하기 직전에 반드시 듣기를 먼저 끈다.
    if (listening) stopListening();
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      state.isSpeaking = true;
      micBtn.classList.add("speaking");
      u.onend = () => { state.isSpeaking = false; micBtn.classList.remove("speaking"); if (onend) onend(); };
      u.onerror = () => { state.isSpeaking = false; micBtn.classList.remove("speaking"); if (onend) onend(); };
      window.speechSynthesis.speak(u);
    } catch (e) {
      if (onend) onend();
    }
  }

  async function loadStatus() {
    try {
      const r = await fetchWithTimeout("/api/status");
      const d = await r.json();
      el("statusBar").textContent = `Groq: ${d.groqConnected ? "연결됨" : "미설정(데모)"} · eBay: ${d.ebayConnected ? "연결됨" : "미설정(데모)"} · 캐시 ${d.cacheSize}건`;
    } catch (e) {
      el("statusBar").textContent = "서버 상태를 불러오지 못했습니다.";
    }
  }

  // ---------------- STT (한국어 인식) ----------------
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  if (SpeechRecognitionCtor) {
    recognizer = new SpeechRecognitionCtor();
    recognizer.lang = "ko-KR";
    recognizer.interimResults = false;
    recognizer.maxAlternatives = 1;
  }
  const micBtn = el("micBtn");
  const textInput = el("textInput");
  const alwaysListenBox = el("alwaysListen");
  alwaysListenBox.addEventListener("change", () => { state.alwaysListen = alwaysListenBox.checked; });

  let listening = false;
  function setListeningUI(on) { listening = on; micBtn.classList.toggle("listening", on); }
  function startListening(force) {
    if (!recognizer) { el("statusSub").textContent = "이 브라우저는 음성 인식을 지원하지 않아요. Chrome을 사용해주세요."; return; }
    if (force) {
      window.speechSynthesis.cancel();
      state.isSpeaking = false;
      micBtn.classList.remove("speaking");
    }
    if (!force && (state.isSpeaking || state.isProcessing || listening)) return;
    try { recognizer.start(); setListeningUI(true); } catch (e) {}
  }
  function stopListening() {
    if (recognizer) { try { recognizer.stop(); } catch (e) {} }
    setListeningUI(false);
  }
  function scheduleRelisten(delay = 350) {
    if (!state.alwaysListen) return;
    setTimeout(() => { if (!state.isSpeaking && !state.isProcessing) startListening(); }, delay);
  }
  // 말하는 도중이어도 마이크 버튼을 누르거나 Space를 누르면 즉시 끼어들어 말할 수 있다 (barge-in)
  micBtn.addEventListener("click", () => (listening ? stopListening() : startListening(true)));
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && document.activeElement.tagName !== "INPUT") {
      e.preventDefault();
      listening ? stopListening() : startListening(true);
    }
  });
  if (recognizer) {
    recognizer.onresult = (e) => { const text = e.results[0][0].transcript; textInput.value = text; handleUtterance(text); };
    recognizer.onerror = (e) => {
      setListeningUI(false);
      if (e.error !== "no-speech" && e.error !== "aborted") el("statusSub").textContent = "음성 인식 오류: " + e.error;
      scheduleRelisten(800);
    };
    recognizer.onend = () => { setListeningUI(false); if (!state.isProcessing) scheduleRelisten(300); };
  }
  el("runBtn").addEventListener("click", () => { const t = textInput.value.trim(); if (t) handleUtterance(t); });
  textInput.addEventListener("keydown", (e) => { if (e.key === "Enter") el("runBtn").click(); });

  // ---------------- 음성으로 하는 설정 변경 (연속 듣기 / 키·가슴둘레 / 취향) ----------------
  // 서버 AI 분류를 거치지 않고 로컬에서 바로 처리한다 — 설정 변경은 네트워크 없이도 즉시 되어야 하고,
  // Groq가 막혀 있어도(규칙 기반 폴백 포함) 항상 동작해야 하기 때문이다.

  /** 한국어 음성인식은 종종 숫자를 "170" 대신 "백칠십"처럼 한글로 인식한다.
   *  숫자(정규식)로 못 찾으면 이 함수로 한글 숫자 표현도 시도한다. */
  function parseKoreanNumberWord(str) {
    const digitMap = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 칠: 7, 팔: 8, 구: 9 };
    const unitMap = { 십: 10, 백: 100, 천: 1000 };
    let result = 0, current = 0, matchedAny = false;
    for (const ch of str) {
      if (digitMap[ch]) { current = digitMap[ch]; matchedAny = true; }
      else if (unitMap[ch]) { result += (current || 1) * unitMap[ch]; current = 0; matchedAny = true; }
    }
    result += current;
    return matchedAny ? result : null;
  }
  /** "키 170으로 설정해줘" 또는 "키 백칠십으로 설정해줘" 둘 다에서 뒤따르는 숫자를 뽑아낸다 */
  function extractNumberAfter(text, keywordRegex) {
    const m = text.match(keywordRegex);
    if (!m) return null;
    const digitMatch = m[0].match(/\d{2,3}/);
    if (digitMatch) return parseInt(digitMatch[0], 10);
    // 숫자가 없으면 키워드 뒤쪽 텍스트에서 한글 숫자를 찾는다
    const afterKeyword = text.slice(m.index + m[0].length - (m[1] ? m[1].length : 0));
    const koreanNumMatch = afterKeyword.match(/[일이삼사오육칠팔구십백천]+/);
    if (koreanNumMatch) return parseKoreanNumberWord(koreanNumMatch[0]);
    // 키워드 자체에 한글 숫자가 포함된 경우 (예: "키 백칠십")
    const wholeKoreanMatch = m[0].match(/[일이삼사오육칠팔구십백천]+/);
    if (wholeKoreanMatch) return parseKoreanNumberWord(wholeKoreanMatch[0]);
    return null;
  }

  function tryHandleVoiceSettings(text) {
    // 연속 듣기 모드
    if (/연속\s*듣기.*?(꺼|끄|중지|정지)/.test(text)) {
      state.alwaysListen = false; alwaysListenBox.checked = false;
      finishTurnNoRelisten("연속 듣기 모드를 껐어요. 이제 마이크 버튼을 눌러야 다시 들을 수 있어요.");
      return true;
    }
    if (/연속\s*듣기.*?(켜|시작)/.test(text)) {
      state.alwaysListen = true; alwaysListenBox.checked = true;
      finishTurn("연속 듣기 모드를 켰어요. 응답 후에 자동으로 다시 들을게요.");
      return true;
    }

    // 키 (숫자 인식 실패 시 한글 숫자로도 재시도, 100~250 범위로 오탐 방지)
    if (/키/.test(text)) {
      const height = extractNumberAfter(text, /키\s*(?:는|를|가)?\s*([가-힣\d]*)/);
      if (height && height >= 100 && height <= 250) {
        el("height").value = height;
        savePersonalization();
        finishTurn(`키를 ${height}센티미터로 설정했어요.`);
        return true;
      }
    }

    // 가슴둘레
    if (/가슴/.test(text)) {
      const chest = extractNumberAfter(text, /가슴\s*(?:둘레)?\s*(?:는|를|가)?\s*([가-힣\d]*)/);
      if (chest && chest >= 50 && chest <= 200) {
        el("chest").value = chest;
        savePersonalization();
        finishTurn(`가슴둘레를 ${chest}센티미터로 설정했어요.`);
        return true;
      }
    }

    // 선호 색상
    const colorMatch = text.match(/(?:취향|선호)\s*색상[은는을를]?\s*(.+?)\s*(?:으로|로)?\s*(?:설정|해줘|바꿔|추가)/);
    if (colorMatch) {
      const val = colorMatch[1].replace(/(이랑|랑|하고|그리고)/g, ",").trim();
      el("tasteColors").value = val;
      savePersonalization();
      finishTurn(`선호 색상을 ${val}로 설정했어요.`);
      return true;
    }

    // 선호 스타일
    const styleMatch = text.match(/(?:취향|선호)\s*스타일[은는을를]?\s*(.+?)\s*(?:으로|로)?\s*(?:설정|해줘|바꿔|추가)/);
    if (styleMatch) {
      const val = styleMatch[1].replace(/(이랑|랑|하고|그리고)/g, ",").trim();
      el("tasteStyles").value = val;
      savePersonalization();
      finishTurn(`선호 스타일을 ${val}로 설정했어요.`);
      return true;
    }

    return false;
  }

  function finishTurnNoRelisten(msg) {
    state.isProcessing = false;
    speak(msg); // alwaysListen이 꺼졌으니 onend에서 재청취를 걸지 않는다
  }

  // ---------------- 명령 분류 (AI 기반, /api/command) → 액션 디스패치 ----------------
  async function handleUtterance(rawText) {
    const text = rawText.trim();
    if (!text) return;

    // 설정 관련 발화는 서버를 거치지 않고 즉시 처리
    if (tryHandleVoiceSettings(text)) return;

    state.isProcessing = true;
    el("statusBar").textContent = "명령을 해석하고 있어요...";

    let cmd;
    try {
      const r = await fetchWithTimeout("/api/command", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript: text, mode: state.mode, resultsCount: state.lastResults.length })
      });
      cmd = await r.json();
    } catch (e) {
      cmd = { action: "search", rawQuery: text };
    }
    el("statusSub").textContent = cmd.fallback ? "규칙 기반 명령 분류 (Groq 미설정)" : "AI 명령 분류";

    switch (cmd.action) {
      case "stop":
        window.speechSynthesis.cancel(); state.isSpeaking = false; micBtn.classList.remove("speaking");
        state.isProcessing = false; scheduleRelisten(200); return;

      case "help":
        finishTurn("옷의 특징을 말하면 검색됩니다. 결과가 나오면 번호와 함께 자세히 들려줘 라고 말하면 설명을 들을 수 있고, 더 찾아줘 라고 하면 상품을 더 찾아드려요. 몇번과 비슷한 상품 찾아줘 라고도 말할 수 있어요. 다시 듣기, 목록으로, 다시 검색, 정지, 처음으로 도 가능합니다.");
        return;

      case "reset":
        resetToIdle(); finishTurn("처음으로 돌아왔어요. 원하는 옷을 말씀해주세요."); return;

      case "search":
        await runSearchFlow(cmd.rawQuery || text, { reset: true }); return;

      case "new_search":
        resetToIdle(); finishTurn("새로 검색할 준비가 됐어요. 원하는 옷을 말씀해주세요."); return;

      case "more_results":
        await fetchMoreResults(); return;

      case "select_item": {
        const num = cmd.itemNumber || (state.mode === "detail" && state.currentProduct
          ? state.lastResults.findIndex((p) => p.id === state.currentProduct.id) + 1
          : null);
        const idx = (num || 0) - 1;
        if (state.lastResults[idx]) { await openDetail(state.lastResults[idx], idx + 1); }
        else if (!num) finishTurn("몇 번 상품인지 번호로 말씀해주세요.");
        else finishTurn(`${speakOrdinal(num)} 상품을 찾을 수 없어요. 목록에는 ${state.lastResults.length}개의 상품이 있어요.`);
        return;
      }

      case "similar_item": {
        const num = cmd.itemNumber || (state.mode === "detail" && state.currentProduct
          ? state.lastResults.findIndex((p) => p.id === state.currentProduct.id) + 1
          : null);
        const idx = (num || 0) - 1;
        if (state.lastResults[idx]) { await runSimilarSearch(state.lastResults[idx], num); }
        else if (!num) finishTurn("몇 번 상품과 비슷한 상품을 찾을지 번호로 말씀해주세요.");
        else finishTurn(`${speakOrdinal(num)} 상품을 찾을 수 없어서 비슷한 상품을 찾지 못했어요.`);
        return;
      }

      case "repeat":
        finishTurn(state.lastSpokenText || "다시 들려드릴 내용이 없어요."); return;

      case "back_to_list":
        showResultsList(); finishTurn(buildResultsSummary()); return;

      case "sort_price":
        handleSortPrice(cmd.priceRank || 1, cmd.priceDirection || "asc"); return;

      case "filter_price_range":
        handleFilterPriceRange(cmd.priceMin, cmd.priceMax); return;

      case "similar_with_filter": {
        const num = resolveItemNumber(cmd.itemNumber);
        const idx = (num || 0) - 1;
        if (state.lastResults[idx]) { await runSimilarSearch(state.lastResults[idx], num, cmd.filterHint); }
        else finishTurn("몇 번 상품과 비슷한 상품을 찾을지 번호로 말씀해주세요.");
        return;
      }

      case "describe_style": {
        const num = resolveItemNumber(cmd.itemNumber);
        const idx = (num || 0) - 1;
        if (state.lastResults[idx]) { await describeStyle(state.lastResults[idx]); }
        else finishTurn("몇 번 상품의 스타일을 설명해드릴지 번호로 말씀해주세요.");
        return;
      }

      case "taste_match": {
        const num = resolveItemNumber(cmd.itemNumber);
        const idx = (num || 0) - 1;
        if (state.lastResults[idx]) { await tasteMatch(state.lastResults[idx]); }
        else finishTurn("몇 번 상품이 취향에 맞는지 알려드릴지 번호로 말씀해주세요.");
        return;
      }

      case "body_fit_query": {
        const num = resolveItemNumber(cmd.itemNumber);
        const idx = (num || 0) - 1;
        if (state.lastResults[idx]) { await bodyFitQuery(state.lastResults[idx], cmd.rawQuery || text); }
        else finishTurn("몇 번 상품인지 번호로 말씀해주세요.");
        return;
      }

      case "confirm_yes":
        await handleConfirm(true); return;

      case "confirm_no":
        await handleConfirm(false); return;

      case "go_offline":
        await handleGoOffline(); return;

      case "go_purchase": {
        const num = resolveItemNumber(cmd.itemNumber);
        const idx = (num || 0) - 1;
        const product = state.lastResults[idx] || state.currentProduct;
        if (product) { await handleGoPurchase(product); }
        else finishTurn("먼저 구매하실 상품을 선택해주세요.");
        return;
      }

      case "unsupported":
      default:
        finishTurn("지원하는 기능이 아닙니다."); return;
    }
  }

  /** 번호가 없으면 현재 상세 화면에 열린 상품 번호로 대체 */
  function resolveItemNumber(itemNumber) {
    if (itemNumber) return itemNumber;
    if (state.mode === "detail" && state.currentProduct) {
      return state.lastResults.findIndex((p) => p.id === state.currentProduct.id) + 1;
    }
    return null;
  }

  function getTasteProfile() {
    const colors = el("tasteColors").value.split(",").map((s) => s.trim()).filter(Boolean);
    const styles = el("tasteStyles").value.split(",").map((s) => s.trim()).filter(Boolean);
    return { colors, styles };
  }
  function getBodyProfile() {
    const height = parseFloat(el("height").value);
    const chest = parseFloat(el("chest").value);
    return (height || chest) ? { heightCm: height || null, chestCm: chest || null } : null;
  }

  // ---------------- 가격 정렬/필터 (클라이언트에서 기존 결과를 그대로 계산) ----------------
  function handleSortPrice(rank, direction) {
    if (!state.lastResults.length) { finishTurn("아직 검색된 상품이 없어요."); return; }
    const sorted = [...state.lastResults].sort((a, b) => (direction === "asc" ? a.price - b.price : b.price - a.price));
    const target = sorted[Math.min(rank, sorted.length) - 1];
    const ord = state.lastResults.findIndex((p) => p.id === target.id) + 1;
    const rankWord = direction === "asc" ? "싼" : "비싼";
    finishTurn(`${rank === 1 ? "가장" : `${speakOrdinal(rank)}로`} ${rankWord} 상품은 ${speakOrdinal(ord)}, ${target.name}, ${speakPrice(target.price)}예요.`);
  }

  function handleFilterPriceRange(min, max) {
    if (!state.lastResults.length) { finishTurn("아직 검색된 상품이 없어요."); return; }
    const matched = state.lastResults
      .map((p, i) => ({ p, ord: i + 1 }))
      .filter(({ p }) => (min == null || p.price >= min) && (max == null || p.price <= max));
    if (!matched.length) { finishTurn("그 가격대에 맞는 상품은 없어요."); return; }
    const list = matched.map(({ p, ord }) => `${speakOrdinal(ord)} ${p.name} ${speakPrice(p.price)}`).join(", ");
    finishTurn(`그 가격대에 맞는 상품은 ${matched.length}개예요. ${list}.`);
  }

  // ---------------- 스타일 설명 / 취향 매칭 / 체형 비교 ----------------
  async function describeStyle(product) {
    let description, fallback = false;
    try {
      const r = await fetchWithTimeout("/api/describe-style", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product })
      });
      const data = await r.json();
      description = data.description; fallback = data.fallback;
    } catch (e) {
      description = `${product.name}에 대한 스타일 설명을 가져오지 못했어요.`;
      fallback = true;
    }
    el("statusSub").textContent = fallback ? "규칙 기반 스타일 설명" : "Groq가 생성한 스타일 설명";
    finishTurn(description);
  }

  async function tasteMatch(product) {
    const tastePreferences = getTasteProfile();
    let answer;
    try {
      const r = await fetchWithTimeout("/api/taste-match", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, tastePreferences })
      });
      const data = await r.json();
      answer = data.answer;
    } catch (e) {
      answer = "취향 매칭 결과를 가져오지 못했어요.";
    }
    finishTurn(answer);
  }

  async function bodyFitQuery(product, question) {
    const bodyProfile = getBodyProfile();
    let text;
    try {
      const r = await fetchWithTimeout("/api/body-fit", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, bodyProfile, question })
      });
      const data = await r.json();
      text = data.text;
    } catch (e) {
      text = "체형 비교 결과를 가져오지 못했어요.";
    }
    finishTurn(text);
  }

  // ---------------- AI 제안에 대한 응답 (confirm_yes/confirm_no) ----------------
  async function handleConfirm(isYes) {
    if (!state.pendingSuggestion) { finishTurn(isYes ? "알겠습니다." : "네, 알겠습니다."); return; }
    const { action, itemNumber } = state.pendingSuggestion;
    state.pendingSuggestion = null;
    if (!isYes) { finishTurn("네, 알겠습니다."); return; }
    if (action === "similar_item") {
      const idx = (itemNumber || 0) - 1;
      if (state.lastResults[idx]) { await runSimilarSearch(state.lastResults[idx], itemNumber); return; }
    }
    finishTurn("알겠습니다.");
  }

  // ---------------- 구매 연결 (장바구니/결제 기능이 없으므로 실제 판매 페이지로 바로 연결) ----------------
  async function handleGoPurchase(product) {
    const safeLink = safeUrl(product.link);
    if (!safeLink) {
      finishTurn("이 상품은 연결할 수 있는 구매 페이지 링크가 없어요.");
      return;
    }
    speak(`${product.name} 상품의 구매 페이지를 새 탭으로 열어드릴게요.`, {
      onend: () => { window.open(safeLink, "_blank", "noopener,noreferrer"); scheduleRelisten(300); }
    });
  }

  // ---------------- 온라인 → 오프라인 전환 ----------------
  async function handleGoOffline() {
    const product = state.currentProduct || state.lastResults[0];
    if (!product) { finishTurn("먼저 상품을 검색하거나 선택해주세요."); return; }
    const brandQuery = product.brand || product.category || product.name;
    let locations = [];
    try {
      const r = await fetchWithTimeout(`/api/offline/brand-locations?brand=${encodeURIComponent(brandQuery)}`);
      const data = await r.json();
      locations = data.locations || [];
    } catch (e) {
      /* 조회 실패 시 그냥 오프라인 화면으로 이동 */
    }
    sessionStorage.setItem("earshopping_handoff_brand", brandQuery);
    if (!locations.length) {
      speak(`오프라인 매장 화면으로 이동해서 "${brandQuery}"을(를) 찾아볼게요.`, {
        onend: () => { window.location.href = "/offline.html"; }
      });
      return;
    }
    const top = locations[0];
    speak(
      `${top.storeName}의 ${top.floor}층 ${top.section}에 ${top.name} 매장이 있어요. 오프라인 매장 화면으로 이동할게요.`,
      { onend: () => { window.location.href = "/offline.html"; } }
    );
  }

  function finishTurn(msg) { state.isProcessing = false; speak(msg, { onend: () => scheduleRelisten(200) }); }

  function resetToIdle() {
    state.mode = "idle"; state.lastResults = []; state.currentProduct = null;
    state.lastIntentQuery = null; state.nextOffset = 0; state.hasMore = false; state.lowestPrice = null;
    el("results").innerHTML = '<p class="hint">마이크에 대고 원하는 옷을 말해보세요.</p>';
    el("resultCount").textContent = ""; el("detail").classList.remove("show");
  }
  function showResultsList() { state.mode = "results"; el("detail").classList.remove("show"); }

  function buildResultsSummary() {
    if (!state.lastResults.length) return "아직 검색된 상품이 없어요.";
    const list = state.lastResults.map((p, i) => `${speakOrdinal(i + 1)}, ${p.name}, ${speakPrice(p.price)}`).join(". ");
    let msg = `현재 ${state.lastResults.length}개의 상품이 있어요. ${list}.`;
    if (state.lowestPrice) {
      const p = state.lastResults.find((x) => x.id === state.lowestPrice.productId);
      if (p) msg += ` 배송비까지 포함하면 ${p.name}이 ${speakPrice(state.lowestPrice.totalWithShipping)}로 가장 저렴해요.`;
    }
    msg += state.hasMore ? " 더 찾아줘 라고 말하면 상품을 더 찾아드려요." : " 더 이상 검색되는 상품은 없어요.";
    msg += " 번호와 함께 자세히 들려줘, 또는 몇번과 비슷한 상품 찾아줘 라고 말해보세요.";
    return msg;
  }

  // ---------------- 기능 1: 검색 파이프라인 (기본 최대 5개) ----------------
  async function runSearchFlow(transcript, { reset = true } = {}) {
    el("statusBar").textContent = "검색조건을 이해하고(한국어→영어) 실제 상품을 가져오고 있어요...";
    const height = parseFloat(el("height").value);
    const chest = parseFloat(el("chest").value);
    const bodyProfile = (height || chest) ? { heightCm: height || null, chestCm: chest || null } : null;

    let data;
    try {
      const r = await fetchWithTimeout("/api/search-products", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcript, bodyProfile, limit: 5, offset: 0 })
      });
      data = await r.json();
      if (!r.ok) throw new Error(data.error || "요청 실패");
    } catch (e) {
      finishTurn("검색 중 오류가 발생했어요. 다시 말씀해주세요.");
      return;
    }

    el("rawOutput").textContent = JSON.stringify(data, null, 2);
    if (reset) state.lastResults = [];
    state.lastResults = state.lastResults.concat(data.products || []);
    state.lastIntentQuery = data.intent?.query || transcript;
    state.nextOffset = data.offset + (data.products?.length || 0);
    state.hasMore = !!data.hasMore;
    state.lowestPrice = data.lowestPrice || state.lowestPrice;
    state.fitNotes = { ...state.fitNotes, ...(data.fitNotes || {}) };
    state.mode = "results";
    renderResults();

    el("statusSub").textContent = data.fallback
      ? `데모 데이터로 표시 중 (${data.fallbackReason || ""}) — eBay 검색어(영어): "${state.lastIntentQuery}"`
      : `실제 eBay 검색 결과 — eBay 검색어(영어): "${state.lastIntentQuery}"`;
    loadStatus();
    finishTurn(buildResultsSummary());
  }

  async function fetchMoreResults() {
    if (!state.lastIntentQuery) { finishTurn("먼저 검색을 해주세요."); return; }
    if (!state.hasMore) { finishTurn("더 이상 검색되는 상품이 없어요."); return; }

    el("statusBar").textContent = "상품을 더 찾고 있어요...";
    const height = parseFloat(el("height").value);
    const chest = parseFloat(el("chest").value);
    const bodyProfile = (height || chest) ? { heightCm: height || null, chestCm: chest || null } : null;

    let data;
    try {
      const r = await fetchWithTimeout("/api/search-products", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: state.lastIntentQuery, limit: 5, offset: state.nextOffset, bodyProfile })
      });
      data = await r.json();
      if (!r.ok) throw new Error(data.error || "요청 실패");
    } catch (e) {
      finishTurn("추가 검색 중 오류가 발생했어요."); return;
    }

    el("rawOutput").textContent = JSON.stringify(data, null, 2);
    const newOnes = data.products || [];
    state.lastResults = state.lastResults.concat(newOnes);
    state.nextOffset = data.offset + newOnes.length;
    state.hasMore = !!data.hasMore;
    if (data.lowestPrice && (!state.lowestPrice || data.lowestPrice.totalWithShipping < state.lowestPrice.totalWithShipping)) {
      state.lowestPrice = data.lowestPrice;
    }
    state.fitNotes = { ...state.fitNotes, ...(data.fitNotes || {}) };
    renderResults();
    finishTurn(`${newOnes.length}개를 더 찾았어요. ` + buildResultsSummary());
  }

  async function runSimilarSearch(product, ord, filterHint) {
    const attrs = [product.brand, product.color, product.material, product.style, product.category || product.name]
      .filter(Boolean).join(" ");
    const pseudoTranscript = filterHint
      ? `${attrs} 와 비슷한데 ${filterHint} 스타일의 옷 찾아줘`
      : `${attrs} 와 비슷한 스타일의 옷 찾아줘`;
    speak(`${speakOrdinal(ord)} 상품과 비슷한 상품을 찾아볼게요.`);
    await runSearchFlow(pseudoTranscript, { reset: true });
  }

  function renderResults() {
    const products = state.lastResults;
    const wrap = el("results");
    wrap.innerHTML = "";
    el("resultCount").textContent = `${products.length}건 ${state.hasMore ? "(더 찾아줘로 추가 가능)" : "(전체)"}`;
    if (!products.length) { wrap.innerHTML = '<p class="hint">일치하는 상품을 찾지 못했어요.</p>'; return; }
    products.forEach((p, i) => {
      const div = document.createElement("div");
      div.className = "card"; div.id = `card-${i + 1}`;
      const isLowest = state.lowestPrice && state.lowestPrice.productId === p.id;
      const safeLink = safeUrl(p.link);
      div.innerHTML = `
        <div class="title">${i + 1}번 · ${escapeHtml(p.name)} ${isLowest ? "💰최저가" : ""}</div>
        <div class="meta">
          <span class="price">${escapeHtml(p.price)}달러</span>
          ${p.brand ? ` · 브랜드: ${escapeHtml(p.brand)}` : ""}${p.color ? ` · 색상: ${escapeHtml(p.color)}` : ""}${p.material ? ` · 소재: ${escapeHtml(p.material)}` : ""}
          ${p.store ? ` · 판매자: ${escapeHtml(p.store)}` : ""}
          ${p.sellerFeedbackPercentage != null ? ` · 판매자 평점: ${p.sellerFeedbackPercentage}%` : ""}
        </div>
        ${safeLink ? `<a href="${safeLink}" target="_blank" rel="noopener noreferrer">eBay에서 보기 ↗</a>` : ""}
        <div class="row">
          <button data-act="detail">🔊 자세히 듣기</button>
          <button data-act="similar" class="secondary">비슷한 상품 찾기</button>
        </div>
      `;
      div.querySelector('[data-act="detail"]').addEventListener("click", () => openDetail(p, i + 1));
      div.querySelector('[data-act="similar"]').addEventListener("click", () => runSimilarSearch(p, i + 1));
      wrap.appendChild(div);
    });
  }

  // ---------------- 기능 2 (핵심): 실제 데이터 기반 음성 안내 (한국어) ----------------
  async function openDetail(product, ord) {
    state.mode = "detail"; state.currentProduct = product; state.isProcessing = true;
    document.querySelectorAll(".card").forEach((c) => c.classList.remove("active"));
    const card = el(`card-${ord}`); if (card) card.classList.add("active");

    const detail = el("detail");
    detail.classList.add("show");
    const safeLink = safeUrl(product.link);
    el("detailTitle").innerHTML = `${ord}번 · ${escapeHtml(product.name)}` +
      (safeLink ? `<br><a href="${safeLink}" target="_blank" rel="noopener noreferrer" style="font-size:12px;">eBay에서 보기 ↗</a>` : "");
    el("detailBody").textContent = "실제 상품 데이터를 바탕으로 설명을 만들고 있어요...";
    detail.scrollIntoView({ behavior: "smooth", block: "center" });

    let description, fallback = false, suggestion = null;
    try {
      const r = await fetchWithTimeout("/api/describe-product", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product, fitNote: state.fitNotes[product.id] || null })
      });
      const data = await r.json();
      description = data.description; fallback = data.fallback; suggestion = data.suggestion || null;
    } catch (e) {
      description = `${product.name}. 가격은 ${speakPrice(product.price)}입니다.`;
      fallback = true;
    }

    el("detailBody").textContent = description;
    el("statusSub").textContent = fallback ? "실제 상품 데이터 기반(규칙 생성) 설명" : "Groq가 실제 데이터로 생성한 한국어 설명";

    if (suggestion) {
      state.pendingSuggestion = { action: suggestion.action, itemNumber: ord };
      finishTurn(`${description} ${suggestion.text}`);
    } else {
      state.pendingSuggestion = null;
      finishTurn(description);
    }
  }

  el("replayBtn").addEventListener("click", () => speak(state.lastSpokenText));
  el("closeBtn").addEventListener("click", () => { el("detail").classList.remove("show"); window.speechSynthesis.cancel(); showResultsList(); });

  // ---------------- 개인화: 키/가슴둘레/취향을 localStorage에 저장해 다음 방문에도 기억 ----------------
  const PROFILE_KEY = "earshopping_profile_v1";
  function savePersonalization() {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({
        height: el("height").value, chest: el("chest").value,
        tasteColors: el("tasteColors").value, tasteStyles: el("tasteStyles").value
      }));
    } catch (e) { /* localStorage 접근 불가 환경(사생활 보호 모드 등)에서는 조용히 무시 */ }
  }
  function loadPersonalization() {
    try {
      const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || "null");
      if (!saved) return false;
      if (saved.height) el("height").value = saved.height;
      if (saved.chest) el("chest").value = saved.chest;
      if (saved.tasteColors) el("tasteColors").value = saved.tasteColors;
      if (saved.tasteStyles) el("tasteStyles").value = saved.tasteStyles;
      return true;
    } catch (e) { return false; }
  }
  ["height", "chest", "tasteColors", "tasteStyles"].forEach((id) => {
    el(id).addEventListener("change", savePersonalization);
  });
  // 음성으로 설정을 바꿀 때도 저장되도록, tryHandleVoiceSettings의 각 성공 분기 안에서 직접 호출한다 (savePersonalization은 아래에서 정의됨, 호이스팅으로 참조 가능).

  // ---------------- 오프라인 → 온라인 연계: 오프라인에서 넘어온 검색어가 있으면 자동 실행 ----------------
  const incomingQuery = sessionStorage.getItem("earshopping_handoff_online_query");
  sessionStorage.removeItem("earshopping_handoff_online_query");

  // ---------------- 초기화 ----------------
  const restoredProfile = loadPersonalization();
  loadStatus();
  if (incomingQuery) {
    el("statusBar").textContent = "오프라인에서 넘어온 정보로 검색하고 있어요...";
    speak(`오프라인 매장에서 확인하신 상품과 비슷한 걸 온라인에서 찾아볼게요.`, {
      onend: () => runSearchFlow(incomingQuery, { reset: true })
    });
  } else {
    el("statusBar").textContent = "준비됐어요. 원하는 옷을 말씀해주세요.";
    const welcome = restoredProfile
      ? "이어쇼핑에 오신 걸 환영해요. 지난번에 알려주신 키와 취향 정보를 기억하고 있어요. 원하는 옷을 말씀해주세요."
      : "이어쇼핑에 오신 걸 환영해요. 원하는 옷을 말씀해주시면 실제 상품을 검색해 드릴게요.";
    speak(welcome, { onend: () => scheduleRelisten(300) });
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
})();
