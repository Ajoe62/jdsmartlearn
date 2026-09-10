# Retiring `studentLogins` — scheduled for v0.2.0

`studentLogins` is JDSmartLearn's old student-username alias collection. As of
the username cutover (2026-09-10) **nothing in this repo writes to it**, so it
has stopped growing, and exactly one code path still reads it. This note is the
whole of the remaining work.

## Why it is still here at all

ResultPeak now owns the student username: it writes
`studentAccess/{studentId}.username` and the reservation
`studentUsernames/{schoolId}_{username}` in the same batch that creates the
student. `resolveUsername()` reads those two first.

Branch 3 of `resolveUsername()` still falls back to `studentLogins`, and that
branch is the entire reason for the delay. **At CAPSTONE ACADEMY
(`U9SJpzzKUtF6S9V8cG7D`) thirty children are signed in today with a JD-minted
username** — `jss1-01`…`jss1-05`, `jss2-01`…`jss2-03`, `jss3-01`…`jss3-08`,
`ss2-01`…`ss2-14`. Deleting the branch in the same release as the cutover would
have locked all thirty out in the same hour.

## The condition for doing it — MEASURED 2026-09-10, and already met

Every username in circulation must exist in ResultPeak. ResultPeak's repair task
(`docs/resultpeak-shared-login-prompt.md`, Task 6) imported these usernames into
`studentAccess` rather than generating new ones, and **that has already run.**

Audited against live Firestore on 2026-09-10, over all 36 `studentLogins`
documents (35 at CAPSTONE, 1 at `dV6zL3AEydAFJc3D3GrO`):

- **36 of 36 are shadowed by ResultPeak** — branch 1 or branch 2 resolves them.
- **0 are resolvable only by branch 3.** The fallback resolves nobody today.

So the deletion is safe on the schedule, not merely eventually. Re-run the audit
before doing it rather than trusting this number: a school onboarded in between
cannot add rows here (nothing writes to the collection any more), but confirming
costs one query.

### Four rows disagree, and branch 3 is not what saves them

Four CAPSTONE aliases map to a **different child** than ResultPeak does — a
four-way rotation, almost certainly from the JD minting order differing from the
office's roster order:

| username | old JD card | office sheet (authoritative) |
| --- | --- | --- |
| `jss3-10` | Helen Alex | Jonathan Emmanuella |
| `jss3-11` | Jonathan Emmanuella | Joshua Orobator |
| `jss3-12` | Joshua Orobator | Osamede Success |
| `jss3-13` | Osamede Success | Helen Alex |

**This is the two-registry bug itself, not a regression from fixing it**, and
reordering the branches to "rescue" these four is exactly the wrong move: it
would put JDSmartLearn back into disagreement with the school office.

Nobody is impersonated. A child typing their old username reaches a classmate's
record, and `verifyStudentCode()` then rejects their own access code against it,
so the failure is a lockout and never a wrong sign-in. **The fix is operational:
reprint `/tutor/sign-ins` for JSS 3 and hand out the new cards.** That page now
prints ResultPeak's own values, so the reprint and the office sheet agree by
construction.

## The four deletions

1. Branch 3 of `resolveUsername()` in `src/lib/db/student-logins.ts`, and the
   `StudentLogin` import with it.
2. `JD.studentLogins` in `src/lib/db/collections.ts`.
3. Its entry in `src/lib/db/purge-plan.ts` (search `studentLogins`). Do this
   **only after** the documents are gone — until then the purge plan is what
   sweeps them when a school is deleted.
4. The `StudentLogin` interface in `src/types/index.ts`.

Then delete the documents themselves, and remove the `match /studentLogins/{id}`
block from `docs/firestore-rules-to-append.md` so ResultPeak drops it on their
next rules PR. That block is `allow read, write: if false`, so leaving it in
place for a while is harmless — a stale deny is never the urgent half.

## What does not change

Nothing on the ResultPeak side. This is a deletion in one repo of a collection
only that repo ever wrote.
