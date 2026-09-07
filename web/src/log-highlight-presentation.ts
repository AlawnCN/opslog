import type { LogHighlightKind } from "./transaction-log-model";

export const logHighlightClassName = (kind: LogHighlightKind): string => `cm-log-${kind}`;
