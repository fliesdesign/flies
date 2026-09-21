import { importHtml } from "./html";
import { detectSourceFormat, unwrapSource, type SourceFormat } from "./source";

export type ImportSourceOptions = Parameters<typeof importHtml>[1] & { format?: SourceFormat };

/** Shared by clipboard and MCP. Conversion completes before the caller edits its document. */
export async function importSource(input: string, options: ImportSourceOptions) {
  const requested = options.format ?? "auto";
  if (!["auto", "html", "jsx"].includes(requested))
    throw new Error("Source format must be auto, html or jsx (including TSX).");
  const format = requested === "auto" ? detectSourceFormat(input) : requested;
  if (!format) throw new Error("Paste HTML, JSX or a self-contained React/TSX component.");
  const { source } = unwrapSource(input);

  const { html, warnings } =
    format === "jsx"
      ? await (await import("./jsx")).jsxToHtml(source)
      : { html: source, warnings: [] as string[] };

  const nodes = await importHtml(html, options);

  return { nodes, warnings, format };
}
