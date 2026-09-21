import { compile } from "tailwindcss";
import preflight from "tailwindcss/preflight.css?raw";
import theme from "tailwindcss/theme.css?raw";

/** Compile only this import's utilities, offline, with Tailwind's standard theme. */
export async function compileTailwind(fragment: DocumentFragment): Promise<string | undefined> {
  const candidates = [
    ...new Set(
      Array.from(fragment.querySelectorAll("[class]")).flatMap((element) =>
        Array.from(element.classList),
      ),
    ),
  ];

  if (!candidates.length) return undefined;
  // Arbitrary values must not bypass the HTML importer's passive-resource policy.
  if (candidates.some((candidate) => /\\|url\s*\(|image-set\s*\(|expression\s*\(/i.test(candidate)))
    throw new Error("Tailwind classes cannot load external resources or use CSS escapes.");

  const compiler = await compile(
    `@layer theme, base, utilities;\n@layer theme { ${theme} }\n@layer base { ${preflight} }\n@tailwind utilities;`,
  );

  return compiler.build(candidates);
}
