import { nairobiLocal } from "./time";
import type { SearchFilters } from "./types";

export const PAGE_SIZE_KEY = "opslog.page-size.v1";
export const PAGE_SIZES = [50, 100, 500] as const;

export const initialPageSize = (): number => {
  const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
  return PAGE_SIZES.includes(saved as (typeof PAGE_SIZES)[number]) ? saved : 50;
};

export const initialFilters = (): SearchFilters => {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return {
    startLocal: nairobiLocal(start), endLocal: nairobiLocal(end), index: "", txnId: "", traceId: "",
    txnNo: "", business: "", service: "", messageCode: "", messageInfo: "", status: "ALL",
    minDurationMs: "", node: "", keyword: "", level: "", file: "", application: ""
  };
};
