export function validateSharedCss(value: unknown): string {
  if (typeof value !== "string" || value.length > 50_000)
    throw new Error("css must be a string of at most 50,000 characters.");
  if (/url\s*\(|\\|@import|@font-face|expression\s*\(|<\/style/i.test(value))
    throw new Error("Shared CSS must be self-contained. Use named fonts and embedded image nodes.");

  return value;
}
