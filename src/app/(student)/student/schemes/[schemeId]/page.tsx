import { notFound, redirect } from "next/navigation";
import { getStudentSession } from "@/lib/auth/student";
import { getStudentScheme } from "@/lib/db/schemes";
import SchemeReaderView from "@/components/student/SchemeReaderView";

/**
 * One scheme of work.
 *
 * Scoping is enforced INSIDE the cached read: `getStudentScheme` resolves to
 * null for another class's scheme, another school's, or an unpublished draft, so
 * a guessed id 404s rather than leaking a title. The projection it returns names
 * its fields, so the tutor's uid and the R2 object key have nowhere to land.
 */
export default async function SchemePage({
  params,
}: {
  params: Promise<{ schemeId: string }>;
}) {
  const session = await getStudentSession();
  if (!session) redirect("/student/sign-in");

  const { schemeId: raw } = await params;
  const schemeId = decodeURIComponent(raw);

  const scheme = await getStudentScheme(session.schoolId, session.classId, schemeId);
  if (!scheme) notFound();

  return <SchemeReaderView schemeId={schemeId} initial={scheme} />;
}
