/**
 * DEPRECATED — this file is superseded by `./call.ts`.
 *
 * Vite's resolver (see `frontend/vite.config.js`) is configured to prefer
 * `.ts` over `.js` at the same base path, so every `import ... from
 * "@/utils/call"` resolves to `call.ts`. This file is retained only to make
 * the rollback easy if the TS wrapper needs to be temporarily disabled; it
 * should be deleted once Phase 1 is merged to `version_16_dev`.
 *
 * The `eslint-disable` is a guard: this file is in the override exception
 * list for `no-restricted-imports`, and we intentionally re-export the
 * wrapped implementation here so that if Vite's resolution ever misbehaves
 * and picks the `.js` we still get a working (if un-type-checked) wrapper.
 */
/* eslint-disable no-restricted-imports */

// Explicit extension — forces Vite/esbuild to load the TS sibling instead
// of re-resolving back to this file and forming a cycle.
export * from "./call.ts";
export { default } from "./call.ts";
