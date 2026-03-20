/**
 * Re-exports frappe-ui's call() function.
 *
 * Usage in components:
 *   import { call } from "@/utils/call";
 *   const result = await call("pospire.pospire.api.posapp.get_items", args);
 *
 * BACKLOG: Evaluate replacing this thin wrapper with a direct
 * `import { call } from "frappe-ui"` in each component once the team
 * has done a thorough analysis of frappe-ui's full API surface and
 * whether any other frappe-ui utilities (createResource, etc.) should
 * be adopted across the codebase.
 */
export { call } from "frappe-ui";
