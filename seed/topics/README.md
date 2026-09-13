# Topic seed data

Human-authored curriculum structure. **Never AI-generated at runtime** - this is
the trust anchor teachers check first, and errors are highly visible to anyone
who knows the syllabus.

## Rules

1. Seed only the subjects and levels the pilot school actually teaches.
   Do not build the full catalogue speculatively - template authoring is the
   hidden cost centre of this product.
2. `topicId` is **permanent**. ResultPeak exam questions will be tagged with
   these ids. Never regenerate them on reseed - the seed script upserts by id.
3. `subjectId` must match the slugified id in `schools/{schoolId}.subjects[]`,
   because that is the join key ResultPeak already uses.

## File naming

`<level>-<subjectId>.json` e.g. `SS2-biology.json`, `P4-basic-science.json`

`<level>` is one of `PN` (pre-nursery), `N1`–`N3`, `P1`–`P6`, `JSS1`–`JSS3`,
`SS1`–`SS3`. The list is `LEVEL_LABELS` in `src/lib/class-level.ts`.
