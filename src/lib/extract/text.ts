import "server-only";
import { isReadableType } from "@/lib/storage/file-types";

/**
 * Text out of a document, in memory. This module never stores anything: the
 * ORIGINAL file is kept separately in R2 by the upload routes, through
 * storage/provider.ts, and the text is kept beside it as the student-facing
 * default on a slow link.
 *
 * Every parser is imported lazily, inside the branch that needs it, so a page
 * that only wants MIN_USABLE_CHARS does not load a Word parser to read a number.
 */

export const MIN_USABLE_CHARS = 200;
export const MAX_STORED_CHARS = 800_000; // stay clear of Firestore's 1MB doc cap

/**
 * Files over this are kept as originals without reading text from them.
 * pdf-parse holds the whole document in memory, and a 100 MB scan would spend
 * the function's time budget only to find there is no text in it.
 */
export const EXTRACT_MAX_BYTES = 25 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 25_000;

export class ExtractionError extends Error {}

async function readText(buffer: Buffer, name: string): Promise<string> {
  const lower = name.toLowerCase();
  let text = "";
  if (lower.endsWith(".pdf")) {
    const { default: pdfParse } = await import("pdf-parse");
    text = (await pdfParse(buffer)).text;
  } else if (lower.endsWith(".docx")) {
    const { default: mammoth } = await import("mammoth");
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (lower.endsWith(".doc")) {
    // Legacy Word. Common in schools: a scheme of work typed years ago and
    // passed down still arrives as .doc.
    const { default: WordExtractor } = await import("word-extractor");
    text = (await new WordExtractor().extract(buffer)).getBody();
  } else if (lower.endsWith(".txt")) {
    text = buffer.toString("utf8");
  } else {
    throw new ExtractionError("Upload a PDF, Word, or text file.");
  }
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * STRICT: throws with a message a person can act on. Used where text is the
 * whole point - grading a student's attached answer.
 */
export async function extractText(file: File): Promise<string> {
  const text = await readText(Buffer.from(await file.arrayBuffer()), file.name);

  if (text.length < MIN_USABLE_CHARS) {
    throw new ExtractionError(
      "We couldn't read text from this file - it may be a scan. Paste the lesson text instead."
    );
  }
  if (text.length > MAX_STORED_CHARS) {
    throw new ExtractionError("This lesson is too long. Split it into two lessons.");
  }
  return text;
}

/**
 * BEST EFFORT: never throws, returns "" when there is no usable text.
 *
 * Used for a tutor's upload, where the original is kept whatever happens and
 * text is a bonus. A scanned PDF, a slide deck, a spreadsheet or a photo is
 * still a working lesson or scheme of work: students open the original. The
 * reason is logged rather than returned, because every caller shows the tutor
 * the same thing - "we couldn't read text from this file" - whatever it was.
 *
 * `load` is only called when the file is worth reading, so a 100 MB deck is
 * never pulled into memory to learn nothing.
 */
export async function tryExtractText(
  name: string,
  size: number,
  load: () => Promise<Buffer | null>
): Promise<string> {
  if (!isReadableType(name)) return "";
  if (size > EXTRACT_MAX_BYTES) {
    console.warn(`[extract] ${name}: ${size} bytes, over the read limit - original kept`);
    return "";
  }
  try {
    const buffer = await load();
    if (!buffer) return "";
    const timedOut = Symbol("timeout");
    const text = await Promise.race([
      readText(buffer, name),
      new Promise<typeof timedOut>((resolve) =>
        setTimeout(() => resolve(timedOut), EXTRACT_TIMEOUT_MS)
      ),
    ]);
    if (text === timedOut) {
      console.warn(`[extract] ${name}: timed out - original kept`);
      return "";
    }
    if (text.length < MIN_USABLE_CHARS || text.length > MAX_STORED_CHARS) {
      console.warn(`[extract] ${name}: ${text.length} characters - original kept, no text`);
      return "";
    }
    return text;
  } catch (err) {
    console.warn(`[extract] ${name}: unreadable - original kept`, err);
    return "";
  }
}
