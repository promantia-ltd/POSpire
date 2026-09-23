/**
 * Runtime registration shim for the offline adapter.
 *
 * `@/utils/call` needs references to the read-cache and outbox implementations
 * owned by Agent 1 (Dexie) and Agent 3 (outbox). Until those modules are
 * merged into the worktree, `call.ts` runs against `null` implementations —
 * reads with `offline: true` fall back to "no cache available" and offline
 * writes surface an informative `OfflineWriteUnavailable` error.
 *
 * At integration time, Agent 1 and Agent 3 will call:
 *
 *   registerReadCache(dexieCacheImpl);
 *   registerOutboxEnqueue(outboxEnqueueImpl);
 *
 * from their module init paths (`Pos.vue` onMounted, wired in Phase 1 task
 * 1.6 review). No component code depends on this module directly.
 */

import type { OutboxEnqueueFn, ReadCache } from "./types";

let _readCache: ReadCache | null = null;
let _outboxEnqueue: OutboxEnqueueFn | null = null;

export function registerReadCache(impl: ReadCache | null): void {
	_readCache = impl;
}

export function getReadCache(): ReadCache | null {
	return _readCache;
}

export function registerOutboxEnqueue(fn: OutboxEnqueueFn | null): void {
	_outboxEnqueue = fn;
}

export function getOutboxEnqueue(): OutboxEnqueueFn | null {
	return _outboxEnqueue;
}
