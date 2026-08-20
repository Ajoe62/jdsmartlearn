"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { classesForSubject, subjectsForClass } from "@/lib/auth/subject-access";
import { CONTROL } from "@/components/ui/Field";
import { SUBMITTABLE_TYPES } from "@/lib/storage/file-types";
import { RESULTPEAK_TERMS } from "@/lib/academic-calendar";
import { ASSIGNMENT_TYPES, ASSIGNMENT_TYPE_LABELS } from "@/types/student-dashboard";
import type { AssignmentType } from "@/types/student-dashboard";

type ClassOpt = { id: string; name: string };
type SubjectOpt = { id: string; name: string };
type LessonOpt = { id: string; title: string; classId: string; subjectId: string };

const MIN_GUIDE = 20;

/**
 * Deliberately online-only, unlike the new lesson form.
 *
 * A queued assignment cannot announce itself to a class, and a due date set
 * offline on Monday that uploads on Thursday may already have passed. Setting
 * work is a scheduled act; writing a lesson is not. Tutors keep full offline
 * access to marking, which is the part that happens at home in the evening.
 */
export default function NewAssignmentForm({
  classes,
  subjects,
  teachable,
  lessons,
  defaultTerm,
  defaultSession,
  knownSessions,
  filesAvailable,
}: {
  classes: ClassOpt[];
  subjects: SubjectOpt[];
  /** subjectId -> classIds. `{}` means no restriction - see subject-access. */
  teachable: Record<string, string[]>;
  lessons: LessonOpt[];
  /** Prefilled from the school setting. Never blank. */
  defaultTerm: string;
  defaultSession: string;
  /** The only sessions this school may pick. Never a free-text input. */
  knownSessions: string[];
  filesAvailable: boolean;
}) {
  const router = useRouter();
  const [classId, setClassId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<AssignmentType>("written");
  const [due, setDue] = useState("");
  const [maxMarks, setMaxMarks] = useState("20");
  const [term, setTerm] = useState(defaultTerm);
  const [session, setSession] = useState(defaultSession);
  const [markingGuide, setMarkingGuide] = useState("");
  const [linkedLessonId, setLinkedLessonId] = useState("");
  const [fileTypes, setFileTypes] = useState<string[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const lessonOptions = useMemo(
    () => lessons.filter((l) => l.classId === classId && l.subjectId === subjectId),
    [lessons, classId, subjectId]
  );

  /**
   * Both directions of the allocation, so the pickers narrow each other. `{}`
   * leaves both lists whole, which is the unallocated tutor and the admin.
   */
  const classOptions = useMemo(
    () => classesForSubject(teachable, classes, subjectId),
    [teachable, classes, subjectId]
  );
  const subjectOptions = useMemo(
    () => subjectsForClass(teachable, subjects, classId),
    [teachable, subjects, classId]
  );

  function toggleFileType(ext: string) {
    setFileTypes((current) =>
      current.includes(ext) ? current.filter((t) => t !== ext) : [...current, ext]
    );
  }

  const guideShort = markingGuide.trim().length < MIN_GUIDE;
  const ready =
    Boolean(classId && subjectId && title.trim() && due) && !guideShort && !busy;

  async function save() {
    setError(null);
    setBusy(true);

    // Datetime-local is a wall-clock string with no zone. new Date() reads it in
    // the phone's zone, which is the zone the tutor typed it in.
    const dueDate = new Date(due).getTime();
    if (!Number.isFinite(dueDate)) {
      setError("Choose a due date and time.");
      setBusy(false);
      return;
    }

    try {
      const res = await fetch("/api/tutor/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          classId,
          subjectId,
          title: title.trim(),
          description: description.trim(),
          type,
          dueDate,
          maxMarks: Number(maxMarks),
          term,
          session,
          markingGuide: markingGuide.trim(),
          linkedLessonId: linkedLessonId || null,
          allowedFileTypes: filesAvailable ? fileTypes : [],
          isActive,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        assignmentId?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "We couldn't save this assignment.");
      router.push("/tutor/assignments");
      router.refresh();
    } catch (err) {
      setError(
        err instanceof Error && navigator.onLine
          ? err.message
          : "You're offline. Connect to the internet to set an assignment."
      );
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-5">
      <label className="block">
        <span className="text-sm font-medium">Title</span>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Photosynthesis: short answers"
          className={CONTROL}
        />
      </label>

      <label className="block">
        <span className="text-sm font-medium">Class</span>
        <select
          value={classId}
          onChange={(e) => {
            const next = e.target.value;
            setClassId(next);
            setLinkedLessonId("");
            // Drop a subject this tutor does not teach in the new class, rather
            // than leaving a selection the server would refuse.
            if (subjectId && !subjectsForClass(teachable, subjects, next).some((s) => s.id === subjectId)) {
              setSubjectId("");
            }
          }}
          className={CONTROL}
        >
          <option value="">Choose a class</option>
          {classOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Subject</span>
        <select
          value={subjectId}
          onChange={(e) => {
            const next = e.target.value;
            setSubjectId(next);
            setLinkedLessonId("");
            if (classId && !classesForSubject(teachable, classes, next).some((c) => c.id === classId)) {
              setClassId("");
            }
          }}
          className={CONTROL}
        >
          <option value="">Choose a subject</option>
          {subjectOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Instructions for students</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="What should they do, and how should they answer?"
          className={CONTROL}
        />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium">Type</span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as AssignmentType)}
            className={CONTROL}
          >
            {ASSIGNMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {ASSIGNMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="text-sm font-medium">Term</span>
          <select value={term} onChange={(e) => setTerm(e.target.value)} className={CONTROL}>
            {RESULTPEAK_TERMS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-sm font-medium">Session</span>
        <select
          value={session}
          onChange={(e) => setSession(e.target.value)}
          className={CONTROL}
        >
          {knownSessions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-sm text-muted">
          Set by your school admin. Marks count towards this term and session even
          if the school moves on later.
        </span>
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-sm font-medium">Due</span>
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className={CONTROL}
          />
        </label>

        <label className="block">
          <span className="text-sm font-medium">Marks available</span>
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={maxMarks}
            onChange={(e) => setMaxMarks(e.target.value)}
            className={CONTROL}
          />
        </label>
      </div>

      <label className="block">
        <span className="text-sm font-medium">What should a correct answer include?</span>
        <span className="mt-1 block text-sm text-muted">
          The AI uses this to grade student work. Students never see it.
        </span>
        <textarea
          value={markingGuide}
          onChange={(e) => setMarkingGuide(e.target.value)}
          rows={6}
          placeholder="Name the two stages. Say where each happens in the leaf. Give one word equation."
          className={CONTROL}
        />
        {guideShort && markingGuide.length > 0 && (
          <span className="mt-1 block text-sm text-muted">
            A little more detail marks far better than a single line.
          </span>
        )}
      </label>

      <label className="block">
        <span className="text-sm font-medium">Follows a lesson (optional)</span>
        <select
          value={linkedLessonId}
          onChange={(e) => setLinkedLessonId(e.target.value)}
          disabled={!classId || !subjectId}
          className={`${CONTROL} disabled:opacity-50`}
        >
          <option value="">
            {!classId || !subjectId
              ? "Choose a class and subject first"
              : lessonOptions.length === 0
                ? "No published lessons in this subject yet"
                : "No lesson"}
          </option>
          {lessonOptions.map((l) => (
            <option key={l.id} value={l.id}>
              {l.title}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="rounded-lg border border-line bg-surface p-4">
        <legend className="px-1 text-sm font-medium">Students may attach</legend>
        {filesAvailable ? (
          <>
            <div className="mt-1 flex flex-wrap gap-3">
              {SUBMITTABLE_TYPES.map((ext) => (
                <label key={ext} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={fileTypes.includes(ext)}
                    onChange={() => toggleFileType(ext)}
                  />
                  {ext}
                </label>
              ))}
            </div>
            <p className="mt-2 text-sm text-muted">
              Leave all unticked for typed answers only. A student attaching a file
              needs a connection, so typed answers reach you from more phones.
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-muted">
            File storage is not set up, so students will type their answers.
          </p>
        )}
      </fieldset>

      <label className="flex items-center gap-3">
        <input
          type="checkbox"
          checked={isActive}
          onChange={(e) => setIsActive(e.target.checked)}
        />
        <span className="text-sm font-medium">
          Show this to the class now
          <span className="block font-normal text-muted">
            Turn it off to save it and release it later.
          </span>
        </span>
      </label>

      {error && (
        <p role="alert" className="rounded-lg border border-line bg-canvas p-3 text-sm">
          {error}
        </p>
      )}

      <Button onClick={save} disabled={!ready} size="lg" full>
        {busy ? "Saving" : "Save assignment"}
      </Button>
    </div>
  );
}
