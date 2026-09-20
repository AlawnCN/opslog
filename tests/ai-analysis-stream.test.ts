import assert from "node:assert/strict";
import test from "node:test";
import { readAiAnalysisStream } from "../web/src/ai-analysis-stream";

const encoder = new TextEncoder();

test("reads AI analysis chunks across arbitrary network boundaries", async () => {
  const pieces = [
    '{"type":"chunk","content":"# 结',
    '论"}\n{"type":"chunk","content":"\\n正常"}\n',
    '{"type":"done","result":{"content":"# 结论\\n正常","provider":"local","model":"test","durationMs":12,"inputCharacters":10,"truncated":false}}\n'
  ];
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece));
      controller.close();
    }
  }), { headers: { "Content-Type": "application/x-ndjson" } });
  const chunks: string[] = [];
  const result = await readAiAnalysisStream(response, (chunk) => chunks.push(chunk));
  assert.deepEqual(chunks, ["# 结论", "\n正常"]);
  assert.equal(result.content, "# 结论\n正常");
});

test("surfaces stream errors instead of treating partial output as complete", async () => {
  const response = new Response(`${JSON.stringify({ type: "chunk", content: "partial" })}\n${JSON.stringify({ type: "error", error: "模型连接中断" })}\n`);
  await assert.rejects(() => readAiAnalysisStream(response), /模型连接中断/);
});
