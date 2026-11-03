import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "src/db/migrations/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Config files are not part of the type-checked tsconfig project.
    files: ["*.config.ts", "*.config.js"],
    languageOptions: {
      parserOptions: {
        project: null,
      },
    },
  },
);
