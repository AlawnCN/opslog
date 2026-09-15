import type { LogFoldBlock } from "./transaction-log-model";

type FoldRange = Pick<LogFoldBlock, "from" | "to">;

const strictlyContains = (parent: FoldRange, child: FoldRange): boolean =>
  child.from >= parent.from && child.to <= parent.to &&
  (child.from > parent.from || child.to < parent.to);

export const directChildLogFolds = (
  folds: readonly LogFoldBlock[],
  parent: FoldRange
): LogFoldBlock[] => {
  const descendants = folds.filter((fold) => strictlyContains(parent, fold));
  return descendants.filter((candidate) => !descendants.some((other) =>
    other !== candidate && strictlyContains(other, candidate)
  ));
};

export const serviceFoldExpansionAnchor = (
  folds: readonly LogFoldBlock[],
  parent: FoldRange
): number | undefined => folds.find((fold) =>
  fold.kind === "service" && fold.from === parent.from && fold.to === parent.to
)?.lineFrom;
