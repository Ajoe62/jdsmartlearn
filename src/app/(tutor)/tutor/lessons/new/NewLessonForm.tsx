"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import Callout from "@/components/ui/Callout";
import { Card, CardHeader } from "@/components/ui/Card";
import Field, { CONTROL } from "@/components/ui/Field";
import FileUploadField, { type UploadedFile } from "@/components/tutor/FileUploadField";
import { classesForSubject, subjectsForClass } from "@/lib/auth/subject-access";
import { newLocalId, queueOp } from "@/lib/offline/tutor-outbox";
import {
  MAX_TUTOR_FILE_BYTES,
  TUTOR_UPLOAD_LABEL,
  formatLimit,
} from "@/lib/storage/file-types";
import { readApiError } from "@/lib/upload-client";
import type { ClassLevel } from "@/types";

type ClassOpt = { id: string; name: string; level?: ClassLevel };
type SubjectOpt = { id: string; name: string };
type TopicOpt = { id: string; subjectId: string; level: ClassLevel; title: string };

const MIN_CHARS = 200;

const ALL_LEVELS: ClassLevel[] = [
  "P1", "P2", "P3", "P4", "P5", "P6",
  "JSS1", "JSS2", "JSS3",
  "SS1", "SS2", "SS3",
];

export default function NewLessonForm({
  classes,
  subjects,
  topics,
  teachable,
  filesAvailable,
}: {
  classes: ClassOpt[];
  subjects: SubjectOpt[];
  topics: TopicOpt[];
  /** subjectId -> classIds. `{}` means no restriction - see subject-access. */
  teachable: Record<string, string[]>;
  /** False when R2 is not configured: the lesson must be pasted. */
  filesAvailable: boolean;
}) {
  const router = useRouter();
  const [classId, setClassId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"paste" | "upload">("paste");
  const [text, setText] = useState("");
  /** The file, once it has reached storage. Null while it is still uploading. */
  const [upload, setUpload] = useState<UploadedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);

  /**
   * Offline, only pasted text can be composed.
   *
   * Text validates on the device against the same 200-character floor the server
   * uses, so the tutor gets real feedback with no signal. A file cannot even
   * start: it goes straight to storage, which needs a connection, and the
   * outbox deliberately holds no files (see docs/OFFLINE-FIRST.md).
   */
  useEffect(() => {
    const sync = () => {
      const up = navigator.onLine;
      setOnline(up);
      if (!up) setMode("paste");
    };
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  // Topics the tutor created inline this session, on top of the server list.
  const [customTopics, setCustomTopics] = useState<TopicOpt[]>([]);
  const [showAddTopic, setShowAddTopic] = useState(false);
  const [newTopicTitle, setNewTopicTitle] = useState("");
  const [newTopicTerm, setNewTopicTerm] = useState<1 | 2 | 3>(1);
  const [newTopicLevel, setNewTopicLevel] = useState<ClassLevel | "">("");
  const [addingTopic, setAddingTopic] = useState(false);
  const [addTopicError, setAddTopicError] = useState<string | null>(null);

  const selectedClass = classes.find((c) => c.id === classId);
  const level = selectedClass?.level;

  /**
   * Both directions of the allocation, so the pickers narrow each other: pick a
   * class and only the subjects taught in it remain; pick a subject and only the
   * classes it is taught to remain. `teachable` is `{}` for an unallocated tutor
   * and then both lists stay whole.
   */
  const classOptions = useMemo(
    () => classesForSubject(teachable, classes, subjectId),
    [teachable, classes, subjectId]
  );
  const subjectOptions = useMemo(
    () => subjectsForClass(teachable, subjects, classId),
    [teachable, subjects, classId]
  );

  // Topics for the chosen subject, narrowed to the class's level when we know it.
  const topicOptions = useMemo(
    () =>
      [...topics, ...customTopics].filter(
        (t) => t.subjectId === subjectId && (level ? t.level === level : true)
      ),
    [topics, customTopics, subjectId, level]
  );

  async function addTopic() {
    const effectiveLevel = level ?? newTopicLevel;
    if (!effectiveLevel) {
      setAddTopicError("Choose a class level for this topic.");
      return;
    }
    setAddingTopic(true);
    setAddTopicError(null);
    try {
      const res = await fetch("/api/topics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subjectId,
          level: effectiveLevel,
          term: newTopicTerm,
          title: newTopicTitle.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        topic?: { id: string; subjectId: string; level: ClassLevel; title: string };
        error?: string;
      };
      if (!res.ok || !data.topic) {
        throw new Error(data.error ?? "We couldn't add that topic.");
      }
      const added: TopicOpt = {
        id: data.topic.id,
        subjectId: data.topic.subjectId,
        level: data.topic.level,
        title: data.topic.title,
      };
      setCustomTopics((ts) => [...ts, added]);
      setTopicId(added.id);
      if (!title.trim()) setTitle(added.title);
      setShowAddTopic(false);
      setNewTopicTitle("");
    } catch (err) {
      setAddTopicError(err instanceof Error ? err.message : "We couldn't add that topic.");
    } finally {
      setAddingTopic(false);
    }
  }

  function chooseTopic(id: string) {
    setTopicId(id);
    // Prefill the title from the topic, but let the tutor override it.
    const topic = topics.find((t) => t.id === id);
    if (topic && !title.trim()) setTitle(topic.title);
  }

  const contentReady = mode === "paste" ? text.trim().length >= MIN_CHARS : !!upload;
  const canSubmit = !!classId && !!subjectId && !!topicId && !!title.trim() && contentReady;

  // Tell the tutor exactly what's missing instead of a silently disabled button.
  const missing: string[] = [];
  if (!classId) missing.push("choose a class");
  if (!subjectId) missing.push("choose a subject");
  if (!topicId) missing.push("choose a topic");
  if (!title.trim()) missing.push("add a title");
  if (!contentReady) {
    missing.push(
      mode === "paste"
        ? `paste at least ${MIN_CHARS} characters (${text.trim().length} so far)`
        : uploading
          ? "wait for the file to finish uploading"
          : "choose a file"
    );
  }

  async function queueOffline(): Promise<boolean> {
    // className and subjectId are omitted deliberately - the server derives
    // both, so a queued op replayed days later cannot carry a stale class name.
    return queueOp({
      kind: "create",
      target: newLocalId(),
      title: title.trim(),
      classId,
      topicId,
      text,
    });
  }

  async function submit() {
    setBusy(true);
    setError(null);

    // No signal: queue it and let the outbox upload it on reconnect.
    if (!online) {
      const ok = await queueOffline();
      if (!ok) {
        setError(
          "This phone can't save work offline. Connect to the internet and try again."
        );
        setBusy(false);
        return;
      }
      router.push("/tutor");
      return;
    }

    try {
      const form = new FormData();
      form.set("classId", classId);
      form.set("topicId", topicId);
      form.set("title", title.trim());
      if (mode === "paste") {
        form.set("text", text);
      } else if (upload) {
        // The file itself is already in storage; this names it.
        form.set("uploadKey", upload.uploadKey);
        form.set("fileName", upload.name);
      }

      const res = await fetch("/api/lessons", { method: "POST", body: form });
      if (!res.ok) throw new Error(await readApiError(res, "We couldn't create this lesson."));
      const data = (await res.json().catch(() => ({}))) as {
        lessonId?: string;
        textFound?: boolean;
      };
      // No readable text in the file: open the lesson, which says what to do next.
      router.push(
        data.lessonId && data.textFound === false ? `/tutor/lessons/${data.lessonId}` : "/tutor"
      );
    } catch (err) {
      // The request itself failed rather than being rejected - if the link died
      // mid-submit, keep typed work instead of making them retype it. An
      // uploaded file cannot be queued, and does not need to be: it is already
      // in storage, so Create draft works again once the signal is back.
      if (!navigator.onLine && mode === "paste") {
        if (await queueOffline()) {
          router.push("/tutor");
          return;
        }
      }
      setError(
        err instanceof TypeError
          ? "We couldn't reach the server. Check your connection and try again."
          : err instanceof Error
            ? err.message
            : "We couldn't create this lesson."
      );
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 space-y-5">
      {!online && (
        <Callout tone="neutral" title="You're offline">
          You can still write this lesson. It will upload when you&rsquo;re back online,
          and you can create the study materials then.
        </Callout>
      )}

      {/* Step one: where the lesson goes. Kept apart from the lesson itself so a
          teacher doing this for the first time meets three short questions
          before a blank text box, not all of it at once. */}
      <Card>
        <CardHeader title="Which class is this for?" />
        <div className="space-y-4 p-4">
          <Field label="Class" htmlFor="lesson-class">
            <select
              id="lesson-class"
              value={classId}
              onChange={(e) => {
                const next = e.target.value;
                setClassId(next);
                setTopicId(""); // level may change, invalidating the topic
                // Drop a subject this tutor does not teach in the new class,
                // rather than leaving a selection the server would refuse.
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
          </Field>

          <Field label="Subject" htmlFor="lesson-subject">
            <select
              id="lesson-subject"
              value={subjectId}
              onChange={(e) => {
                const next = e.target.value;
                setSubjectId(next);
                setTopicId("");
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
          </Field>

          <Field label="Topic" htmlFor="lesson-topic">
            <select
              id="lesson-topic"
              value={topicId}
              onChange={(e) => chooseTopic(e.target.value)}
              disabled={!subjectId}
              className={CONTROL}
            >
              <option value="">
                {!subjectId
                  ? "Choose a subject first"
                  : topicOptions.length === 0
                    ? "No topics for this subject and class"
                    : "Choose a topic"}
              </option>
              {topicOptions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </Field>

          {subjectId && !showAddTopic && (
            online ? (
              <Button variant="ghost" onClick={() => setShowAddTopic(true)}>
                + Add your own topic
              </Button>
            ) : (
              // Creating a topic writes to Firestore immediately, so it cannot be
              // queued - the lesson that follows needs a real topic id.
              <p className="text-sm text-muted">
                You&rsquo;ll need internet to add your own topic.
              </p>
            )
          )}

          {subjectId && showAddTopic && (
            <div className="rounded-lg border border-line bg-canvas p-4">
              <p className="font-medium">Add your own topic</p>

              <div className="mt-3 space-y-3">
                <Field label="Topic title" htmlFor="new-topic-title">
                  <input
                    id="new-topic-title"
                    type="text"
                    value={newTopicTitle}
                    onChange={(e) => setNewTopicTitle(e.target.value)}
                    placeholder="e.g. Photosynthesis"
                    className={CONTROL}
                  />
                </Field>

                <div className="flex gap-3">
                  <Field label="Term" htmlFor="new-topic-term" className="flex-1">
                    <select
                      id="new-topic-term"
                      value={newTopicTerm}
                      onChange={(e) => setNewTopicTerm(Number(e.target.value) as 1 | 2 | 3)}
                      className={CONTROL}
                    >
                      <option value={1}>1st term</option>
                      <option value={2}>2nd term</option>
                      <option value={3}>3rd term</option>
                    </select>
                  </Field>

                  {!level && (
                    <Field label="Class level" htmlFor="new-topic-level" className="flex-1">
                      <select
                        id="new-topic-level"
                        value={newTopicLevel}
                        onChange={(e) => setNewTopicLevel(e.target.value as ClassLevel | "")}
                        className={CONTROL}
                      >
                        <option value="">Choose a level</option>
                        {ALL_LEVELS.map((l) => (
                          <option key={l} value={l}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                </div>
              </div>

              {addTopicError && (
                <Callout tone="danger" className="mt-3">
                  {addTopicError}
                </Callout>
              )}

              <div className="mt-4 flex gap-2">
                <Button
                  onClick={addTopic}
                  disabled={addingTopic || newTopicTitle.trim().length < 3}
                >
                  {addingTopic ? "Adding…" : "Add topic"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowAddTopic(false);
                    setAddTopicError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Step two: the lesson itself. */}
      <Card>
        <CardHeader title="Your lesson" />
        <div className="space-y-4 p-4">
          <Field label="Lesson title" htmlFor="lesson-title">
            <input
              id="lesson-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Introduction to fractions"
              className={CONTROL}
            />
          </Field>

          <div>
            <span className="text-sm font-medium">Lesson content</span>
            <div className="mt-1.5 flex gap-2" role="tablist" aria-label="Lesson content">
              <ModeTab
                active={mode === "paste"}
                onClick={() => setMode("paste")}
                label="Paste text"
              />
              <ModeTab
                active={mode === "upload"}
                onClick={() => setMode("upload")}
                disabled={!online || !filesAvailable}
                label="Upload a file"
              />
            </div>

            {!online ? (
              <p className="mt-2 text-sm text-muted">
                You&rsquo;ll need internet to upload a file. It goes straight to your
                school&rsquo;s file storage.
              </p>
            ) : (
              !filesAvailable && (
                <p className="mt-2 text-sm text-muted">
                  File uploads aren&rsquo;t set up for your school yet. Paste the lesson
                  text instead.
                </p>
              )
            )}

            {mode === "paste" ? (
              <>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={8}
                  placeholder="Paste the lesson here."
                  aria-label="Lesson text"
                  className={`${CONTROL} mt-2`}
                />
                <p className="mt-1.5 text-sm text-muted">
                  {text.trim().length < MIN_CHARS
                    ? `At least ${MIN_CHARS} characters (${text.trim().length} so far).`
                    : `${text.trim().length} characters.`}
                </p>
              </>
            ) : (
              <div className="mt-2">
                <FileUploadField
                  id="lesson-file"
                  label="Lesson file"
                  hint={`${TUTOR_UPLOAD_LABEL}, up to ${formatLimit(MAX_TUTOR_FILE_BYTES)}. We read the text from PDF and Word files. Students can open the original once you publish the material.`}
                  purpose="lesson"
                  value={upload}
                  onChange={setUpload}
                  onBusyChange={setUploading}
                  disabled={busy}
                />
              </div>
            )}
          </div>
        </div>
      </Card>

      {error && <Callout tone="danger" title="That didn't work">{error}</Callout>}

      <div>
        <Button onClick={submit} disabled={!canSubmit || busy} size="lg" full>
          {online
            ? busy
              ? "Creating…"
              : "Create draft"
            : busy
              ? "Saving…"
              : "Save on my phone"}
        </Button>

        {/* Say what is missing rather than leaving a dead button unexplained. */}
        {!canSubmit && missing.length > 0 && (
          <p className="mt-2 text-center text-sm text-muted">
            {online ? "To create the draft: " : "To save this lesson: "}
            {missing.join(", ")}.
          </p>
        )}
      </div>
    </div>
  );
}

/** The paste/upload switch. A segmented control, not two loose buttons. */
function ModeTab({
  active,
  onClick,
  disabled,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      disabled={disabled}
      className={
        "min-h-[44px] rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:opacity-50 " +
        (active
          ? "bg-brand text-white"
          : "border border-line bg-surface text-muted hover:border-lineStrong")
      }
    >
      {label}
    </button>
  );
}
