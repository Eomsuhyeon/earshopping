const config = require("../config");
const { withRetry, fetchWithTimeout, ExternalApiError, isRetryableStatus } = require("../utils/retry");

let tokenCache = { token: null, expiresAt: 0 };

async function getEbayToken() {
  if (!config.ebay.connected) throw new ExternalApiError("EBAY_KEYS_MISSING", "NO_KEY");

  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt > now + 30_000) return tokenCache.token;

  return withRetry(async () => {
    const creds = Buffer.from(`${config.ebay.clientId}:${config.ebay.clientSecret}`).toString("base64");
    const res = await fetchWithTimeout(`https://${config.ebay.host}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${creds}` },
      body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope"
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ExternalApiError(`EBAY_TOKEN_HTTP_${res.status}: ${text}`, "HTTP_ERROR", { retryable: isRetryableStatus(res.status) });
    }
    const data = await res.json();
    tokenCache = { token: data.access_token, expiresAt: now + (data.expires_in ? data.expires_in * 1000 : 300000) };
    return tokenCache.token;
  });
}

/** eBay 원본 아이템 조회. 가격/배송비는 숫자로 분리 보관, offset으로 페이지네이션 지원. */
async function searchEbayRaw(query, limit = 5, offset = 0) {
  const token = await getEbayToken();
  return withRetry(async () => {
    const url = `https://${config.ebay.host}/buy/browse/v1/item_summary/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" }
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ExternalApiError(`EBAY_SEARCH_HTTP_${res.status}: ${text}`, "HTTP_ERROR", { retryable: isRetryableStatus(res.status) });
    }
    const data = await res.json();
    const items = (data.itemSummaries || []).map((item) => ({
      id: item.itemId,
      title: item.title,
      priceValue: item.price ? Number(item.price.value) : null,
      image: item.image ? item.image.imageUrl : null,
      link: item.itemWebUrl || null,
      condition: item.condition || null,
      store: item.seller?.username || null,
      sellerFeedbackPercentage: item.seller?.feedbackPercentage != null ? Number(item.seller.feedbackPercentage) : null,
      sellerFeedbackScore: item.seller?.feedbackScore != null ? Number(item.seller.feedbackScore) : null,
      categoryPath: item.categories?.[0]?.categoryName || null,
      shippingCost: item.shippingOptions?.[0]?.shippingCost ? Number(item.shippingOptions[0].shippingCost.value) : 0
    }));
    const total = typeof data.total === "number" ? data.total : offset + items.length;
    return { items, hasMore: offset + items.length < total, total };
  });
}

module.exports = { searchEbayRaw };
