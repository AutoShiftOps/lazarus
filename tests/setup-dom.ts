/**
 * Loaded only by *.test.tsx files (see vitest.config.ts).
 * devDependencies behind it, for the PR notes:
 * - jsdom: DOM implementation for component and hook tests.
 * - @testing-library/react: render/renderHook with React 19 act handling.
 * - @testing-library/dom: peer dependency of @testing-library/react.
 * - @testing-library/user-event: realistic pointer and keyboard input (candle hold).
 * - @testing-library/jest-dom (v6, since v8 needs vitest 5): readable DOM matchers.
 */
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});
