import type { Metadata } from "next";
import { CardLink } from "@/components/ui/Card";
import SchoolMark from "@/components/ui/SchoolMark";
import Wordmark from "@/components/ui/Wordmark";
import { getBrandingSchoolId } from "@/lib/auth/student";
import { getSchoolBrand, type SchoolBrand } from "@/lib/branding/school";
import { resultPeakSchoolUrl, resultPeakStaffUrl } from "@/lib/partner-links";

/**
 * Two front doors in one route.
 *
 * A visitor who arrived through their school's own link (/s/{slug}) gets THAT
 * SCHOOL'S front door: its crest, its name as the headline, and a door for each
 * audience. Everyone else gets the product's front door.
 *
 * Landing the school link here rather than on a page of its own is what makes a
 * bookmark survive. A parent who saves the page they were sent keeps the school;
 * a route that only branded /s/{slug} would drop it the moment anybody typed the
 * bare domain.
 */

export async function generateMetadata(): Promise<Metadata> {
  const brand = await pinnedBrand();
  return brand
    ? { title: brand.name, description: `Lessons and schoolwork for ${brand.name}.` }
    : {};
}

async function pinnedBrand() {
  const schoolId = await getBrandingSchoolId();
  return schoolId ? await getSchoolBrand(schoolId) : null;
}

export default async function Home() {
  const brand = await pinnedBrand();
  return brand ? <SchoolDoor brand={brand} /> : <ProductDoor />;
}

/* ------------------------------------------------------------------ */

/**
 * The school's own front door.
 *
 * Reads as the school's page, not as ours: crest and school name first, the two
 * audience doors, then the school's results service, then one quiet line saying
 * who built it. "JDSmartLearn" appears exactly once, at the bottom.
 */
