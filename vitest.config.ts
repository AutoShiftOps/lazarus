import { defineConfig } from "vitest/config";

/**
 * Two projects: the existing node suite (*.test.ts) is untouched, and component/hook
 * tests (*.test.tsx) additionally load tests/setup-dom.ts. Each .tsx file opts into jsdom
 * with a per-file `// @vitest-environment jsdom` comment; the default stays "node".
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          globals: true,
          environment: "node",
          include: ["tests/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "dom",
          globals: true,
          environment: "node",
          include: ["tests/**/*.test.tsx"],
          setupFiles: ["tests/setup-dom.ts"],
        },
      },
    ],
  },
});
