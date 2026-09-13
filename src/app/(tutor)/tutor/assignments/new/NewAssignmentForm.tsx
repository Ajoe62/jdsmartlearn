"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import FileUploadField, { type UploadedFile } from "@/components/tutor/FileUploadField";
import {
  classesForSubject,
  subjectsForClass,
  unmatchedState,
  type UnmatchedClasses,
} from "@/lib/auth/subject-access";
import UnmatchedClassNote from "@/components/tutor/UnmatchedClassNote";
import { CONTROL } from "@/components/ui/Field";
import {
  MAX_TUTOR_FILE_BYTES,
  SUBMITTABLE_TYPES,
  TUTOR_UPLOAD_LABEL,
  formatLimit,
} from "@/lib/storage/file-types";
import { readApiError } from "@/lib/upload-client";
import { RESULTPEAK_TERMS } from "@/lib/academic-calendar";
import { ASSIGNMENT_TYPES, ASSIGNMENT_TYPE_LABELS } from "@/types/student-dashboard";
import type { AssignmentType } from "@/types/student-dashboard";

type ClassOpt = { id: string; name: string };
type SubjectOpt = { id: string; name: string };
type LessonOpt = { id: string; title: string; classId: string; subjectId: string };

const MIN_GUIDE = 20;

/** "2026-09-11T14:30" in the phone's own zone - the format datetime-local takes. */
function localDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Deliberately online-only, unlike the new lesson form.
 *
 * A queued assignment cannot announce itself to a class, and a due date set
 * offline on Monday that uploads on Thursday may already have passed. Setting
 * work is a scheduled act; writing a lesson is not. Tutors keep full offline
 * access to marking, which is the part that happens at home in the evening.
 *
 * SAVE ALWAYS ANSWERS. It used to stay disabled until every field was right,
 * with nothing saying which one was not - most often the marking guide, which
 * needs 20 characters. Tutors reported it as a Save button that did nothing.
 * Now it saves, or it says exactly what is missing.
 */
export default function NewAssignmentForm({
  classes,
  subjects,
  teachable,
  unmatched,
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
  /** Held classes with no subject set for this tutor - see pickerAllocation(). */
  unmatched: UnmatchedClasses;
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
  const [sheet, setSheet] = useState<UploadedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Set after mount: the server's clock and zone are not the phone's.
  const [minDue, setMinDue] = useState<string | undefined>(undefined);

  useEffect(() => {
    setMinDue(localDateTime(new Date()));
  }, []);

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

  const guideLength = markingGuide.trim().length;

  /**
   * The chosen class has no subject set for this tutor in ResultPeak: "open"
   * lists every subject, "blocked" none. Either way the form says why, so the
   * subject box is never silently empty. See pickerAllocation().
   */
  const classGap = unmatchedState(unmatched, classId);
  const selectedClassName = classes.find((c) => c.id === classId)?.name ?? "";

  // Everything Save needs, in the words a teacher would use.
  const missing: string[] = [];
  if (!title.trim()) missing.push("add a title");
  if (!classId) missing.push("choose a class");
  if (!subjectId) {
    missing.push(classGap === "blocked" ? "choose a class you have subjects in" : "choose a subject");
  }
  if (!due) missing.push("choose a due date");
  if (guideLength < MIN_GUIDE) {
    missing.push(
      `write what a correct answer should include (at least ${MIN_GUIDE} characters, ${guideLength} so far)`
    );
  }
  if (uploading) missing.push("wait for the question sheet to finish uploading");

  async function save() {
    setError(null);

    if (missing.length > 0) {
      setError(`Before you save: ${missing.join(", ")}.`);
      return;
    }

    // Datetime-local is a wall-clock string with no zone. new Date() reads it in
    // the phone's zone, which is the zone the tutor typed it in.
    const dueDate = new Date(due).getTime();
    if (!Number.isFinite(dueDate)) {
      setError("Choose a due date and time.");
      return;
    }
    if (dueDate <= Date.now()) {
      setError("The due date has already passed. Pick a later one.");
      return;
    }

    setBusy(true);
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
          // The sheet itself is already in storage; this names it.
          ...(sheet ? { uploadKey: sheet.uploadKey, fileName: sheet.name } : {}),
        }),
      });
      if (!res.ok) throw new Error(await readApiError(res, "We couldn't save this assignment."));
      router.push("/tutor/assignments");
      router.refresh();
    } catch (err) {
      setError(
        !navigator.onLine
          ? "You're offline. Connect to the internet to set an assignment."
          : err instanceof TypeError
            ? "We couldn't reach the server. Check your connection and try again."
            : err instanceof Error
              ? err.message
              : "We couldn't save this assignment."
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
          disabled={classGap === "blocked"}
          className={CONTROL}
        >
          <option value="">
            {classGap === "blocked" ? "No subjects for this class" : "Choose a subject"}
          </option>
          {subjectOptions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      {classGap && selectedClassName && (
        <UnmatchedClassNote classLabel={selectedClassName} state={classGap} noun="work" />
      )}

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

      {filesAvailable && (
        <FileUploadField
          id="assignment-sheet"
          label="Question sheet (optional)"
          hint={`A file students open or download: ${TUTOR_UPLOAD_LABEL}, up to ${formatLimit(MAX_TUTOR_FILE_BYTES)}. Your marking guide is never part of it.`}
          purpose="assignment"
          value={sheet}
          onChange={setSheet}
          onBusyChange={setUploading}
          disabled={busy}
        />
      )}

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
            min={minDue}
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
          Required. The AI uses this to grade student work. Students never see it.
        </span>
        <textarea
          value={markingGuide}
          onChange={(e) => setMarkingGuide(e.target.value)}
          rows={6}
          placeholder="Name the two stages. Say where each happens in the leaf. Give one word equation."
          className={CONTROL}
        />
        <span className="mt-1 block text-sm text-muted">
          {guideLength < MIN_GUIDE
            ? `At least ${MIN_GUIDE} characters (${guideLength} so far).`
            : `${guideLength} characters. More detail marks better.`}
        </span>
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

      <div>
        <Button onClick={() => void save()} disabled={busy} size="lg" full>
          {busy ? "Saving…" : "Save assignment"}
        </Button>
        {missing.length > 0 && !error && (
          <p className="mt-2 text-center text-sm text-muted">To save: {missing.join(", ")}.</p>
        )}
      </div>
    </div>
  );
}
