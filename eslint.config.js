// ESLint flat config for the Google Apps Script sources (*.gs).
//
// Apps Script runs every .gs file in one shared global scope, so a function
// declared in GA4.gs is callable from Kod.gs without any import. Top-level
// functions are also entry points for triggers, menus and `clasp run`, which
// is why "unused" top-level functions are expected and only unused locals are
// flagged.
const fs = require("fs");
const path = require("path");
const js = require("@eslint/js");
const gas = require("eslint-plugin-googleappsscript");

/** Top-level function / const / let / var names across all .gs files. */
function projectGlobals() {
  const globals = {};
  for (const file of fs.readdirSync(__dirname)) {
    if (!file.endsWith(".gs")) continue;
    const src = fs.readFileSync(path.join(__dirname, file), "utf8");
    for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
      globals[m[1]] = "readonly";
    }
    for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      globals[m[1]] = "readonly";
    }
  }
  return globals;
}

module.exports = [
  {
    ignores: ["node_modules/**"],
  },
  // Node-side files: unit tests and this config.
  {
    files: ["test/**/*.js", "scripts/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        require: "readonly",
        module: "writable",
        process: "readonly",
        __dirname: "readonly",
        console: "readonly",
        Buffer: "readonly",
        URL: "readonly",
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Apps Script always returns files with a final newline; a source without
      // one shows up as drift right after deploy (v2.15.0). Catch it at lint time.
      "eol-last": ["error", "always"],
    },
  },
  {
    files: ["**/*.gs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...gas.environments.googleappsscript.globals,
        // Advanced services / newer globals missing from the plugin's list.
        AnalyticsAdmin: "readonly",
        AnalyticsData: "readonly",
        SearchConsole: "readonly",
        console: "readonly",
        ...projectGlobals(),
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "error",
        { vars: "local", args: "after-used", caughtErrors: "none" },
      ],
      "no-undef": "error",
      "no-redeclare": ["error", { builtinGlobals: false }],
      eqeqeq: ["warn", "smart"],
      "prefer-const": "warn",
      "eol-last": ["error", "always"],
    },
  },
];
