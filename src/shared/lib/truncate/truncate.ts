export function truncateText(
  input: string,
  maxChars: number,
  suffix = " [truncated]",
): string {
  if (input.length <= maxChars) {
    return input;
  }

  if (maxChars <= suffix.length) {
    return input.slice(0, maxChars);
  }

  return `${input.slice(0, maxChars - suffix.length)}${suffix}`;
}
