import "server-only";
import mammoth from "mammoth";

/**
 * Files are parsed in memory and DISCARDED. Nothing is written to a bucket -
 * this is what keeps the project off the Blaze plan. Do not add storage.
 */

export const MIN_USABLE_CHARS = 200;
export const MAX_STORED_CHARS = 800_000; // stay clear of Firestore's 1MB doc cap

export class ExtractionError extends Error {}

export async function extractText(file: File): Promise<string> {
  const buffer = Buffer.from(await file.arrayBuffer());
  const name = file.name.toLowerCase();

  let text = "";
  if (name.endsWith(".pdf")) {
    const { default: pdfParse } = await import("pdf-parse");
    text = (await pdfParse(buffer)).text;
  } else if (name.endsWith(".docx")) {
    text = (await mammoth.extractRawText({ buffer })).value;
  } else if (name.endsWith(".txt")) {
    text = buffer.toString("utf8");
  } else {
    throw new ExtractionError("Upload a PDF, Word (.docx), or text file.");
  }

  text = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

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
