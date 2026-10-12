import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { appendSnapshotOutputs, snapshotHasPage, snapshotSession, sshServerKey } from "../server/ssh-query-sessions.js";
import type { EnvironmentConfig, SearchInput } from "../server/domain.js";
import { defaultSshLogSources } from "../shared/ssh-log-defaults.js";
import { createSshQuerySessionId } from "../web/src/opslog-session-cache.js";

const environment: EnvironmentConfig = { name: "cursor-fixture", sourceType: "ssh", kibanaUrl: "", username: "", password: "", txnlstIndex: "", txntrcIndex: "", applogIndex: "", sshServers: [{ name: "first", host: "fixture-1", authentication: "ssh-config" }, { name: "second", host: "fixture-2", authentication: "ssh-config" }], sshMonitoredApplications: [{ name: "cte", directory: "/fixture/cte", logSources: defaultSshLogSources() }] };
const query = (): SearchInput => ({ environment: environment.name, application: "cte", kind: "transaction", startTime: "2026-10-12T00:00:00.000Z", endTime: "2026-10-13T00:00:00.000Z", page: 1, pageSize: 50, sessionId: randomUUID() });
test("browser session IDs are UUID v4 and do not require secure-context randomUUID", () => {
  const ids = Array.from({ length: 100 }, createSshQuerySessionId);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});
test("session binds query and configuration, preserves each server buffer and rejects skipped pages", () => {
  const input = query(); const session = snapshotSession(environment, input)!;
  assert.equal(session.page, 0);
  const outputs = environment.sshServers!.map((server, i) => ({ server, raw: `@OPSLOG_ROW\t{"values":{"logId":"${i}"}}\n@OPSLOG_CURSOR\t{"files":{"position":${i + 1}}}\n` }));
  appendSnapshotOutputs(session, outputs, 1, 0);
  assert.equal(session.outputs.size, 2);
  assert.equal(Object.keys(session.cursors).length, 2);
  assert.notEqual(sshServerKey(outputs[0]!.server), sshServerKey(outputs[1]!.server));
  assert.equal(snapshotSession(environment, { ...input, page: 2 }), session);
  assert.throws(() => snapshotSession(environment, { ...input, page: 3 }), /顺序翻页/);
  assert.throws(() => snapshotSession(environment, { ...input, keyword: "changed" }), /条件或配置/);
  assert.throws(() => snapshotSession({ ...environment, timeZone: "UTC" }, input), /条件或配置/);
  appendSnapshotOutputs(session, outputs, 2, 1);
  assert.equal(session.outputs.get(sshServerKey(outputs[0]!.server))!.raw.split("@OPSLOG_ROW").length - 1, 2);
  assert.throws(() => appendSnapshotOutputs(session, outputs, 2, 1), /已有翻页请求完成/);
  assert.equal(snapshotSession(environment, query())!.page, 0, "refresh creates a distinct session");
});
test("missing and expired sessions never restart silently on a later page", () => {
  assert.throws(() => snapshotSession(environment, { ...query(), page: 2 }), /已过期/);
  const input = query(); const session = snapshotSession(environment, input)!;
  session.touched -= 16 * 60_000;
  assert.throws(() => snapshotSession(environment, { ...input, page: 2 }), /已过期/);
});
test("failed result validation does not advance the snapshot", () => {
  const session = snapshotSession(environment, query())!;
  assert.throws(() => appendSnapshotOutputs(session, [{ server: environment.sshServers![0]!, raw: "missing cursor" }], 1, 0), /续读位置/);
  assert.equal(session.page, 0); assert.equal(session.outputs.size, 0);
});
test("buffer is reusable only when every live file covers the requested prefix", () => {
  const input = query(); const session = snapshotSession(environment, input)!;
  session.page = 1;
  session.cursors = { first: { files: { a: { position: 100, matched: 115 } } }, second: { files: { b: { position: 100, matched: 115 } } } };
  assert.equal(snapshotHasPage(session, { ...input, page: 2 }), true);
  assert.equal(snapshotHasPage(session, { ...input, page: 3 }), false);
  session.cursors.second = { files: { b: { position: 0, matched: 1 } } };
  assert.equal(snapshotHasPage(session, { ...input, page: 2 }), true);
});
