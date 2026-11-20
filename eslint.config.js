import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", ".venv/", ".agents/", ".claude/"] },
  js.configs.recommended,
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // Front-end scripts run in the browser, not Node.
    files: ["static/**/*.js"],
    languageOptions: { sourceType: "script", globals: { ...globals.browser } },
  },
];
