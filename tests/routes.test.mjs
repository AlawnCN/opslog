import assert from "node:assert/strict";
import test from "node:test";
import { transactionLogFilename } from "../dist-server/server/routes.js";

test("交易日志下载使用日志 ID 作为文件名", () => {
  assert.equal(
    transactionLogFilename("channelPostingapc.p_0_1409041319570000055502-8110-8347-8116"),
    "channelPostingapc.p_0_1409041319570000055502-8110-8347-8116.trc"
  );
  assert.equal(transactionLogFilename("../unsafe/log"), "_unsafe_log.trc");
});
