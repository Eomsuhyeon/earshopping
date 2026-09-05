/** eBay 원본 아이템(가격+배송비 숫자)에서, 배송비 포함 총액 기준 최저가를 찾는다. */
function computeLowestPrice(rawItems) {
  if (!rawItems.length) return null;
  let best = null;
  for (const it of rawItems) {
    if (it.priceValue == null) continue;
    const total = it.priceValue + (it.shippingCost || 0);
    if (!best || total < best.totalWithShipping) {
      best = {
        productId: it.id,
        price: it.priceValue,
        shipping: it.shippingCost || 0,
        totalWithShipping: Math.round(total * 100) / 100
      };
    }
  }
  return best;
}

/** sizeInfo가 있는 상품에 한해, 신체 치수와 비교한 간단한 착용감 안내 문장을 만든다. */
function computeFitNotes(products, bodyProfile) {
  const notes = {};
  if (!bodyProfile || (!bodyProfile.heightCm && !bodyProfile.chestCm)) return notes;

  for (const p of products) {
    if (!p.sizeInfo) continue;
    const parts = [];
    if (bodyProfile.heightCm && p.sizeInfo.length) {
      const diff = p.sizeInfo.length - bodyProfile.heightCm * 0.4;
      parts.push(diff > 3 ? "기장이 다소 길 수 있어요" : diff < -3 ? "기장이 다소 짧을 수 있어요" : "기장이 잘 맞을 것 같아요");
    }
    if (bodyProfile.chestCm && p.sizeInfo.chest) {
      const diff = p.sizeInfo.chest - bodyProfile.chestCm;
      parts.push(diff < 0 ? "가슴둘레가 타이트할 수 있어요" : diff > 8 ? "품이 넉넉한 편이에요" : "가슴둘레가 잘 맞을 것 같아요");
    }
    if (parts.length) notes[p.id] = parts.join(", ") + ".";
  }
  return notes;
}

/** 받침 유무에 따라 은/는 조사를 고른다 (예: "소매" → "는", "기장" → "은") */
function eunNeun(word) {
  const last = word.charCodeAt(word.length - 1);
  if (last < 0xac00 || last > 0xd7a3) return "는";
  return (last - 0xac00) % 28 === 0 ? "는" : "은";
}

const ATTRIBUTE_KEYWORDS = [
  { key: "sleeve", label: "소매", pattern: /소매/, ratio: 0.35 },
  { key: "length", label: "기장", pattern: /기장|길이/, ratio: 0.4 },
  { key: "shoulder", label: "어깨", pattern: /어깨/, ratio: 0.23 },
  { key: "chest", label: "가슴둘레", pattern: /가슴|품/, ratio: null } // chest는 bodyProfile.chestCm과 직접 비교
];

/**
 * "소매가 길까?", "내 키에 기장이 어때?" 같은 구체적 질문에 대해, 상품의 실측 사이즈(sizeInfo)와
 * 사용자 신체 치수(bodyProfile)를 비교해 답한다. 키 대비 비율은 성인 표준 체형 기준의 대략적인
 * 추정치이며, 실제 개인차가 있으므로 참고용이라는 점을 답변에 함께 담는다.
 */
function answerBodyFitQuestion(product, bodyProfile, questionText) {
  if (!bodyProfile || (!bodyProfile.heightCm && !bodyProfile.chestCm)) {
    return { answered: false, text: "신체 치수를 먼저 알려주시면 정확하게 비교해드릴 수 있어요." };
  }
  if (!product.sizeInfo) {
    return { answered: false, text: "이 상품은 실측 사이즈 정보가 없어서 정확히 비교하기 어려워요." };
  }

  const matched = ATTRIBUTE_KEYWORDS.find((a) => a.pattern.test(questionText || ""));
  const target = matched || ATTRIBUTE_KEYWORDS.find((a) => a.key === "length"); // 질문이 애매하면 기장 기준

  if (target.key === "chest") {
    if (!bodyProfile.chestCm || product.sizeInfo.chest == null) {
      return { answered: false, text: "가슴둘레를 비교하려면 상품의 가슴둘레 실측 정보와 회원님의 가슴둘레가 모두 필요해요." };
    }
    const diff = product.sizeInfo.chest - bodyProfile.chestCm;
    const verdict = diff < -2 ? "타이트할 수 있어요" : diff > 8 ? "품이 꽤 넉넉한 편이에요" : "잘 맞을 것 같아요";
    return { answered: true, text: `상품의 가슴둘레는 ${product.sizeInfo.chest}cm이고, 회원님 가슴둘레와 비교하면 ${verdict}.` };
  }

  const sizeValue = product.sizeInfo[target.key];
  if (sizeValue == null || !bodyProfile.heightCm) {
    return { answered: false, text: `이 상품은 ${target.label} 실측 정보가 없어서 비교하기 어려워요.` };
  }
  const estimate = Math.round(bodyProfile.heightCm * target.ratio);
  const diff = sizeValue - estimate;
  const verdict = diff > 3 ? "다소 길게 느껴질 수 있어요" : diff < -3 ? "다소 짧게 느껴질 수 있어요" : "키에 잘 맞는 편이에요";
  return {
    answered: true,
    text: `상품의 ${target.label}${eunNeun(target.label)} ${sizeValue}cm예요. 회원님 키를 기준으로 보면 ${verdict} (참고용 추정치라 개인차가 있을 수 있어요).`
  };
}

module.exports = { computeLowestPrice, computeFitNotes, answerBodyFitQuestion };
