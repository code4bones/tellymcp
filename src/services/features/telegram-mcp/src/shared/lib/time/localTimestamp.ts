function padNumber(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}

export function formatLocalTimestamp(date = new Date()): string {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}T${padNumber(
    date.getHours(),
  )}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.${padNumber(
    date.getMilliseconds(),
    3,
  )}`;
}

export function formatLocalDateSegment(date = new Date()): string {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}`;
}

export function formatLocalTimeSegment(date = new Date()): string {
  return `${padNumber(date.getHours())}-${padNumber(date.getMinutes())}-${padNumber(date.getSeconds())}`;
}

export function formatLocalTimestampForFileName(date = new Date()): string {
  return formatLocalTimestamp(date).replace(/[:.]/gu, "-");
}
