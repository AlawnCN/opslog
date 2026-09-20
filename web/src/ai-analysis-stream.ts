import type { AiAnalyzeResult } from "./api";

type AiStreamEvent =
  | { type: "chunk"; content: string }
  | { type: "done"; result: AiAnalyzeResult }
  | { type: "error"; error: string };

const eventFromLine = (line: string): AiStreamEvent | undefined => {
  if (!line.trim()) return undefined;
  return JSON.parse(line) as AiStreamEvent;
};

export const readAiAnalysisStream = async (response: Response, onChunk?: (content: string) => void): Promise<AiAnalyzeResult> => {
  if (!response.body) throw new Error("AI 分析响应无法读取");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AiAnalyzeResult | undefined;
  const consume = (line: string): void => {
    const event = eventFromLine(line);
    if (!event) return;
    if (event.type === "chunk") onChunk?.(event.content);
    else if (event.type === "done") result = event.result;
    else throw new Error(event.error || "AI 分析失败");
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? "" : lines.pop() ?? "";
    for (const line of lines) consume(line);
    if (done) { if (buffer.trim()) consume(buffer); break; }
  }
  if (!result) throw new Error("AI 分析流在完成前已断开");
  return result;
};
