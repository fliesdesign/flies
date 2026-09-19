import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "unicorn", "oxc", "react", "jsx-a11y", "import", "promise"],

  categories: {
    correctness: "error",
    suspicious: "warn",
    perf: "warn",
  },

  env: {
    builtin: true,
    browser: true,
    es2024: true,
  },

  rules: {
    // Vite uses the automatic JSX runtime — React need not be in scope.
    "react/react-in-jsx-scope": "off",
    // Side-effect stylesheet imports are the normal way to load CSS under Vite.
    "import/no-unassigned-import": ["warn", { allow: ["**/*.css"] }],
  },

  ignorePatterns: ["dist", "src-tauri/target", "src/routeTree.gen.ts"],

  overrides: [
    {
      // Vendored shadcn/ui registry output. Keep correctness checks, but don't
      // flag upstream style choices we would only diverge from on re-sync.
      files: ["src/components/ui/**", "src/hooks/use-mobile.ts"],
      rules: {
        "eslint/no-shadow": "off",
        "react/no-array-index-key": "off",
        "react/no-unstable-nested-components": "off",
        "react/jsx-no-constructed-context-values": "off",
        "react/no-object-type-as-default-prop": "off",
        "jsx-a11y/prefer-tag-over-role": "off",
        "jsx-a11y/label-has-associated-control": "off",
        "jsx-a11y/click-events-have-key-events": "off",
        "jsx-a11y/no-noninteractive-element-interactions": "off",
        "eslint/no-underscore-dangle": "off",
        "react/set-state-in-effect": "off",
      },
    },
  ],
});
