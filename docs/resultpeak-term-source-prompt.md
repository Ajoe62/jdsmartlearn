# Prompt to run in the ResultPeak repo: one source for the current term

Copy everything below the line into a fresh Claude Code session opened in the
**ResultPeak** repository. It is the follow-up to ResultPeak's own
`docs/jdsmartlearn-stamp-current-term-prompt.md`, which JDSmartLearn has now
done.

**Ordering.** JDSmartLearn has shipped its side. The fallback removal below
should ship **before `LMS_FILE_BY_MARK_TERM=on` is set**. The late-marks switch
does not depend on it for correctness at any school that has set its School
profile term, but it closes the one path left that reads a value nobody
maintains any more.

---

## Context

You are working in **ResultPeak**, live with paying schools. **JDSmartLearn**
(an LMS) runs in the same Firebase project and reads ResultPeak's collections
without writing them.

Your `resolveSchoolCalendar()` (`src/lib/academicCalendar.js`) decides the
current term from `schools/{schoolId}.currentTerm` and `.currentSession`, and,
if the school never set those, falls back to the term and session an admin
typed into JDSmartLearn's settings (`jdSchoolSettings/{schoolId}.term` and
`.session`).

**As of 2026-11-26 JDSmartLearn no longer reads or writes those two fields.**
It reads the current term only from `schools/{id}.currentTerm` and
`.currentSession`, with your rule: both present and exactly valid, or the term
is not set. Its settings screen shows the term read-only and links to School
profile. The old `term` and `session` values are still on the
`jdSchoolSettings` documents, untouched, but nothing updates them. At two
schools they were already wrong (CAPSTONE a session behind, Mt Cedar a term
ahead).

What JDSmartLearn does now, so you can rely on it:

- New assignments are stamped with the School profile term, or a **later** term
  in the same session (scheduled work). An **earlier** term is refused by its
  server, and any session other than `currentSession` is refused.
- A school with no School profile term cannot create assignments in
  JDSmartLearn at all. Lessons and schemes created then carry no term.
- Assignments created before 2026-11-26 keep the term they were stamped with.
  Nothing was re-stamped.

## Hard constraints

- Never write a JDSmartLearn collection (`jdSchoolSettings`, `jdCaScores`,
  `assignments`, `submissions`, anything prefixed `jd`).
- Never normalise, trim, case-fold or infer a term or session string.
- Never work a term out from the date.

## The work

1. **Remove the `jdSchoolSettings` fallback from `resolveSchoolCalendar()`.**
   A school with no School profile term has no current term, and every caller
   already handles that ("set the current term first"). The fallback now reads
   a value that is frozen and, at two schools, wrong.
2. **Check every school before you ship it.** Dry-run: list each school where
   `currentTerm`/`currentSession` are not both set and valid. Those schools stop
   resolving a term the moment the fallback goes. Report the list to the owner,
   who asks each school admin to set School profile. Do not copy the
   `jdSchoolSettings` values across as a backfill: they are the wrong ones.
3. **Late marks for scheduled work.** Mt Cedar has 62 assignments stamped
   "Second Term" 2026/2027 while the school is in First Term, created on
   purpose as scheduled work. Your "hold a mark until the school reaches its
   term" rule covers them. Confirm with a test that a held mark is filed once,
   under Second Term, when the school moves to Second Term, and never under
   First Term.

## Definition of done

- [ ] `resolveSchoolCalendar()` reads `schools/{id}` only
- [ ] Dry-run list of schools without a valid School profile term, sent to the owner
- [ ] Test: a held future-term mark files under its own term once the school arrives
- [ ] No JDSmartLearn collection written
