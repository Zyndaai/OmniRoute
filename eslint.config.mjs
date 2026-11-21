import { createRequire } from "node:module";
import { fixupPluginRules } from "@eslint/compat";
import * as espree from "espree";
import importPlugin from "eslint-plugin-import";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const require = createRequire(import.meta.url);

// #7879: bar NEW local `toNumber` definitions outside the canonical helper.
// Pre-existing definitions (~51 across the codebase) are frozen via
// config/quality/eslint-suppressions.json and migrated tier-by-tier; only a
// genuinely NEW `function toNumber`/`const toNumber = ...` should fail.
const TO_NUMBER_RESTRICTION = {
  selector: "FunctionDeclaration[id.name='toNumber'], VariableDeclarator[id.name='toNumber']",
  message:
    "New local `toNumber` definitions are barred — import `toNumber` from " +
    "`@/shared/utils/numeric` (src) or `open-sse/utils/numeric.ts` (engine) instead " +
    "(#7879). See that module's JSDoc for the " +
    "canonical coercion shape and the `toNumberOrNull`/`toNumberArray` variants.",
};

const LOCAL_DB_IMPORT_RESTRICTION = {
  regex: "^(?:@/lib/localDb(?:\\.ts)?|(?:\\.\\.?/)+(?:lib/)?localDb(?:\\.ts)?)$",
  message:
    "The localDb compatibility barrel is restricted — import the owning domain module " +
    "from `@/lib/db/` instead.",
};

const EXECUTOR_IMPORT_RESTRICTION = {
  regex: "^(?:@omniroute/)?open-sse/executors(?:/|$)",
  message: "Executor implementations must stay behind an open-sse handler or service boundary.",
};

const PROP_TYPES_RESTRICTION = {
  name: "prop-types",
  message: "PropTypes are deprecated. Use TypeScript types/interfaces instead.",
};

const IMPORT_BOUNDARY_RESTRICTIONS = {
  paths: [PROP_TYPES_RESTRICTION],
  patterns: [LOCAL_DB_IMPORT_RESTRICTION],
};

