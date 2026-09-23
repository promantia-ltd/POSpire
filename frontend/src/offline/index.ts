/**
 * Offline storage layer — public surface.
 *
 * Components do not touch Dexie directly (03-storage-layer.md §4.1). They
 * import from this barrel or from the specific repo module.
 *
 * This module also drives bootstrap — `initOfflineStorage()` must be
 * awaited before any repo is used.
 */

export {
	db,
	journalDb,
	initOfflineStorage,
	isSafeMode,
	getSafeMode,
	onSafeModeChange,
	enterSafeMode,
	exitSafeMode,
	assertWritable,
	SafeModeBlockedError,
	onDegradedStorageChange,
	runInTransaction,
	uuidV4,
	startHealthProbe,
	stopHealthProbe,
} from "./db";

export {
	encrypt,
	decrypt,
	generateKey,
	getActiveKey,
	setActiveKey,
	registerHistoricalKey,
	canonicalIntegrityHash,
	IntegrityMismatchError,
	CryptoUnavailableError,
} from "./crypto";

export {
	OFFLINE_PREFIX_CUSTOMER,
	OFFLINE_PREFIX_INVOICE,
	OFFLINE_PREFIX_MATERIAL_RECEIPT,
	OFFLINE_PREFIX_OPENING_ENTRY,
	OFFLINE_PREFIX_CLOSING_ENTRY,
	OFFLINE_PREFIX_RETURN,
	OFFLINE_SHORT_ID_LENGTH,
	buildProvisionalName,
	LS_DEVICE_ID,
	LS_SCHEMA_VERSION,
	LS_LAST_PROFILE_SNAPSHOT_TS,
	TTL_ITEMS_MS,
	TTL_CUSTOMERS_MS,
	TTL_PRICE_LIST_MS,
	TTL_TAX_TEMPLATES_MS,
	STALE_HYDRATION_MS,
	OFFLINE_SCHEMA_VERSION,
	DB_NAME_PRIMARY,
	DB_NAME_JOURNAL,
} from "./constants";

export * from "./types";

export * as itemsRepo from "./repos/items";
export * as customersRepo from "./repos/customers";
export * as shiftsRepo from "./repos/shifts";
export * as outboxRepo from "./repos/outbox";
export * as metadataRepo from "./repos/metadata";
