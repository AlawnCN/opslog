const NAIROBI_OFFSET_MS = 3 * 60 * 60 * 1000;

const pad = (value: number): string => String(value).padStart(2, "0");

export const nairobiLocal = (date: Date): string => {
  const shifted = new Date(date.getTime() + NAIROBI_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
};

export const toUtcIso = (nairobiValue: string): string => {
  const match = nairobiValue.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) throw new Error("时间格式无效");
  const [, year, month, day, hour, minute] = match;
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return new Date(utc - NAIROBI_OFFSET_MS).toISOString();
};

export const displayNairobiTime = (value: unknown): string => {
  if (typeof value !== "string") return value == null ? "—" : String(value);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Africa/Nairobi",
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
