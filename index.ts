/**
 * Entry point for Pi's directory discovery.
 *
 * Pi looks for `<extension-dir>/index.ts`; the implementation lives in `src/`.
 * Keeping this re-export means the same checkout works whether it is symlinked
 * into ~/.pi/agent/extensions/, installed from npm, or loaded with `pi -e`.
 */
export { default } from "./src/index.js";
