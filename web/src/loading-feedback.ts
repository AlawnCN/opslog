export const MINIMUM_LOADING_FEEDBACK_MS = {
  search: 1200,
  transactionLogReader: 1550,
  trace: 1350,
  transactionLogDownload: 900
} as const;

export const keepLoadingFeedbackVisible = async (startedAt: number, minimumMs: number): Promise<void> => {
  const remainingMs = minimumMs - (performance.now() - startedAt);
  if (remainingMs <= 0) return;
  await new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs));
};
