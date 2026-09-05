/**
 * EarShopping — 파이프라인 데이터 스키마
 * ------------------------------------------------------------
 * 이 파일은 컴파일되어 실행되지 않습니다. 백엔드가 실제로 반환하는
 * JSON 구조를 문서화하기 위한 "계약(contract)" 파일입니다.
 */

export type Product = {
  id: string;
  name: string;
  price: number; // 통화 단위: USD (eBay EBAY_US 마켓플레이스 기준)
  image?: string | null;
  link?: string | null;
  store?: string | null;
  brand?: string | null;
  category?: string | null;
  color?: string | null;
  style?: string | null;
  modelNumber?: string | null;
  material?: string | null;
  sizeInfo?: {
    length?: number | null;
    shoulder?: number | null;
    chest?: number | null;
    sleeve?: number | null;
  } | null;
};

export type SearchIntent = {
  query: string;          // eBay 검색에 쓰인 영어 키워드
  category?: string | null;
  style?: string[];
  color?: string | null;
};

export type BodyProfile = {
  heightCm?: number | null;
  chestCm?: number | null;
};

export type LowestPrice = {
  productId: string;
  price: number;
  shipping: number;
  totalWithShipping: number;
} | null;

export type SearchProductsRequest = {
  transcript?: string;   // 한국어 자연어 발화 (새 검색)
  query?: string;        // 이미 준비된 영어 검색어 (있으면 Groq 의도 추출 생략) — 더 찾기/유사상품용
  intent?: SearchIntent;
  limit?: number;         // 기본 5, 최대 5
  offset?: number;        // 기본 0
  bodyProfile?: BodyProfile;
};

export type SearchProductsResponse = {
  intent: SearchIntent;
  products: Product[];       // 한 번에 최대 5개
  lowestPrice: LowestPrice;  // 이번 페이지 기준 최저가
  fitNotes: Record<string, string>;
  hasMore: boolean;
  total: number;
  offset: number;
  limit: number;
  fallback: boolean;
  fallbackReason?: string | null;
};

export type CommandAction =
  | "search" | "more_results" | "select_item" | "similar_item"
  | "repeat" | "back_to_list" | "new_search" | "stop" | "help" | "reset" | "unsupported";

export type CommandRequest = {
  transcript: string;
  mode: "idle" | "results" | "detail";
  resultsCount: number;
};

export type CommandResponse = {
  action: CommandAction;
  itemNumber?: number | null;
  rawQuery?: string | null;
  fallback: boolean;
};

export type DescribeProductRequest = {
  product: Product;
  fitNote?: string | null;
};

export type DescribeProductResponse = {
  description: string;
  fallback: boolean;
  reason?: string | null;
  facts: string[];
};

export type StatusResponse = {
  groqConnected: boolean;
  ebayConnected: boolean;
  ebayEnv: "production" | "sandbox";
  cacheSize: number;
  nodeEnv: string;
};
