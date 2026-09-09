import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LOG_READER_PREFERENCES,
  readLogReaderPreferences,
  storeLogReaderPreferences
} from "../web/src/log-reader-preferences";

const createStorage = (initialValue: string | null = null) => {
  let value = initialValue;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    value: () => value
  };
};

test("log reader preferences restore wrap and fold choices", () => {
  const storage = createStorage();
  storeLogReaderPreferences({ wrapLines: true, outlineWrapLines: true, regexSearch: true, foldMode: "folded" }, storage);

  assert.deepEqual(readLogReaderPreferences(storage), { wrapLines: true, outlineWrapLines: true, regexSearch: true, foldMode: "folded" });
});

test("invalid log reader preferences safely use defaults", () => {
  assert.deepEqual(readLogReaderPreferences(createStorage("not-json")), DEFAULT_LOG_READER_PREFERENCES);
  assert.deepEqual(readLogReaderPreferences(createStorage('{"wrapLines":"yes","foldMode":"unknown"}')), DEFAULT_LOG_READER_PREFERENCES);
});
