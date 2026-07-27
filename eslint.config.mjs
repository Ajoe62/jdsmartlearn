import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

/**
 * ESLint 9 flat config. `eslint-config-next` still ships eslintrc-style config,
 * so FlatCompat translates it - the same shape create-next-app generates.
 *
 * Run it with the ESLint CLI (`npm run lint`), not `next lint`, which is
 * deprecated in Next 15 and drops into an interactive setup prompt.
 */
const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  {
    ignores: [".next/**", "node_modules/**", "out/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Firestore documents come back as `any` from the Admin SDK and are cast
      // at the boundary; the casts are the documentation.
      "@typescript-eslint/no-explicit-any": "warn",
      // A leading underscore means "deliberately dropped", as in the sync index
      // stripping studyGuide out of the bundle.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
];

export default config;
