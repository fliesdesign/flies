import { defineConfig } from "vite-plus";

export default defineConfig({
  defaultPackage: "./apps/web",
  fmt: {
    printWidth: 100,
    semi: true,
    singleQuote: false,
    trailingComma: "all",
    tabWidth: 2,
    sortTailwindcss: {
      stylesheet: "apps/web/src/styles.css",
      functions: ["cn", "cva"],
    },
    sortImports: {
      groups: ["builtin", "external", "internal", ["parent", "sibling", "index"]],
      newlinesBetween: true,
    },
    ignorePatterns: ["dist", "apps/desktop/target", "**/routeTree.gen.ts"],
  },
  lint: {
    plugins: ["typescript", "unicorn", "oxc", "react", "jsx-a11y", "import", "promise"],
    jsPlugins: [
      { name: "vite-plus", specifier: "vite-plus/oxlint-plugin" },
      { name: "stylistic", specifier: "@stylistic/eslint-plugin" },
    ],
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
      "stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: "return" },
        {
          blankLine: "always",
          prev: "*",
          next: ["function", "class", "multiline-block-like", "multiline-const", "multiline-let"],
        },
        {
          blankLine: "always",
          prev: ["function", "class", "multiline-block-like", "multiline-const", "multiline-let"],
          next: "*",
        },
        { blankLine: "any", prev: "function-overload", next: "function" },
      ],
      "stylistic/lines-between-class-members": ["error", "always", { exceptAfterSingleLine: true }],
      "vite-plus/prefer-vite-plus-imports": "error",
      "react/react-in-jsx-scope": "off",
      "import/no-unassigned-import": ["warn", { allow: ["**/*.css"] }],
    },
    ignorePatterns: ["dist", "apps/desktop/target", "**/routeTree.gen.ts"],
    options: {
      typeAware: false,
      typeCheck: false,
    },
    overrides: [
      {
        files: ["apps/web/src/components/ui/**", "apps/web/src/hooks/use-mobile.ts"],
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
  },
});
