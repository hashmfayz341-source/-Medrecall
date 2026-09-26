# Roadmap

## Milestone 1 — Deterministic tutor ✅

A complete tutor running with no AI key.

- [x] Concept-centred domain model with mandatory source provenance
- [x] Concept approval gate enforced in the domain layer
- [x] Mastery buckets: NEW / LEARNING / WEAK / STABLE / STRONG
- [x] Wrong answer → WEAK → immediate re-teach → remediation
- [x] Immediate remediation success does **not** clear WEAK
- [x] Later spaced or interleaved success improves mastery
- [x] FSRS scheduling via `ts-fsrs`
- [x] Priority: due → weak/previously wrong → core → prerequisites
- [x] Progressive teaching in 2–5 page source-grounded chunks
- [x] Lecture unlock gated on real retrieval, not on reading
- [x] Cross-lecture interleaving, capped at one interruption per chunk
- [x] Browser-local persistence, shared curriculum state kept separate
- [x] Provider-agnostic AI interface with a deterministic implementation
- [x] iPad-first dashboard, teaching session and concept review screens
- [x] 87 unit tests, 16 Playwright tests at iPad and desktop viewports
- [x] Pathology demo course: Cell Injury → Inflammation

## Milestone 2 — Real content ingestion ✅

- [x] PDF upload with page-by-page text extraction (never flattened)
- [x] Page order, page numbers and document identity preserved
- [x] Deterministic candidate extraction behind the AI provider abstraction
- [x] Every candidate created DRAFT with a complete `SourceRef`
- [x] Extraction invents nothing: explanation == verbatim source sentence
- [x] Prerequisites only where the source text literally supports them
- [x] Review Drafts: edit title/explanation, approve, discard, bulk approve
- [x] Filtering by document and page; "View Source" with document, page, excerpt
- [x] Editing never implicitly approves
- [x] Approved concepts flow into the existing tutor — no parallel system
- [x] Teaching chunks generated from ingested pages
- [x] Curriculum state v2 with a Milestone 1 migration
- [x] `AWAITING_APPROVAL`: unreviewed material cannot complete a chunk or
      unlock a lecture
- [x] 147 unit tests, 28 Playwright tests at iPad and desktop viewports

### Not done in Milestone 2

- Merging duplicate candidates across documents
- Editing the prerequisite graph by hand
- "View Source" showing the rendered page image (excerpt only for now)
- OCR for scanned PDFs — rejected with an explicit message instead
- Creating additional courses (lectures can be created; the course is fixed)

## Milestone 3 — Model-graded free recall (in progress)

### Stage A — server-side grading boundary (implemented, awaiting review)

- [x] Grading runs server-side behind `POST /api/grade`, not in the browser.
      Remediation is composed on the server from reviewed material (AD-19,
      AD-21)
- [x] Engine split: pure `recordGradedAttempt()` applies an already-computed
      grade; `recordAttempt()` kept as the deterministic wrapper
- [x] `GradeOutcome` (`INCORRECT | PARTIAL | CORRECT`) with `correct` kept for
      compatibility and true only for `CORRECT`
- [x] Narrow, strictly validated grading payload: no client-supplied prompts,
      approval gate enforced at the boundary
- [x] Failed or malformed grading causes zero learner mutation, and double
      submits record one attempt
- [x] Deterministic parity with the pre-boundary flow, tested step by step
- [x] Deterministic grading retained as fallback and regression oracle
- [x] Stale asynchronous grades refused: attempt precondition with progress
      version and grading-target fingerprint (AD-20)
- [x] Providers grade against `{ concept, item, answer }`, including the
      verbatim source excerpt
- [x] Remediation composed from reviewed material only, never provider prose
      (AD-21)
- [x] Hosted providers refused by both role resolvers until abuse control
      exists (AD-22)
- [x] Grading and extraction providers resolved separately
      (`getGradingProvider()`, `getExtractionProvider()`), so a hosted grader
      cannot change ingestion (AD-23)

### Stage B prerequisites (must land before any hosted provider)

- [ ] **Server-side abuse control** on every route that calls a paid provider:
      authentication, per-user or per-IP rate limiting and a spend quota, or
      equivalent. Until curriculum is server-side, the route cannot verify
      ACTIVE status or the rubric, so anyone can call it.
      `HOSTED_PROVIDER_SAFEGUARDS.abuseControl` is flipped only in that
      change.

### Later stages

- [ ] A hosted model **grader**, as a `GradingProvider` adapter behind
      `getGradingProvider()` only (after the prerequisite above). Extraction
      stays deterministic unless changed in its own reviewed stage.
- [ ] PARTIAL mastery policy (partial credit feeding a finer mastery signal)
- [ ] Richer remediation beyond reviewed material. This needs a structured
      grounding contract first. Checking that text "contains the excerpt" is
      not grounding (AD-21).
- [ ] Disagreement logging between deterministic and model grading

## Anki experience (product correction: Anki-first learner experience)

### Step 1 — Study session (implemented, awaiting review)

- [x] `/study/[lectureId]`: card front, **Show Answer**, back with source
      (document, page, excerpt behind "View source")
- [x] Again / Hard / Good / Easy mapped one-to-one onto FSRS ratings, with
      interval previews; keyboard 1–4, Space to reveal
- [x] Per-card FSRS scheduling (`LearnerState.cards`), with concept mastery
      fed by self-ratings (AD-25)
- [x] New / Learning / Review queue and counts; due material before new
- [x] ACTIVE concepts only; duplicate and cross-tab ratings refused
- [x] Dashboard **Study** entry per lecture

### Later steps (not started)

- [ ] Step 2: decks (management, hierarchy), card browser and editor, tags,
      suspend/bury, custom study, daily limits and deck options
- [ ] Later: Image Occlusion, Anki import/export, flashcard-quality extraction
      (PDF → cards), AI card generation (with its own safeguards)

## Milestone 4 — Accounts and sync

- [ ] Server-side learner state behind the existing repository interface
- [ ] Curriculum served from the server; `/api/curriculum` already shaped for it
- [ ] Multi-device sync with conflict resolution on concept progress
- [ ] Shared/published courses

## Milestone 5 — Depth of assessment

- [ ] Clinical-application retrieval (`CLINICAL`)
- [ ] Image-based retrieval (`IMAGE`)
- [ ] Timed exam mode as a distinct `RetrievalContext`
- [ ] Confidence calibration: predicted vs actual performance

## Explicitly not planned

Payments, social features, marketplace, leaderboards, university admin, native
apps, elaborate analytics, gamification. None of these make anyone remember
pathology better.

## Known limitations of Milestone 1

- Progress is per-browser; clearing site data loses it.
- Grading is keyword-based, so an unusual phrasing can be marked wrong.
- The curriculum is authored in TypeScript; there is no upload path yet.
- `reconcile()` walks the whole curriculum per attempt — fine at two lectures,
  needs indexing at hundreds.
- Concept editing in the review screen is approve/discard only; no text editing.
