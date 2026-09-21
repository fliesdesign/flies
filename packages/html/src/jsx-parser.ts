import initSwc, { parseSync, type Expression, type Module, type ParseOptions } from "@swc/wasm-web";
import wasmUrl from "@swc/wasm-web/wasm_bg.wasm?url";

let initialization: Promise<unknown> | undefined;

const options: ParseOptions = {
  syntax: "typescript",
  tsx: true,
  target: "es2022",
  comments: false,
};

/** Vite emits the WASM as a local asset; concurrent pastes share one initialization. */
export async function parseJsx(source: string): Promise<Expression | Module> {
  initialization ??= initSwc({ module_or_path: wasmUrl }).catch((error: unknown) => {
    initialization = undefined;
    throw Object.assign(
      new Error(`Could not load the JSX parser. Try pasting again. ${String(error)}`),
      { cause: error },
    );
  });
  await initialization;

  try {
    // Includes JSX fragments, arrow functions and standalone function expressions.
    const statement = parseSync(`(${source}\n)`, options).body[0];
    if (statement?.type === "ExpressionStatement") return statement.expression;
  } catch {
    // Imports, declarations and exports are parsed as a module below.
  }

  try {
    if (/^return\s/.test(source)) {
      const statement = parseSync(`(() => {${source}\n})`, options).body[0];
      if (statement?.type === "ExpressionStatement") return statement.expression;
    }

    return parseSync(source, options);
  } catch (error) {
    throw Object.assign(
      new Error(`Invalid JSX/TSX: ${error instanceof Error ? error.message : String(error)}`),
      { cause: error },
    );
  }
}
