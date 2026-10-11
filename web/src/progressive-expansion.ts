export interface ExpansionRange { from: number; to: number; }

const contains = (parent: ExpansionRange, child: ExpansionRange): boolean =>
  parent.from <= child.from && parent.to >= child.to;

// Close the innermost visible open regions, never their parents in the same step.
export const collapseRangesOneLevel = (ranges: readonly ExpansionRange[], collapsed: readonly ExpansionRange[]): ExpansionRange[] => {
  const open = ranges.filter((range) => !collapsed.some((fold) => contains(fold, range)));
  return open.filter((range) => !open.some((child) =>
    (child.from !== range.from || child.to !== range.to) && contains(range, child)
  ));
};

export const collapseTreeOneLevel = (paths: readonly string[], expanded: ReadonlySet<string>): Set<string> => {
  const visible = paths.filter((path) => {
    if (!expanded.has(path)) return false;
    const ancestors = path.split(".");
    ancestors.pop();
    while (ancestors.length) {
      if (!expanded.has(ancestors.join("."))) return false;
      ancestors.pop();
    }
    return true;
  });
  const frontier = visible.filter((path) => !visible.some((child) => child.startsWith(`${path}.`)));
  return new Set([...expanded].filter((path) => !frontier.includes(path)));
};

// Snapshot the visible fold frontier. Hidden descendants must not be opened
// by the same click as their parent.
export const visibleCollapsedRanges = (ranges: readonly ExpansionRange[]): ExpansionRange[] => {
  const sorted = [...ranges].sort((left, right) => left.from - right.from || right.to - left.to);
  const visible: ExpansionRange[] = [];
  for (const range of sorted) {
    const parent = visible[visible.length - 1];
    if (parent && parent.from <= range.from && parent.to >= range.to) continue;
    visible.push(range);
  }
  return visible;
};

export const expandTreeOneLevel = (paths: readonly string[], expanded: ReadonlySet<string>): Set<string> => {
  const frontier = paths.filter((path) => {
    if (expanded.has(path)) return false;
    const ancestors = path.split(".");
    ancestors.pop();
    while (ancestors.length) {
      if (!expanded.has(ancestors.join("."))) return false;
      ancestors.pop();
    }
    return true;
  });
  // Manually folded parents may have remembered expanded descendants.
  return new Set([...expanded].filter((path) => !frontier.some((parent) => path.startsWith(`${parent}.`))).concat(frontier));
};
