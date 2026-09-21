export type SourceFormat = "auto" | "html" | "jsx";

export function unwrapSource(input: string): { source: string; language?: string } {
  const source = input.trim();
  const fence = source.match(/^```([\w-]*)\s*\n([\s\S]*?)\n?```$/);

  return fence ? { source: fence[2].trim(), language: fence[1].toLowerCase() } : { source };
}

/** Conservative clipboard detection: ordinary prose remains a text layer. */
export function detectSourceFormat(input: string): Exclude<SourceFormat, "auto"> | undefined {
  const unwrapped = unwrapSource(input);
  const language = unwrapped.language;

  const source = unwrapped.source.replace(
    /^(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)\s*|["']use (?:client|server)["'];?\s*)+/,
    "",
  );

  if (["jsx", "tsx", "react"].includes(language ?? "")) return "jsx";
  if (["html", "htm"].includes(language ?? "")) return "html";

  if (
    /^(?:import\s|export\s|(?:async\s+)?function\s|(?:const|let|type|interface)\s|return\s|\(?\s*<)/.test(
      source,
    ) &&
    /<[A-Za-z>]/.test(source)
  ) {
    if (
      !source.startsWith("<") ||
      /className\s*=|htmlFor\s*=|=\s*\{|>\s*\{|<\/?[A-Z]|<>/.test(source)
    )
      return "jsx";
  }

  if (/^(?:<!doctype\s+html|<!--[\s\S]*?-->\s*<|<[a-z][\w:-]*(?:\s|\/?>))/i.test(source))
    return "html";

  return undefined;
}
