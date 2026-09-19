import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 100,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  tabWidth: 2,

  // Replaces prettier-plugin-tailwindcss. Tailwind v4 reads the theme from the
  // stylesheet rather than a JS config.
  sortTailwindcss: {
    stylesheet: "src/styles.css",
    functions: ["cn", "cva"],
  },

  sortImports: {
    groups: ["builtin", "external", "internal", ["parent", "sibling", "index"]],
    newlinesBetween: true,
  },

  ignorePatterns: ["dist", "src-tauri/target", "src/routeTree.gen.ts"],
});
