/**
 * Who this device's saved lessons belong to, and when they must be destroyed.
 *
 * ONE STUDENT AND ONE SCHOOL PER DEVICE AT A TIME. That is what protects a
 * shared phone, which is the normal case in these schools rather than the edge
 * case. Pure and dependency-free so the rule can be tested directly rather than
 * through IndexedDB - the same treatment as merge.ts and collapse.ts, and for a
 * stronger reason: this one decides whether a child's work is deleted.
 *
 * NEITHER IDENTITY MAY EVER COME FROM THE HOSTNAME. Both are read from the
 * server-verified session by the caller. A hostname is a routing hint that
 * anybody can point at us (lib/routing/hostname.ts), and letting one reach this
 * function would hand a stranger with a DNS record the power to wipe a child's
 * saved lessons by being visited once.
 */

/** What the caller must do with the store it already has. */
export type OwnerVerdict =
  /** Someone else's content. Destroy it before anything else touches it. */
  | "wipe"
  /** Same owner, but the store predates `schoolId`. Record it and carry on. */
  | "backfill"
  /** Same owner, nothing to do. */
  | "keep";

export function ownerVerdict(
  stored: { studentId: string; schoolId?: string } | null | undefined,
  studentId: string,
  schoolId?: string
): OwnerVerdict {
  // No store yet: nothing to protect and nothing to destroy.
  if (!stored) return "keep";

  if (stored.studentId !== studentId) return "wipe";

  /**
   * A DIFFERENT SCHOOL IS AS STRONG A SIGNAL AS A DIFFERENT STUDENT, and it is
   * not caught by the check above. A device is only re-owned when somebody
   * SIGNS IN; a phone can be carried to another school's address long before
   * that, which would leave one school's lessons sitting on a device now
   * presenting as another.
   */
  if (schoolId && stored.schoolId && stored.schoolId !== schoolId) return "wipe";

  /**
   * An absent `schoolId` means "written before this field existed", which is
   * not evidence of a school change. Backfilled rather than wiped: wiping on
   * deploy would cost every child on every device their saved lessons, for
   * nothing, on exactly the slow connections this product exists for.
   */
  if (schoolId && stored.schoolId !== schoolId) return "backfill";

  return "keep";
}
