/**
 * word-extractor ships no types. Only the part lib/extract/text.ts uses: read a
 * legacy Word (.doc) buffer and take the body text.
 */
declare module "word-extractor" {
  class WordDocument {
    getBody(): string;
  }
  export default class WordExtractor {
    extract(source: string | Buffer): Promise<WordDocument>;
  }
}
