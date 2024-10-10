module.exports = {
  extends: ["@sladg/eslint-config-base/node"],
  ignorePatterns: [
    "**/node_modules/**",
    "**/dist/**",
    "**/pnpm-lock.yaml",
    "packages/open-next/assets/sharp-node-modules",
  ],
  rules: {
    "prettier/prettier": [
      "error",
      {
        // This resets rules to prettier's defaults
      },
    ],
    "sonarjs/elseif-without-else": "warn",
    "sonarjs/no-duplicate-string": "warn",
    "sonarjs/cognitive-complexity": "warn",

    // We add some typescript rules - The recommended rules breaks too much stuff
    // TODO: We should add more rules, especially around typescript types

    // Promises related rules
    "@typescript-eslint/await-thenable": "error",
    "@typescript-eslint/no-floating-promises": "error",
    "@typescript-eslint/no-misused-promises": [
      "error",
      { checksVoidReturn: false },
    ],

    "@typescript-eslint/unbound-method": "error",

    "@typescript-eslint/no-non-null-assertion": "warn",
  },
  overrides: [
    {
      files: ["example/**/*", "examples/**/*"],
      rules: {
        "unused-imports/no-unused-vars": "off",
      },
    },
  ],
  parserOptions: {
    project: ["./tsconfig.eslint.json", "./**/tsconfig.json"],
  },
  ignorePatterns: ["**/node_modules/**", "**/dist/**", "**/out/**"],
};
