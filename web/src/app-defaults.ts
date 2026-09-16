import { rollingNairobiRange } from "./time";
import type { SearchFilters } from "./types";

export const PAGE_SIZE_KEY = "opslog.page-size.v1";
export const PAGE_SIZES = [50, 100, 500] as const;

export const initialPageSize = (): number => {
  const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
  return PAGE_SIZES.includes(saved as (typeof PAGE_SIZES)[number]) ? saved : 50;
};

export const initialFilters = (): SearchFilters => {
  const range = rollingNairobiRange(1);
  return {
    ...range, index: "", txnId: "", traceId: "",
    txnNo: "", business: "", service: "", messageCode: "", messageInfo: "", status: "ALL",
    minDurationMs: "", node: "", keyword: "", level: "", file: "", application: ""
  };
};
