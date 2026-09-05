import type { SearchRequest, SearchResponse } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_SEARCH_RESULTS = 8;
const MAX_TRANSACTION_LOGS = 4;
const MAX_TRACES = 8;
const MAX_LOG_CHARACTERS = 16 * 1024 * 1024;

interface CacheEntry<Value> {
  value: Value;
  savedAt: number;
}

const fresh = <Value>(entry: CacheEntry<Value> | undefined): entry is CacheEntry<Value> =>
  Boolean(entry && Date.now() - entry.savedAt < CACHE_TTL_MS);

const take = <Value>(cache: Map<string, CacheEntry<Value>>, key: string): Value | undefined => {
  const entry = cache.get(key);
  if (!fresh(entry)) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
};

const store = <Value>(cache: Map<string, CacheEntry<Value>>, key: string, value: Value, maximum: number) => {
  cache.delete(key);
  cache.set(key, { value, savedAt: Date.now() });
  while (cache.size > maximum) cache.delete(cache.keys().next().value as string);
};

export const searchCacheKey = (request: SearchRequest): string => JSON.stringify(request);

export const transactionLogCacheKey = (
  environment: string,
  id: string,
  startTime: string,
  endTime: string
): string => JSON.stringify([environment, id, startTime, endTime]);

export const traceCacheKey = (
  environment: string,
  id: string,
  startTime: string,
  endTime: string
): string => JSON.stringify([environment, id, startTime, endTime]);

interface CachedLoad<Value> {
  value: Value;
  cached: boolean;
}

export class OpsLogSessionCache {
  private readonly searchResults = new Map<string, CacheEntry<SearchResponse>>();
  private readonly transactionLogs = new Map<string, CacheEntry<string>>();
  private readonly transactionLogLoads = new Map<string, Promise<string>>();
  private readonly traces = new Map<string, CacheEntry<Record<string, unknown>[]>>();

  getSearch(key: string): SearchResponse | undefined {
    return take(this.searchResults, key);
  }

  saveSearch(key: string, result: SearchResponse): void {
    store(this.searchResults, key, result, MAX_SEARCH_RESULTS);
  }

  clearSearch(): void {
    this.searchResults.clear();
  }

  getTransactionLog(key: string): string | undefined {
    return take(this.transactionLogs, key);
  }

  saveTransactionLog(key: string, content: string): void {
    if (content.length > MAX_LOG_CHARACTERS) return;
    store(this.transactionLogs, key, content, MAX_TRANSACTION_LOGS);
  }

  async loadTransactionLog(key: string, loader: () => Promise<string>): Promise<CachedLoad<string>> {
    const cached = this.getTransactionLog(key);
    if (cached !== undefined) return { value: cached, cached: true };
    const existing = this.transactionLogLoads.get(key);
    if (existing) return { value: await existing, cached: false };

    const pending = loader().then((content) => {
      this.saveTransactionLog(key, content);
      return content;
    });
    this.transactionLogLoads.set(key, pending);
    try {
      return { value: await pending, cached: false };
    } finally {
      this.transactionLogLoads.delete(key);
    }
  }

  getTrace(key: string): Record<string, unknown>[] | undefined {
    return take(this.traces, key);
  }

  saveTrace(key: string, rows: Record<string, unknown>[]): void {
    store(this.traces, key, rows, MAX_TRACES);
  }
}
