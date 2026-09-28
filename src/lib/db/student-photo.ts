import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { RP } from "@/lib/db/collections";
import { decodeJpegDataUri } from "@/lib/photos/decode";
import { photoVersion } from "@/lib/photos/url";
import type { StudentSession } from "@/lib/auth/student";
import type { ResultPeakStudent, ResultPeakStudentPhoto } from "@/types";

/**
 * The signed-in student's OWN approved passport photo, as JPEG bytes, or null.
 *
 * THE ONLY READ OF `studentPhotos` IN THIS REPO. It takes a session, not a
 * student id, so there is no way to call it for somebody else.
 *
 * The session is 12 hours old at most, so it is not trusted to say the child is
 * still enrolled: the student document is re-read on every request, the same
 * way a refresh re-reads it. A deactivated child, a child moved to another
 * school, and a photo ResultPeak has removed all come back null.
 *
 * Two document reads, in one round trip. The service worker holds the result in
 * its own bucket after the first fetch, so a child opening the app every day
 * pays this once per photo, not once per open.
 */
export async function getOwnStudentPhoto(
  session: StudentSession
): Promise<{ body: Buffer; version: number } | null> {
  const [studentSnap, photoSnap] = await adminDb.getAll(
    adminDb.doc(`${RP.students}/${session.studentId}`),
    adminDb.doc(`${RP.studentPhotos}/${session.studentId}`)
  );

  const student = studentSnap.data() as ResultPeakStudent | undefined;
  if (!student || student.isActive === false) return null;
  if (student.schoolId !== session.schoolId) return null;

  // The pointer is the contract: no pointer, no photo, whatever else exists.
  // It is also what ResultPeak removes first when a photo is taken down.
  const version = photoVersion(student.photoUpdatedAt);
  if (version === null) return null;

  const photo = photoSnap.data() as ResultPeakStudentPhoto | undefined;
  if (!photo || photo.schoolId !== session.schoolId) return null;
  if (photo.studentId !== undefined && photo.studentId !== session.studentId) return null;

  const body = decodeJpegDataUri(photo.dataUri);
  return body ? { body, version } : null;
}
