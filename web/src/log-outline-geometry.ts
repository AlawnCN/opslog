export interface LogOutlineBounds {
  width: number;
  height: number;
}

export interface LogOutlineGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LogOutlineResizeDirection = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const OUTLINE_MARGIN = 8;
const MIN_OUTLINE_WIDTH = 380;
const MIN_OUTLINE_HEIGHT = 230;

const finiteOr = (value: number, fallback: number): number => Number.isFinite(value) ? value : fallback;
const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

const availableSize = (bounds: LogOutlineBounds) => ({
  width: Math.max(1, bounds.width - OUTLINE_MARGIN * 2),
  height: Math.max(1, bounds.height - OUTLINE_MARGIN * 2)
});

export const defaultLogOutlineGeometry = (bounds: LogOutlineBounds): LogOutlineGeometry => {
  const available = availableSize(bounds);
  const width = Math.min(760, Math.max(Math.min(MIN_OUTLINE_WIDTH, available.width), available.width * .62));
  const height = Math.min(520, Math.max(Math.min(MIN_OUTLINE_HEIGHT, available.height), available.height * .72));
  return {
    x: Math.max(OUTLINE_MARGIN, bounds.width - width - OUTLINE_MARGIN),
    y: OUTLINE_MARGIN,
    width,
    height
  };
};

export const clampLogOutlineGeometry = (geometry: LogOutlineGeometry, bounds: LogOutlineBounds): LogOutlineGeometry => {
  const fallback = defaultLogOutlineGeometry(bounds);
  const available = availableSize(bounds);
  const minimumWidth = Math.min(MIN_OUTLINE_WIDTH, available.width);
  const minimumHeight = Math.min(MIN_OUTLINE_HEIGHT, available.height);
  const width = clamp(finiteOr(geometry.width, fallback.width), minimumWidth, available.width);
  const height = clamp(finiteOr(geometry.height, fallback.height), minimumHeight, available.height);
  return {
    x: clamp(finiteOr(geometry.x, fallback.x), OUTLINE_MARGIN, Math.max(OUTLINE_MARGIN, bounds.width - width - OUTLINE_MARGIN)),
    y: clamp(finiteOr(geometry.y, fallback.y), OUTLINE_MARGIN, Math.max(OUTLINE_MARGIN, bounds.height - height - OUTLINE_MARGIN)),
    width,
    height
  };
};

export const moveLogOutlineGeometry = (
  geometry: LogOutlineGeometry,
  deltaX: number,
  deltaY: number,
  bounds: LogOutlineBounds
): LogOutlineGeometry => clampLogOutlineGeometry({
  ...geometry,
  x: geometry.x + deltaX,
  y: geometry.y + deltaY
}, bounds);

export const resizeLogOutlineGeometry = (
  geometry: LogOutlineGeometry,
  direction: LogOutlineResizeDirection,
  deltaX: number,
  deltaY: number,
  bounds: LogOutlineBounds
): LogOutlineGeometry => {
  const available = availableSize(bounds);
  const minimumWidth = Math.min(MIN_OUTLINE_WIDTH, available.width);
  const minimumHeight = Math.min(MIN_OUTLINE_HEIGHT, available.height);
  let left = geometry.x;
  let top = geometry.y;
  let right = geometry.x + geometry.width;
  let bottom = geometry.y + geometry.height;
  const maximumRight = bounds.width - OUTLINE_MARGIN;
  const maximumBottom = bounds.height - OUTLINE_MARGIN;

  if (direction.includes("e")) right = clamp(right + deltaX, left + minimumWidth, maximumRight);
  if (direction.includes("w")) left = clamp(left + deltaX, OUTLINE_MARGIN, right - minimumWidth);
  if (direction.includes("s")) bottom = clamp(bottom + deltaY, top + minimumHeight, maximumBottom);
  if (direction.includes("n")) top = clamp(top + deltaY, OUTLINE_MARGIN, bottom - minimumHeight);

  return clampLogOutlineGeometry({ x: left, y: top, width: right - left, height: bottom - top }, bounds);
};
