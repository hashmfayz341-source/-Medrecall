# Roadmap

## V1 — released ✅

MedRecall V1 is the complete Concept-first loop, in production at
`main` (PR #8 merged): Course → Lectures → Documents → PDF upload → ordered
page extraction → DRAFT concepts → review / edit → approve / discard →
duplicate review / merge → ACTIVE concepts only → progressive Tutor teaching
→ retrieval → grading → remediation → mastery → FSRS scheduling → Today /
interleaving → Study cards → Show Answer → Again / Hard / Good / Easy →
persistence → decks and the card browser → source provenance on every card.
No AI key is required. Everything below is either part of V1 (✅) or
deferred to V1.1 / V2.

Deferred past V1: hosted model grading (behind the Stage B abuse-control
prerequisite), Image Occlusion, Anki import/export, complex statistics, AI
card generation, accounts and sync, hand-editing the prerequisite graph,
rendered page images in View source, OCR for scanned PDFs, additional
courses.

## Lecture → flashcards — product correction (implemented, awaiting review)

The default experience is now *Lecture → Flashcards → Study*; Concepts stay
the internal layer and the Tutor remains a separate feature.

- [x] Home is a lecture library: **Upload lecture** first; each lecture shows
      its real title (from the file name, editable), card counts and due
      cards, with Study / Cards; the demo course sits below
- [x] Generation settings per upload: language (English, Arabic, Arabic +
      English medical terms — persisted per lecture) and count (20 / 40 /
      60 / 100 / Custom / Auto); a count is met only when the lecture
      supports it, never padded, and the shortfall is shown
- [x] Every page rendered as an image in the browser and stored in
      IndexedDB; raster figures and vector diagrams detected from pdfjs
      operator lists; logos, repeated branding, icons and rules rejected
- [x] Direct card generation behind a third provider role
      (`getGenerationProvider()`, `POST /api/generate`): definitions,
      superlatives, mechanisms (consequence blanked, diagram on the back),
      lists, clozes, image cards on original figures; grounded and
      de-duplicated; DRAFT until approved
- [x] Review cards: approve / edit / discard / approve all; View source
      with excerpt and page image; Generate more (new facts only, FSRS
      history kept)
- [x] Study session composer above FSRS: overdue, due and near-due (24 h)
      cards of other lectures mixed in, one after every four current cards;
      neutral *Review* chip before the answer, origin after; ratings update
      the old card's own history
- [x] RTL layout for Arabic prompts (`dir="auto"`), iPad-sized targets
- [x] Merge-gate fixes: Arabic cards rendered from the fact's structure
      (Arabic questions and answers; mixed keeps medical terms English;
      partial cards disclosed); image questions only when a caption grounds
      the answer; old cards rated in a session return only when due;
      interleaving within the reviews-per-day limit; Generate more over a
      lecture's several PDFs
- [x] Final merge-gate fixes, tested on an unseen lecture: partial Arabic
      detected from untranslated English structure and disclosed as *Partly
      English*; temporal "by"/"within" and "most specific" keep their
      meaning; repeated pictures matched perceptually (≤ 4 of 64 bits);
      images attached only on strong evidence; near-due read from the
      persisted FSRS state (Again returns only when its step is due, also
      after a refresh); the lecture header wraps its actions below long
      titles
- [ ] Not in this step: full translation of every sentence (needs a hosted
      generator behind Stage B abuse control), OCR, figure understanding
      beyond captions and labels

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

### Milestone 2 follow-through — duplicate candidates ✅ (merged, in production)

- [x] Deterministic, textual detection of duplicate candidates across
      documents (same title, or most summary words in common); suggestions
      only, shown in Review drafts
- [x] **Merge into it**: the duplicate is DISCARDED, its page teaches the
      canonical concept, and its source is kept on the canonical as extra
      provenance ("Also in …"); the canonical's status is never changed
- [x] **Keep both** rejects a suggestion; **Undo merge** returns the
      duplicate to DRAFT, never to ACTIVE
- [x] Learner progress and Study cards of a merged duplicate are simply out
      of use (DISCARDED); nothing is deleted or moved
- [x] Concurrent tabs cannot undo a merge by accident: every curriculum
      mutation is applied to the current store; one malformed stored merge
      entry is dropped on its own, never the whole curriculum; summary
      matching needs at least three content words on both sides

### Not done in Milestone 2

- Editing the prerequisite graph by hand
- "View Source" showing the rendered page image (excerpt only for now)
- OCR for scanned PDFs — rejected with an explicit message instead
- Creating additional courses (lectures can be created; the course is fixed)

## Milestone 3 — Model-graded free recall (Stage A in V1; hosted grading deferred)

### Stage A — server-side grading boundary ✅ (merged, in production)

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

### Step 1 — Study session ✅ (merged, in production)

- [x] `/study/[lectureId]`: card front, **Show Answer**, back with source
      (document, page, excerpt behind "View source")
- [x] Again / Hard / Good / Easy mapped one-to-one onto FSRS ratings, with
      interval previews; keyboard 1–4, Space to reveal
- [x] Per-card FSRS scheduling (`LearnerState.cards`), with concept mastery
      fed by self-ratings (AD-25)
- [x] New / Learning / Review queue and counts; due material before new
- [x] ACTIVE concepts only; duplicate and cross-tab ratings refused
- [x] Study and the Tutor share mastery, never Tutor evidence; pending Tutor
      remediation is explicit state, migrated for existing learner state
- [x] Safe alongside a stale main tab: per-concept remediation provenance, and
      card progress in its own storage key (`medrecall.study-cards.v1`)
- [x] Dashboard **Study** entry per lecture

### Step 2 — Decks, card browser, custom study ✅ (merged, in production)

- [x] `/study`: the course as decks (one per lecture, derived — never
      stored), with New / Learning / Review / suspended / buried counts from
      Card FSRS state
- [x] `/study/browse`: card browser with concept, lecture, source and Study
      status; filters over existing metadata (lecture, type, importance,
      status, due, text)
- [x] Card editing (front/back) keeping the card id and FSRS history;
      stale-tab protection through the content fingerprint
- [x] Suspend (until resumed) and bury (until the next local day), as Study
      flags in the Study sidecar; mastery and schedules untouched
- [x] Custom study: all due cards across the course, or a selection; normal
      FSRS; may ignore the daily limits
- [x] Daily limits (new per day, reviews per day) in `medrecall.study-settings.v1`
- [ ] Deferred: Image Occlusion, Anki import/export, complex statistics, AI
      card generation, shared accounts/sync

### Later steps (not started)
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
