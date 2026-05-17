import js from "@eslint/js";
import globals from "globals";
import importPlugin from "eslint-plugin-import";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "scripts/**",
      "public/**",
      "eslint.config.js",
      "src/lib/**/*.js",
      "src/**/*.js",
      "src/lib/**",
      "src/moleculer.config.ts",
      "src/services/core/**",
      "src/services/features/core/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  importPlugin.flatConfigs.typescript,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
          alwaysTryTypes: true,
        },
        node: {
          extensions: [".js", ".mjs", ".cjs", ".ts"],
        },
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "import/no-unresolved": [
        "error",
        {
          ignore: ["^@modelcontextprotocol/sdk/"],
        },
      ],
    },
  },
  {
    files: [
      "src/services/features/telegram-mcp/gateway-*.service.ts",
      "src/services/features/telegram-mcp/src/features/browser/model/browserService.ts",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
