export interface TransactionLogTimeWindow {
  startTime: string;
  endTime: string;
}

const INITIAL_RADIUS_MS = 60 * 60 * 1000;
const EXPANDED_RADIUS_MS = 6 * 60 * 60 * 1000;
const DURATION_PADDING_MS = 30 * 60 * 1000;
const BOUNDARY_MARGIN_MS = 60 * 1000;

const scalar = (value: unknown): unknown => Array.isArray(value) ? value[0] : value;

const timestamp = (value: unknown): number | undefined => {
  const parsed = Date.parse(String(scalar(value) ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
};

const duration = (value: unknown): number => {
  const parsed = Number(scalar(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const windowAround = (anchor: number, radius: number): TransactionLogTimeWindow => ({
  startTime: new Date(anchor - radius).toISOString(),
  endTime: new Date(anchor + radius).toISOString()
});

const intersectWindow = (
  candidate: TransactionLogTimeWindow,
  boundary: TransactionLogTimeWindow
): TransactionLogTimeWindow | undefined => {
  const candidateStart = timestamp(candidate.startTime);
  const candidateEnd = timestamp(candidate.endTime);
  const boundaryStart = timestamp(boundary.startTime);
  const boundaryEnd = timestamp(boundary.endTime);
  if (
    candidateStart === undefined || candidateEnd === undefined ||
    boundaryStart === undefined || boundaryEnd === undefined
  ) return undefined;

  const start = Math.max(candidateStart, boundaryStart);
  const end = Math.min(candidateEnd, boundaryEnd);
  if (end <= start) return undefined;
  return { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() };
};

const windowKey = ({ startTime, endTime }: TransactionLogTimeWindow): string => `${startTime}|${endTime}`;

export const transactionLogTimeWindows = (
  row: Record<string, unknown>,
  fallback: TransactionLogTimeWindow
): TransactionLogTimeWindow[] => {
  const anchor = timestamp(row["ecp.txn.timestamp"]);
  if (anchor === undefined) return [fallback];

  const transactionDuration = duration(row["ecp.txn.duration"]);
  const initialRadius = Math.max(INITIAL_RADIUS_MS, transactionDuration + DURATION_PADDING_MS);
  const expandedRadius = Math.max(EXPANDED_RADIUS_MS, initialRadius * 2);
  const candidates = [
    intersectWindow(windowAround(anchor, initialRadius), fallback),
    intersectWindow(windowAround(anchor, expandedRadius), fallback),
    fallback
  ].filter((candidate): candidate is TransactionLogTimeWindow => Boolean(candidate));
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = windowKey(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const contentBoundary = (line: string | undefined): number | undefined => {
  if (!line) return undefined;
  const match = line.match(/^\s*(\d{4}-\d{2}-\d{2}T\S+)/);
  return timestamp(match?.[1]);
};

const lastContentLine = (lines: string[]): string | undefined => {
  for (let position = lines.length - 1; position >= 0; position -= 1) {
    if (lines[position]?.trim()) return lines[position];
  }
  return undefined;
};

export const transactionLogNeedsWiderWindow = (
  content: string,
  window: TransactionLogTimeWindow
): boolean => {
  if (!content.trim()) return true;
  const lines = content.split("\n");
  const first = contentBoundary(lines.find((line) => line.trim()));
  const last = contentBoundary(lastContentLine(lines));
  if (first === undefined || last === undefined) return false;

  const start = timestamp(window.startTime);
  const end = timestamp(window.endTime);
  if (start === undefined || end === undefined) return false;
  return first - start <= BOUNDARY_MARGIN_MS || end - last <= BOUNDARY_MARGIN_MS;
};
