"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { newLocalId, queueOp } from "@/lib/offline/tutor-outbox";
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
}: {
  classes: ClassOpt[];
  subjects: SubjectOpt[];
  topics: TopicOpt[];
}) {
  const router = useRouter();
  const [classId, setClassId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [topicId, setTopicId] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"paste" | "upload">("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [online, setOnline] = useState(true);

  /**
   * Offline, only pasted text can be composed.
   *
   * Text validates on the device against the same 200-character floor the server
   * uses, so the tutor gets real feedback with no signal. A file cannot: extraction
   * happens server-side, so they would only learn a PDF was an unreadable scan days
   * later when it uploaded. Better to say so up front than to accept work we cannot
   * check (see docs/OFFLINE-FIRST.md).
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

  const contentReady = mode === "paste" ? text.trim().length >= MIN_CHARS : !!file;
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
        : "choose a file"
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);

    // No signal: queue it and let the outbox upload it on reconnect. className and
    // subjectId are omitted deliberately - the server derives both, so a queued op
    // replayed days later cannot carry a stale class name.
    if (!online) {
      const ok = await queueOp({
        kind: "create",
        target: newLocalId(),
        title: title.trim(),
        classId,
        topicId,
        text,
      });
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
      if (mode === "paste") form.set("text", text);
      else if (file) form.set("file", file);

      const res = await fetch("/api/lessons", { method: "POST", body: form });
      const data = (await res.json().catch(() => ({}))) as {
        lessonId?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "We couldn't create this lesson.");
      router.push("/tutor");
    } catch (err) {
      // The request itself failed rather than being rejected - if the link died
      // mid-submit, keep the work instead of making them retype it.
      if (!navigator.onLine) {
        const ok = await queueOp({
          kind: "create",
          target: newLocalId(),
          title: title.trim(),
          classId,
          topicId,
          text,
        });
        if (ok) {
          router.push("/tutor");
          return;
        }
      }
      setError(err instanceof Error ? err.message : "We couldn't create this lesson.");
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 space-y-5">
      {!online && (
        <div
          role="status"
          className="rounded-lg border border-line bg-paper px-4 py-3 text-sm"
        >
          <p className="font-medium">You&rsquo;re offline</p>
          <p className="mt-1 text-slate">
            You can still write this lesson. It will upload when you&rsquo;re back
            online, and you can create the study materials then.
          </p>
        </div>
      )}

      <label className="block">
        <span className="text-sm font-medium">Class</span>
        <select
          value={classId}
          onChange={(e) => {
            setClassId(e.target.value);
            setTopicId(""); // level may change, invalidating the topic
          }}
          className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2"
        >
          <option value="">Choose a class</option>
          {classes.map((c) => (
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
            setSubjectId(e.target.value);
            setTopicId("");
          }}
          className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2"
        >
          <option value="">Choose a subject</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-sm font-medium">Topic</span>
        <select
          value={topicId}
          onChange={(e) => chooseTopic(e.target.value)}
          disabled={!subjectId}
          className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2 disabled:opacity-50"
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
      </label>

      {subjectId && !showAddTopic && (
        online ? (
          <button
            type="button"
            onClick={() => setShowAddTopic(true)}
            className="text-sm font-medium text-marker"
          >
            + Add your own topic
          </button>
        ) : (
          // Creating a topic writes to Firestore immediately, so it cannot be
          // queued - the lesson that follows needs a real topic id.
          <p className="text-xs text-slate">
            You&rsquo;ll need internet to add your own topic.
          </p>
        )
      )}

      {subjectId && showAddTopic && (
        <div className="rounded-lg border border-line bg-chalk p-4">
          <p className="text-sm font-medium">Add your own topic</p>

          <label className="mt-3 block">
            <span className="text-sm">Topic title</span>
            <input
              type="text"
              value={newTopicTitle}
              onChange={(e) => setNewTopicTitle(e.target.value)}
              placeholder="e.g. Photosynthesis"
              className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2"
            />
          </label>

          <div className="mt-3 flex gap-3">
            <label className="block flex-1">
              <span className="text-sm">Term</span>
              <select
                value={newTopicTerm}
                onChange={(e) => setNewTopicTerm(Number(e.target.value) as 1 | 2 | 3)}
                className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2"
              >
                <option value={1}>1st term</option>
                <option value={2}>2nd term</option>
                <option value={3}>3rd term</option>
              </select>
            </label>

            {!level && (
              <label className="block flex-1">
                <span className="text-sm">Class level</span>
                <select
                  value={newTopicLevel}
                  onChange={(e) => setNewTopicLevel(e.target.value as ClassLevel | "")}
                  className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2"
                >
                  <option value="">Choose a level</option>
                  {ALL_LEVELS.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          {addTopicError && (
            <p className="mt-3 rounded-lg bg-flagSoft px-3 py-2 text-sm text-flag">
              {addTopicError}
            </p>
          )}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={addTopic}
              disabled={addingTopic || newTopicTitle.trim().length < 3}
              className="rounded-lg bg-marker px-4 py-2 text-sm font-medium text-chalk hover:bg-markerDark disabled:opacity-50"
            >
              {addingTopic ? "Adding…" : "Add topic"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowAddTopic(false);
                setAddTopicError(null);
              }}
              className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-slate"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <label className="block">
        <span className="text-sm font-medium">Lesson title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Introduction to fractions"
          className="mt-1 w-full rounded-lg border border-line bg-chalk px-3 py-2"
        />
      </label>

      <div>
        <span className="text-sm font-medium">Lesson content</span>
        <div className="mt-1 flex gap-2">
          <button
            type="button"
            onClick={() => setMode("paste")}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              mode === "paste" ? "bg-markerSoft text-marker" : "border border-line text-slate"
            }`}
          >
            Paste text
          </button>
          <button
            type="button"
            onClick={() => setMode("upload")}
            disabled={!online}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
              mode === "upload" ? "bg-markerSoft text-marker" : "border border-line text-slate"
            }`}
          >
            Upload a file
          </button>
        </div>

        {!online && (
          <p className="mt-2 text-xs text-slate">
            You&rsquo;ll need internet to upload a file. We can only check a file can
            be read once it reaches us.
          </p>
        )}

        {mode === "paste" ? (
          <>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={8}
              placeholder="Paste the lesson here."
              className="mt-2 w-full rounded-lg border border-line bg-chalk px-3 py-2"
            />
            <p className="mt-1 text-xs text-slate">
              {text.trim().length < MIN_CHARS
                ? `At least ${MIN_CHARS} characters (${text.trim().length} so far).`
                : `${text.trim().length} characters.`}
            </p>
          </>
        ) : (
          <div className="mt-2">
            <input
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="w-full text-sm"
            />
            <p className="mt-1 text-xs text-slate">
              PDF, Word (.docx), or text file, up to 10 MB. Students can open the
              original file once you publish the material.
            </p>
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-flagSoft px-3 py-2 text-sm text-flag">{error}</p>
      )}

      <button
        onClick={submit}
        disabled={!canSubmit || busy}
        className="w-full rounded-lg bg-marker px-4 py-3 font-medium text-chalk hover:bg-markerDark disabled:opacity-50"
      >
        {online
          ? busy
            ? "Creating…"
            : "Create draft"
          : busy
            ? "Saving…"
            : "Save on my phone"}
      </button>

      {!canSubmit && missing.length > 0 && (
        <p className="text-center text-xs text-slate">
          {online ? "To create the draft: " : "To save this lesson: "}
          {missing.join(", ")}.
        </p>
      )}
    </div>
  );
}
