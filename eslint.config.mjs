import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

/**
 * Next 16 ships native flat configs, so these are spread directly rather than
 * bridged through FlatCompat.
 */
const config = [
  ...coreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
];

export default config;