/** @type {import("eslint").Linter.Config[]} */
const eslintConfig = [
  // React, React Hooks, import and jsx-a11y for every source file. eslint-plugin-react and
  // eslint-plugin-import still call context methods ESLint 10 removed, hence fixupPluginRules.
  {
    name: "omniroute/react",
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    plugins: {
      react: fixupPluginRules(react),
      "react-hooks": reactHooks,
      import: fixupPluginRules(importPlugin),
      "jsx-a11y": jsxA11y,
    },
    languageOptions: {
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    settings: {
      react: { version: "detect" },
      "import/parsers": {
        "@typescript-eslint/parser": [".ts", ".mts", ".cts", ".tsx", ".d.ts"],
      },
      // Resolvers by absolute path: eslint-plugin-import otherwise loads them by name
      // relative to the linted file.
      "import/resolver": {
        [require.resolve("eslint-import-resolver-node")]: {
          extensions: [".js", ".jsx", ".ts", ".tsx"],
        },
        [require.resolve("eslint-import-resolver-typescript")]: { alwaysTryTypes: true },
      },
    },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      "import/no-anonymous-default-export": "warn",
      "react/no-unknown-property": "off",
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "jsx-a11y/alt-text": ["warn", { elements: ["img"], img: ["Image"] }],
      "jsx-a11y/aria-props": "warn",
      "jsx-a11y/aria-proptypes": "warn",
      "jsx-a11y/aria-unsupported-elements": "warn",
      "jsx-a11y/role-has-required-aria-props": "warn",
      "jsx-a11y/role-supports-aria-props": "warn",
      "react/jsx-no-target-blank": "off",
    },
  },
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: espree,
    },
  },
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { sourceType: "module" },
    },
  },
  // Pacote 4 (plano mestre testes+CI, 2026-07-04) — zero-warning policy: TODA regra roda
  // como "error" e a dívida pré-existente vive congelada por arquivo+regra em
  // config/quality/eslint-suppressions.json (ESLint bulk suppressions nativo). Violação
  // NOVA = vermelho no ato (lint-staged no pre-commit + job lint-guard no fast path);
  // o drift de +41/+88 warnings/ciclo que era rebaselinado às cegas na release morre no
  // PR que o introduz. Aperto do baseline: npx eslint . --prune-suppressions
  // --suppressions-location config/quality/eslint-suppressions.json (na release).
  {
    files: ["src/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "react-hooks/exhaustive-deps": "error",
      "import/no-anonymous-default-export": "error",
      // window.alert/confirm/prompt are suppressed in embedded browsers (the action then
      // silently does nothing). Use useConfirmDialog / usePromptDialog or a toast instead.
      "no-alert": "error",
    },
  },
  // FASE-02: Security rules (strict everywhere)
  {
    rules: {
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      "no-restricted-imports": ["error", IMPORT_BOUNDARY_RESTRICTIONS],
    },
  },
  // G14: DB internals may use the compatibility barrel while it is decomposed; all
  // other source files must import the owning src/lib/db domain module directly.
  {
    files: ["src/lib/db/**/*.{ts,tsx,js,jsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [PROP_TYPES_RESTRICTION],
        },
      ],
    },
  },
  // G14: App routes/components must delegate provider execution through handlers or
  // services instead of reaching into executor implementations.
  {
    files: ["src/app/**/*.{js,jsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          ...IMPORT_BOUNDARY_RESTRICTIONS,
          patterns: [LOCAL_DB_IMPORT_RESTRICTION, EXECUTOR_IMPORT_RESTRICTION],
        },
      ],
    },
  },
  // TypeScript routes may import executor *types* (e.g. ProviderCredentials); only value
  // imports cross the boundary.
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        { patterns: [{ ...EXECUTOR_IMPORT_RESTRICTION, allowTypeImports: true }] },
      ],
    },
  },
  // i18n: ham toLowerCase().includes() arama pattern'ini engelle
  // (Türkçe İ/ı karakterlerini bozar — matchesSearch kullanılmalı).
  // "warn" (error değil): kuralın eklendiği anda kod tabanında zaten bu pattern'i
  // kullanan ~19 satır var; aşamalı temizlik için uyarı seviyesinde tutuluyor
  // (proje politikası: 0 error, warning'ler tolere edilir).
  {
    files: ["src/app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='includes'][callee.object.callee.property.name='toLowerCase']",
          message:
            "Türkçe-güvenli arama için matchesSearch() kullan (@/shared/utils/turkishText). Ham toLowerCase().includes() İ/ı karakterlerini bozar.",
        },
        TO_NUMBER_RESTRICTION,
      ],
    },
  },
  // #7879: same toNumber restriction for the rest of src/ and open-sse/ — kept
  // as a separate block (via `ignores`) so it does not clobber the
  // app/components-scoped rule array above (flat config replaces a rule's
  // options entirely per matching file, it does not merge arrays).
  {
    files: ["src/**/*.ts", "open-sse/**/*.ts"],
    ignores: ["src/app/**", "src/components/**"],
    rules: {
      "no-restricted-syntax": ["error", TO_NUMBER_RESTRICTION],
    },
  },
  // Canonical helper module itself is exempt from its own restriction. It lives in the engine so
  // open-sse can import it without a new open-sse → src edge; src/shared/utils/numeric.ts re-exports it.
  {
    files: ["open-sse/utils/numeric.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
  // Relaxed rules for TypeScript in open-sse and tests (incremental adoption).
  // The TypeScript block above already registers @typescript-eslint for every TS file;
  // registering a second plugin object is rejected by ESLint 10.
  {
    files: ["open-sse/**/*.ts", "tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "react-hooks/rules-of-hooks": "off",
    },
  },
  {
    files: ["tests/**/*.mjs"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "react-hooks/rules-of-hooks": "off",
    },
  },
  // JS/JSX files do not match the TypeScript block. Register the plugin only for
  // that disjoint scope so the shared unused-vars ratchet works without
  // redefining the plugin for TS/TSX under ESLint 10.
  {
    files: ["src/**/*.{js,jsx}"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
  },
  // Ratchet: bar NEW unused vars/args/catches outside the `_` escape hatch.
  // Pre-existing violations are frozen via config/quality/eslint-suppressions.json
  // (same pattern as #7879 toNumber); only genuinely NEW unused bindings fail
  // lint. `args: "all"` (not `after-used`) so a leading unused param is never
  // silently skipped, e.g. `function handle(req, _opts, next)` must flag `req`.
  // @typescript-eslint is registered by the blocks above; registering it again
  // in this block is rejected by ESLint 10.
  {
    files: ["src/**/*.{ts,tsx,js,jsx}", "open-sse/**/*.ts", "tests/**/*.{ts,tsx,mjs}"],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  // Global ignores — keep ESLint scoped to source files only
  {
    ignores: [
      // Build output and generated route types
      ".build/**",
      ".react-router/**",
      "out/**",
      "build/**",
      "dist/**",
      "coverage/**",
      // Scripts and binaries
      "scripts/**",
      "bin/**",
      // Dependencies
      "node_modules/**",
      ".worktrees/**",
      // Nested git worktrees created by review/resolve skills live under
      // .claude/ (gitignored). They hold other sessions' in-progress work and
      // their files move mid-scan, so never lint them from the main checkout.
      ".claude/**",
      ".omnivscodeagent/**",
      // _tasks/ — planning/handoff/research artifacts (gitignored, external code)
      "_tasks/**",
      // _artifacts/ — per-session review/recheck scratch inside worktrees
      // (gitignored; workflow scripts with top-level return)
      "_artifacts/**",
      // .agents/ — skill definitions + their helper scripts (gitignored; the
      // canonical copy lives here and is symlinked into .claude/).
      ".agents/**",
      // .source/ — fumadocs codegen output (@ts-nocheck + bundler-only import
      // query params like `?collection=docs`, which are not valid TS on their own).
      ".source/**",
      // VS Code extension and its large test fixtures
      "vscode-extension/**",
      // packages/ui-kit/ — snapshot vendorizado do CI UI Kit (lintado upstream; patches locais proibidos)
      "packages/ui-kit/**",
      "_references/**",
      "_mono_repo/**",
      "review/**",
      // Docs
      "docs/**",
      // Open-SSE compiled/bundled output
      "open-sse/mcp-server/dist/**",
      // Playwright test output
      "playwright-report/**",
      "test-results/**",
      // Legacy app/ and QA backup dirs (renamed to dist/ in Layer 1)
      "app/**",
      "app.__qa_backup/**",
      // CLI package copy directory
      "clipr/**",
    ],
  },
];

export default eslintConfig;
