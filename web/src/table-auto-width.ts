const pixels = (value: string): number => Number.parseFloat(value) || 0;

export const measureContentWidth = (element: HTMLElement): number => {
  const style = getComputedStyle(element);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return element.scrollWidth;
  context.font = style.font;
  const spacing = pixels(style.letterSpacing);
  const text = element.textContent ?? "";
  const width = Math.max(0, ...text.split(/\r?\n/).map(line => context.measureText(line).width + Math.max(0, line.length - 1) * spacing));
  return Math.ceil(width + pixels(style.paddingLeft) + pixels(style.paddingRight) + pixels(style.borderLeftWidth) + pixels(style.borderRightWidth));
};

export const measureTableColumnWidth = (table: HTMLTableElement, index: number, minimum = 80, maximum = 3000): number => {
  const cells = Array.from(table.rows).flatMap(row => row.cells[index] ? [row.cells[index]] : []);
  const width = Math.max(minimum, ...cells.map(cell => measureContentWidth(cell) + 20));
  return Math.min(maximum, Math.ceil(width));
};

export const fitTableColumn = (table: HTMLTableElement, index: number): void => {
  const width = measureTableColumnWidth(table, index);
  for (const row of Array.from(table.rows)) {
    const cell = row.cells[index];
    if (!cell) continue;
    cell.style.width = `${width}px`;
    cell.style.minWidth = `${width}px`;
    cell.style.maxWidth = `${width}px`;
  }
};
