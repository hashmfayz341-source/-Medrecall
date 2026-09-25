# MedRecall

An adaptive medical curriculum tutor. The fundamental unit of learning is a
**Concept**, not a flashcard.

MedRecall decides what you study next. It tracks what was learned, what was
forgotten, what was answered wrongly, what is weak, what is due, and what is
prerequisite to the material in front of you — and it interleaves earlier weak
concepts into later lectures until they stick.

## The core idea

```
Upload course → organise lectures → organise pages → extract concepts
   → review/approve → teach progressively → test active retrieval
   → detect weaknesses → schedule reviews → interleave into later lectures
```

A Concept is one idea with provenance and several ways of being tested. A
question is a *representation* of a Concept, never an independent object:

```
ATP depletion
  → Na+/K+ ATPase failure
  → intracellular Na+ and water accumulation
  → cellular swelling
```

## Three rules that shape everything

**1. Draft concepts cannot teach.** Extraction produces candidates. Until a
human approves one, it cannot be taught, tested, scheduled, interleaved, or
appear in Today. The gate is enforced in the domain layer, not the UI — see
`src/lib/domain/gate.ts`.

**2. Mastery is a bucket, not a percentage.** `NEW · LEARNING · WEAK · STABLE ·
STRONG`. A precise-looking number would imply a measurement precision we do not
have.

**3. Recognition is not recall.** A wrong answer marks a Concept WEAK. Answering
correctly *immediately after reading the explanation* does **not** clear that
weakness — only a later spaced or interleaved success does. This is the rule
most learning apps get wrong, and it is enforced in
`src/lib/domain/mastery.ts`.

## Status

**Milestone 1 — deterministic tutor.** Complete. **No AI key required.** The
demo course is Pathology: Cell Injury and Inflammation. The full journey works
end to end: learn in chunks → fail ATP depletion → it is marked WEAK and
re-taught → immediate remediation does *not* clear the weakness → finish
Lecture 1 → Lecture 2 unlocks → ATP depletion is injected into Lecture 2 →
answer it correctly → mastery improves → reload and everything persists.

**Milestone 2 — PDF ingestion.** Complete. Upload a PDF to a lecture and
MedRecall extracts its text page by page, proposes candidate concepts, and
holds every one of them as DRAFT until you review it:

```
Upload PDF → extract text page-by-page → candidate concepts (DRAFT)
   → Review Drafts: edit / approve / discard → ACTIVE → the existing tutor
```

Extraction **selects, it never asserts**: a concept's title is a span of its
source sentence, its explanation *is* that sentence, and its excerpt is that
same text. Nothing is claimed that the uploaded document does not already say.

Unreviewed material cannot complete a chunk or unlock a lecture — a part of a
lecture whose candidates are all still DRAFT reports that it is waiting on your
review.

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
```

Verification:

```bash
npm run lint
npm run typecheck
npm run test         # 176 unit tests
npm run build
npm run e2e          # 42 Playwright tests, iPad + desktop viewports
```

`npm run verify` chains lint, typecheck, unit tests and the production build.

### Playwright browsers

```bash
npm run e2e:install
```

If your environment already ships a Chromium, set `CHROMIUM_PATH` and the
config will use it instead of downloading one.

## Layout

```
src/
  app/            Next.js routes: dashboard, learning session, concept review, API
  components/     React components (presentation and state wiring only)
  lib/
    domain/       Pure types, approval gate, mastery rules, curriculum state
    engine/       Tutor orchestration, priority queue, FSRS scheduling
    grading/      Deterministic grading, /api/grade contract, remediation composer
    session/      One submission: gate, server grade, stale check, engine
    ingestion/    PDF page extraction + candidate concept generation
    persistence/  Repository interfaces + browser-local implementations
    content/      The authored Pathology demo curriculum
    ai/           Server-only provider roles (grading, extraction), one resolver each
tests/
  unit/           Vitest: gate, mastery, grading, unlock, interleaving,
                  journey, ingestion, draft lifecycle
  e2e/            Playwright: the tutor journey and the ingestion journey,
                  each at iPad and desktop viewports
  fixtures/       Generated PDFs (see scripts/make-fixture-pdf.mjs)
```

The learning engine is deliberately **not** inside React components. Everything
in `lib/domain` is pure and framework-free; you can run the whole tutor in a
test without rendering anything.

## Uploading your own material

Go to **Add material**, pick a lecture (or create one), and upload a PDF.
MedRecall extracts the text page by page and proposes candidates. Review them
under **Concept review**: edit the wording, approve what is right, discard what
is not. Editing a draft does *not* approve it — those stay separate decisions.

Text-based PDFs only. A scanned PDF with no text layer is rejected with an
explanation rather than silently yielding nothing; OCR is not part of this
milestone.

Regenerate the test fixtures with:

```bash
node scripts/make-fixture-pdf.mjs
```

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — decisions, with reasons and tradeoffs
- [ROADMAP.md](./ROADMAP.md) — what is built and what comes next
- [AI_HANDOFF.md](./AI_HANDOFF.md) — briefing for the next contributor
