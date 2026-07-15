export function sanitizeOptionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
