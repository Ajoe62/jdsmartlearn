/**
 * Tests for the pure upload rules: what may be uploaded, how big, who may claim
 * an upload, how a file name is cleaned, and how a large file is cut into parts.
 *
 * These are the rules that stand between a crafted request and somebody else's
 * upload, and between a tutor's 90 MB scheme of work and a silent failure, so
 * they are asserted directly rather than only through a route.
 *
 *   npm run test:uploads
 *
 * Pure modules only - no R2, no Firestore, no `server-only`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SUBMISSION_FILE_BYTES,
  MAX_TUTOR_FILE_BYTES,
  SUBMITTABLE_TYPES,
  TUTOR_UPLOAD_TYPES,
  cleanFileName,
  extensionOf,
  isReadableType,
  maxBytesFor,
  rejectAttachment,
  rejectTutorUpload,
  uploadTypesFor,
} from "../src/lib/storage/file-types";
import {
  assignmentFileKey,
  lessonFileKey,
  ownsStagingKey,
  schemeFileKey,
  stagingKey,
  submissionAttachmentKey,
} from "../src/lib/storage/keys";
import {
  MAX_PARTS,
  PART_BYTES,
  SINGLE_PUT_MAX_BYTES,
  partCount,
  partRange,
  usesMultipart,
} from "../src/lib/storage/upload-plan";

const MB = 1024 * 1024;
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const BACKSLASH = String.fromCharCode(92);

test("tutors may upload every type the owner chose", () => {
  for (const ext of TUTOR_UPLOAD_TYPES) {
    assert.equal(rejectTutorUpload({ name: `scheme${ext}`, size: 1 }), null, ext);
  }
});

test("tutors may not upload programs, web pages, SVG, audio or video", () => {
  for (const name of [
    "setup.exe",
    "app.apk",
    "run.bat",
    "page.html",
    "page.htm",
    "logo.svg",
    "clip.mp4",
    "song.mp3",
    "code.js",
    "noextension",
  ]) {
    assert.notEqual(rejectTutorUpload({ name, size: 1 }), null, name);
  }
});

test("the tutor cap is 100 MB, inclusive, and an empty file is refused", () => {
  assert.equal(MAX_TUTOR_FILE_BYTES, 100 * MB);
  assert.equal(rejectTutorUpload({ name: "big.pdf", size: 100 * MB }), null);
  assert.match(rejectTutorUpload({ name: "big.pdf", size: 100 * MB + 1 }) ?? "", /larger than 100 MB/);
  assert.match(rejectTutorUpload({ name: "empty.pdf", size: 0 }) ?? "", /empty/);
});

test("students stay on the gradable list, 20 MB a file", () => {
  assert.deepEqual([...uploadTypesFor("submission")], [...SUBMITTABLE_TYPES]);
  assert.equal(maxBytesFor("submission"), MAX_SUBMISSION_FILE_BYTES);
  assert.equal(MAX_SUBMISSION_FILE_BYTES, 20 * MB);
  assert.equal(rejectAttachment({ name: "work.jpg", size: 20 * MB }, null), null);
  assert.notEqual(rejectAttachment({ name: "work.jpg", size: 20 * MB + 1 }, null), null);
  // A student cannot hand in a slide deck just because a tutor may upload one.
  assert.notEqual(rejectAttachment({ name: "slides.pptx", size: 1 }, null), null);
});

test("an assignment's own list still narrows what a student may attach", () => {
  assert.notEqual(rejectAttachment({ name: "photo.jpg", size: 1 }, [".pdf"]), null);
  assert.notEqual(rejectAttachment({ name: "photo.jpg", size: 1 }, []), null);
  assert.equal(rejectAttachment({ name: "answer.pdf", size: 1 }, [".pdf"]), null);
});

test("the extension is the LAST dot of the LAST path segment", () => {
  assert.equal(extensionOf("answer.pdf.exe"), ".exe");
  assert.equal(extensionOf("Scheme.DOCX"), ".docx");
  assert.equal(extensionOf("folder.v2/readme"), "");
  assert.equal(extensionOf(`folder.v2${BACKSLASH}readme`), "");
  assert.equal(extensionOf(".hidden"), "");
  assert.equal(extensionOf("noextension"), "");
});

test("text is read from PDF, Word and text files only", () => {
  for (const name of ["a.pdf", "a.doc", "a.docx", "a.txt"]) {
    assert.equal(isReadableType(name), true, name);
  }
  for (const name of ["a.pptx", "a.xlsx", "a.jpg"]) {
    assert.equal(isReadableType(name), false, name);
  }
});

test("a file name keeps its words and takes the stored extension", () => {
  // The regression that matters most: ordinary punctuation must survive.
  assert.equal(
    cleanFileName("My notes, week 3 (final) - v2.pdf", ".pdf"),
    "My notes, week 3 (final) - v2.pdf"
  );
  assert.equal(cleanFileName("uploads/Scheme 2026.docx", ".docx"), "Scheme 2026.docx");
  assert.equal(
    cleanFileName(`C:${BACKSLASH}Users${BACKSLASH}Scheme.docx`, ".docx"),
    "Scheme.docx"
  );
  assert.equal(cleanFileName("notes.pdf", ".docx"), "notes.pdf.docx");
  assert.equal(cleanFileName("", ".pdf"), "file.pdf");
  assert.equal(cleanFileName(undefined, ".pdf"), "file.pdf");
  assert.equal(
    cleanFileName(`a${String.fromCharCode(0)}b${String.fromCharCode(10)}.pdf`, ".pdf"),
    "ab.pdf"
  );
  const long = cleanFileName(`${"x".repeat(400)}.pdf`, ".pdf");
  assert.ok(long.length <= 150);
  assert.ok(long.endsWith(".pdf"));
});

test("a staging key can be claimed only by the person who made it", () => {
  const key = stagingKey("school1", "t-uid1", TOKEN, ".pdf");
  assert.equal(ownsStagingKey(key, "school1", "t-uid1"), true);
  assert.equal(ownsStagingKey(key, "school2", "t-uid1"), false, "another school");
  assert.equal(ownsStagingKey(key, "school1", "t-uid2"), false, "another tutor");
  assert.equal(ownsStagingKey(key, "school1", "t-uid"), false, "an id that prefixes the owner's");
  assert.equal(ownsStagingKey(key, "school1", "s-uid1"), false, "a student with the same id");
});

test("a staging key cannot smuggle a path or name a permanent object", () => {
  const owner = ["school1", "t-uid1"] as const;
  assert.equal(ownsStagingKey(stagingKey(...owner, `${TOKEN}/../x`, ".pdf"), ...owner), false);
  assert.equal(ownsStagingKey(stagingKey(...owner, "short", ".pdf"), ...owner), false);
  assert.equal(ownsStagingKey(stagingKey(...owner, TOKEN, ""), ...owner), false);
  assert.equal(ownsStagingKey(lessonFileKey("school1", "lesson1", ".pdf"), ...owner), false);
  assert.equal(ownsStagingKey(stagingKey("", "t-uid1", TOKEN, ".pdf"), "", "t-uid1"), false);
  assert.equal(
    ownsStagingKey(stagingKey("school/1", "t-uid1", TOKEN, ".pdf"), "school/1", "t-uid1"),
    false
  );
});

test("every key names its school, so a purge can be verified by prefix", () => {
  for (const key of [
    lessonFileKey("s1", "l1", ".pdf"),
    schemeFileKey("s1", "c1", ".pdf"),
    assignmentFileKey("s1", "a1", ".pdf"),
    submissionAttachmentKey("s1", "a1", "st1", 0, ".jpg"),
    stagingKey("s1", "t-u", TOKEN, ".pdf"),
  ]) {
    assert.ok(key.split("/").includes("s1"), key);
  }
});

test("small files go in one PUT, large ones in 8 MB parts", () => {
  assert.equal(usesMultipart(SINGLE_PUT_MAX_BYTES), false);
  assert.equal(usesMultipart(SINGLE_PUT_MAX_BYTES + 1), true);
  assert.equal(partCount(1), 1);
  assert.equal(partCount(PART_BYTES), 1);
  assert.equal(partCount(PART_BYTES + 1), 2);
  assert.equal(partCount(100 * MB), 13);
  assert.ok(partCount(MAX_TUTOR_FILE_BYTES) <= MAX_PARTS);
});

test("parts cover the file exactly, and only the last may be short", () => {
  // R2 refuses a multipart upload whose non-final parts differ in size.
  for (const size of [PART_BYTES + 1, 3 * PART_BYTES, 100 * MB, 37 * MB + 123]) {
    const n = partCount(size);
    let next = 0;
    for (let part = 1; part <= n; part++) {
      const { start, end } = partRange(size, part);
      assert.equal(start, next, `part ${part} of ${size} starts where the last ended`);
      if (part < n) assert.equal(end - start, PART_BYTES);
      else assert.ok(end - start > 0 && end - start <= PART_BYTES);
      next = end;
    }
    assert.equal(next, size);
  }
});
