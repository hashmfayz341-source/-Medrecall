# MedRecall

**Your lecture, as flashcards.** Upload a lecture PDF, choose the card
language and how many cards you want, and MedRecall generates cards from what
the lecture actually says — figures from the PDF included — for you to
review and study Anki-style:

```
Upload Cell Injury.pdf → language (English / Arabic / Arabic + English terms) → 40 cards
   → review / edit / approve → Study: front → Show Answer → Again / Hard / Good / Easy
   → FSRS schedules the next review → older due cards come back inside later lectures
```

**Anki-first study, concept-aware underneath.** Learners study cards the way an
Anki user expects:

```
Card front → Show Answer → back → Again / Hard / Good / Easy → FSRS schedules the next review
```

Underneath, every card is a representation of a **Concept**, the internal unit
of knowledge that carries provenance, approval status and mastery. Concepts are
what make the cards trustworthy (every card cites its source page) and what
future intelligence builds on; the learner simply studies cards.

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

## Lecture → flashcards (the primary flow)

1. **Upload lecture** (`/upload`): pick the PDF. The file name becomes the
   lecture title ("Cell Injury.pdf" → *Cell Injury*); edit it if you like.
2. **Cards**: choose the language — English, Arabic, or Arabic with English
   medical terminology — and the number: 20 / 40 / 60 / 100 / Custom / Auto.
   Auto covers the important material once. A number is met only when the
   lecture supports it; facts are never repeated to reach a count, and the
   screen says how many distinct cards were possible.
3. **Generate**: the text is read page by page (server-side), every page is
   rendered and its figures cropped (in your browser — images never leave the
   device), then cards are generated: definitions, mechanisms with the
   consequence blanked, "what is the most common cause of …", bullet lists,
   clozes, and **image cards** built on the original figure ("What does this
   figure show?"). Every card cites its page; View source shows the excerpt
   and the page image.
4. **Review cards** (`/lectures/<id>`): approve, edit front/back, discard;
   **Approve all** for speed. Cards are drafts until approved.
5. **Study** (`/study/<id>`), and later **Generate more cards**: only new
   facts are added; existing cards keep their FSRS history.

Visual material is used where it helps and never invented: raster images and
vector diagrams large enough to be looked at become figures; logos, repeated
branding, icons and rules are rejected. The card language is persisted per
lecture. With the built-in deterministic generator the question scaffolding is
Arabic in the Arabic modes and the lecture's own terms and sentences stay as
written; a hosted generator (a later, separately safeguarded step) can
translate explanations in full behind the same boundary.

**Old memories while studying a new lecture.** While you study Inflammation,
Cell Injury cards that FSRS says are overdue, due, or due within the next day
are mixed in — about one after every four Inflammation cards. They show a
neutral *Review* chip before the answer and their lecture and page after it,
and rating them updates their own FSRS history; they never join the new
lecture. FSRS decides *when* a card is due; the session composer only
decides *what appears next*.

## Studying (Anki-style)

Open a lecture's **Study** button on the dashboard (`/study/<lectureId>`):

- **Front only** until you tap **Show Answer** (or press Space). Revealing
  records nothing.
- **Back:** the reviewed answer, plus the source document and page. The
  verbatim excerpt is one tap away, under **View source**.
- **Rate** Again / Hard / Good / Easy (or keys 1–4). Each button shows the
  interval FSRS would give. The rating goes to FSRS as exactly that rating;
  Easy is never collapsed into Good.
- **Counts:** New · Learning · Review, derived from your FSRS state. Due
  learning and review cards come before new ones.

Only ACTIVE (approved) concepts produce cards. Drafts from an upload stay
out of Study until you approve them in **Review drafts**. The earlier guided
tutor (`/learn/<lectureId>`, typed answers graded by `/api/grade`) is still
available.

### Decks, the card browser, custom study (Step 2)

- **Study decks** (`/study`): the course as decks, one per lecture, derived
  from Course → Lecture → Concept every time (nothing stores a deck). Each
  shows New · Learning · Review from the cards' own FSRS state, plus
  suspended and buried counts. **Options** sets the daily limits: new cards
  per day and reviews per day (learning steps are never limited).
- **Duplicates across documents** (Review drafts): when two documents yield
  the same concept, the later one is flagged as a possible duplicate. **Merge
  into it** discards the duplicate, teaches its page through the surviving
  concept and keeps its source as extra provenance; **Keep both** dismisses
  the suggestion; **Undo merge** returns it to draft.
- **Card browser** (`/study/browse`): every approved card with its concept,
  lecture, source (document · page, the excerpt one tap away, and a link into
  concept review) and Study status. Filter by lecture, card type, concept
  importance, status, due-now, or text — existing metadata only.
  - **Edit** a card's front/back. The card keeps its id and FSRS history;
    grading and the source excerpt are untouched. A rating revealed against
    the old wording is refused as stale.
  - **Suspend** a card to keep it out of Study until you resume it, or
    **bury** it until the next day. Neither touches its schedule or the
    concept's mastery.
- **Custom study** (`/study/custom`): all due cards across the course, or a
  selection by lecture, type, importance or status; optionally ignoring
  today's limits. Scheduling is the normal FSRS — custom study only chooses
  which cards.

## Status

**Lecture → flashcards.** Implemented, in review. The primary flow above:
upload, language and count, generation with figures from the PDF, card
review, Anki-style Study, cross-lecture due/near-due reviews, lecture library.

**V1 released.** The complete loop — upload a PDF, review and approve its
concepts (merging duplicates across documents), learn with the Tutor, study
the cards, everything persisted in the browser with provenance on every card —
is in production on `main`. Hosted model grading, Image Occlusion, Anki
import/export, accounts and sync are V1.1 / V2 (see ROADMAP).

**Duplicate candidates across documents.** Complete. Suggested in Review
drafts, merged or kept apart by the reviewer, undoable; safe across
concurrent tabs and malformed stored state.

**Anki experience, Step 1: card study.** Complete. Front/back cards, Show
Answer, Again/Hard/Good/Easy mapped one-to-one onto FSRS, per-card scheduling
and New/Learning/Review counts.

**Anki experience, Step 2: decks and the card browser.** Complete. Deck view
with counts, card browser with filters and provenance, card
editing, suspend/bury, custom study and daily limits. Import/export, Image
Occlusion and AI card generation are later steps.

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
npm run test         # 583 unit tests
npm run build
npm run e2e          # 172 Playwright tests, iPad + desktop viewports
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

**Upload lecture** on the home screen is the normal way (see above). The
older **Add material** screen (`/ingest`) still adds a PDF to an existing
lecture, including the demo course, for the guided Tutor: pick a lecture (or create one), and upload a PDF.
MedRecall extracts the text page by page and proposes candidates. Review them
under **Concept review**: edit the wording, approve what is right, discard what
is not. Editing a draft does *not* approve it — those stay separate decisions.

Text-based PDFs only. A scanned PDF with no text layer is rejected with an
explanation rather than silently yielding nothing; OCR is not part of this
milestone.

Regenerate the test fixtures with:

```bash
node scripts/make-fixture-pdf.mjs        # the small ingestion fixtures
node scripts/make-lecture-fixtures.mjs   # Cell Injury.pdf and Inflammation.pdf, with figures
```

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — decisions, with reasons and tradeoffs
- [ROADMAP.md](./ROADMAP.md) — what is built and what comes next
- [AI_HANDOFF.md](./AI_HANDOFF.md) — briefing for the next contributor
