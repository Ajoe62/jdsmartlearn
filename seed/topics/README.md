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
