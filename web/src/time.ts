export const DEFAULT_TIME_ZONE = "Africa/Nairobi";

const pad = (value: number): string => String(value).padStart(2, "0");

const dateParts = (date: Date, timeZone: string): Record<string, string> => Object.fromEntries(
  new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
);

export const zonedLocal = (date: Date, timeZone = DEFAULT_TIME_ZONE): string => {
  const parts = dateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

export const rollingTimeZoneRange = (days: number, timeZone = DEFAULT_TIME_ZONE, end = new Date()): { startLocal: string; endLocal: string } => ({
  startLocal: zonedLocal(new Date(end.getTime() - days * 86_400_000), timeZone),
  endLocal: zonedLocal(end, timeZone)
});

/** Backwards-compatible Nairobi-specific helper used by older callers. */
export const rollingNairobiRange = (days: number, end = new Date()): { startLocal: string; endLocal: string } =>
  rollingTimeZoneRange(days, DEFAULT_TIME_ZONE, end);

const offsetAt = (date: Date, timeZone: string): number => {
  const parts = dateParts(date, timeZone);
  const representedUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  return representedUtc - date.getTime();
};

export const toUtcIso = (localValue: string, timeZone = DEFAULT_TIME_ZONE): string => {
  const match = localValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error("时间格式无效");
  const [, year, month, day, hour, minute] = match;
  const wallClock = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let utc = wallClock - offsetAt(new Date(wallClock), timeZone);
  utc = wallClock - offsetAt(new Date(utc), timeZone);
  return new Date(utc).toISOString();
};

export const displayTime = (value: unknown, timeZone = DEFAULT_TIME_ZONE): string => {
  if (typeof value !== "string") return value == null ? "—" : String(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    hour12: false
  }).format(date).replaceAll("/", "-");
};

export const timeZoneTitle = (timeZone: string): string => timeZone.replace("/", " / ").replaceAll("_", " ");

export const timeZoneOffsetLabel = (timeZone: string, date = new Date()): string => {
  const minutes = Math.round(offsetAt(date, timeZone) / 60_000);
  const sign = minutes < 0 ? "−" : "+";
  const absolute = Math.abs(minutes);
  return `UTC ${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
};