function SchoolDoor({ brand }: { brand: SchoolBrand }) {
  /**
   * "" when ResultPeak is not configured, and then the row is not rendered at
   * all. See src/lib/partner-links.ts for why there is no third state.
   */
  const results = resultPeakSchoolUrl(brand.slug);

  return (
    <div className="min-h-dvh">
      <main className="mx-auto max-w-app px-5 py-12 sm:py-16">
        <div className="flex items-center gap-4">
          <SchoolMark brand={brand} size="lg" />
          <div className="min-w-0">
            <h1 className="text-title leading-tight">{brand.name}</h1>
            <p className="mt-1 text-sm text-muted">Lessons and schoolwork</p>
          </div>
        </div>

        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <CardLink href="/student" className="group">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-successSoft text-successText">
              <StudentIcon />
            </span>
            <span className="mt-4 block text-subheading font-semibold">
              I&rsquo;m a student
            </span>
            <span className="mt-1 block text-sm text-muted">
              Read your lessons and answer your work, with or without internet.
            </span>
            <span className="mt-3 block text-sm font-medium text-accentText">
              Open my lessons <Arrow />
            </span>
          </CardLink>

          {/* Staff get a door of their own here, which they never had. Both
              audiences arrive on the same school link, and before this the link
              sent everyone to the child's sign-in form. */}
          <CardLink href="/tutor" className="group">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brandSoft text-brand">
              <TeacherIcon />
            </span>
            <span className="mt-4 block text-subheading font-semibold">
              I&rsquo;m a teacher or admin
            </span>
            <span className="mt-1 block text-sm text-muted">
              Upload a lesson and publish a study guide to your class.
            </span>
            <span className="mt-3 block text-sm font-medium text-brand">
              Start a lesson <Arrow />
            </span>
          </CardLink>
        </div>

        {results && (
          <section className="mt-12 border-t border-line pt-8">
            {/* Framed as the school's own second service, not as another
                company's product. Same link as before; the words are the whole
                change, and they are most of what stops this reading as a
                hand-off to a third party. */}
            <h2 className="text-eyebrow font-semibold uppercase text-muted">
              Also from {brand.shortName}
            </h2>
            <a
              className="group mt-3 flex items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4 shadow-card transition-all hover:border-lineStrong hover:shadow-lift"
              href={results}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="min-w-0">
                <span className="block font-display text-subheading font-semibold">
                  Results and report cards
                </span>
                <span className="mt-0.5 block text-sm text-muted">
                  Exam scores and end-of-term reports.
                </span>
              </span>
              <span className="shrink-0 text-sm font-medium text-accentText">
                Open <Arrow />
              </span>
            </a>
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-app px-5 pb-12 text-sm text-muted">
        Lessons by JDSmartLearn, an Ilumotech product
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** The product's front door: nobody has told us which school this is. */
function ProductDoor() {
  // "" when ResultPeak is not configured, and then the row below is not rendered
  // at all. See src/lib/partner-links.ts for why there is no third state.
  const resultPeak = resultPeakStaffUrl();

  return (
    <div className="min-h-dvh">
      <main className="mx-auto max-w-app px-5 py-14 sm:py-20">
        <Wordmark size="lg" endorsement />

        <h1 className="mt-10 max-w-[18ch] text-display">
          Upload a lesson. Get a study guide back.
        </h1>
        <p className="mt-4 max-w-readable text-lg text-muted">
          A summary, practice questions and a marking guide, written from your own lesson
          in minutes. You review and edit everything before your class sees it.
        </p>

        {/* Two doors. The teacher's is primary - a teacher has to publish before
            a student has anything to open. */}
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          <CardLink href="/tutor" className="group">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-brandSoft text-brand">
              <TeacherIcon />
            </span>
            <span className="mt-4 block text-subheading font-semibold">I&rsquo;m a teacher</span>
            <span className="mt-1 block text-sm text-muted">
              Upload a lesson and publish a study guide to your class.
            </span>
            <span className="mt-3 block text-sm font-medium text-brand">
              Start a lesson <Arrow />
            </span>
          </CardLink>

          <CardLink href="/student" className="group">
            <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-successSoft text-successText">
              <StudentIcon />
            </span>
            <span className="mt-4 block text-subheading font-semibold">I&rsquo;m a student</span>
            <span className="mt-1 block text-sm text-muted">
              Read your lessons and answer your work, with or without internet.
            </span>
            <span className="mt-3 block text-sm font-medium text-accentText">
              Open my lessons <Arrow />
            </span>
          </CardLink>
        </div>

        {resultPeak && (
          <section className="mt-14 border-t border-line pt-8">
            <h2 className="text-eyebrow font-semibold uppercase text-muted">
              More from Ilumotech
            </h2>
            {/* An external product on another domain, so a plain anchor rather
                than next/link, which is for routes inside this app. */}
            <a
              className="group mt-3 flex items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4 shadow-card transition-all hover:border-lineStrong hover:shadow-lift"
              href={resultPeak}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="min-w-0">
                <span className="block font-display text-subheading font-semibold">
                  ResultPeak
                </span>
                <span className="mt-0.5 block text-sm text-muted">
                  Exams, scores and report cards.
                </span>
              </span>
              <span className="shrink-0 text-sm font-medium text-accentText">
                Open <Arrow />
              </span>
            </a>
          </section>
        )}
      </main>

      <footer className="mx-auto max-w-app px-5 pb-12 text-sm text-muted">
        an Ilumotech product
      </footer>
    </div>
  );
}

/* Inline SVG rather than an icon package: three icons do not justify a
   dependency, and these ship as markup with no client JS. */

function Arrow() {
  return (
    <svg
      className="inline-block h-3.5 w-3.5 align-[-1px] transition-transform group-hover:translate-x-0.5"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
    >
      <path
        d="M3 8h9m0 0L8.5 4.5M12 8l-3.5 3.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TeacherIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M2.5 5.5h6a2 2 0 0 1 2 2v8a2 2 0 0 0-2-2h-6v-8Zm15 0h-6a2 2 0 0 0-2 2v8a2 2 0 0 1 2-2h6v-8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StudentIcon() {
  return (
    <svg className="h-5 w-5" viewBox="0 0 20 20" fill="none" aria-hidden>
      <path
        d="M10 3.5 18 7l-8 3.5L2 7l8-3.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M5.5 8.75V13c0 .9 2 2 4.5 2s4.5-1.1 4.5-2V8.75"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
