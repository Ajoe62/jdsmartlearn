/**
 * Batch sizes the device and the server must agree on.
 *
 * Client-safe on purpose: both sides import these so a limit can never drift out
 * of step with the validation that enforces it. No env reads and no secrets here -
 * the offline grace window is server-side (see api/student/sync) and reaches the
 * device in the sync payload instead.
 */

/** Study guides a device may request in one call. */
export const MAX_GUIDE_IDS = 10;

/** Read receipts accepted in one flush. */
export const MAX_VIEW_RECEIPTS = 50;

/** Total material text kept on a device. A cheap phone has little to spare. */
export const MATERIAL_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Total saved original files. Larger than the text cap because one PDF can be
 * 10 MB, but still bounded - saved lessons must never be why a phone runs out.
 */
export const FILE_CAP_BYTES = 50 * 1024 * 1024;

/** Re-sync at most this often when simply returning to the tab. */
export const SYNC_STALE_MS = 5 * 60 * 1000;

/** Receipts older than this are dropped unsent - they are no longer interesting. */
export const OUTBOX_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
