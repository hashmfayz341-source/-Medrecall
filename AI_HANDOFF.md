# AI Handoff

Briefing for the next contributor — human or model — picking this up cold.

## What MedRecall is

An adaptive medical curriculum tutor. **Not an Anki clone.** The unit of
learning is a Concept; questions are representations of a Concept. The system,
not the student, decides what comes next.

## Read these first, in order

1. `src/lib/domain/types.ts` — the whole model in one file
2. `src/lib/domain/mastery.ts` — the rule that defines the product
3. `src/lib/domain/gate.ts` — the safety rule
4. `src/lib/engine/tutor.ts` — orchestration; `getNextStep()` is the heart
5. `src/lib/ingestion/extractor.ts` — how uploaded PDFs become DRAFT candidates
6. `ARCHITECTURE.md` — why each of those looks the way it does

## Rules you must not quietly break

**1. DRAFT concepts never reach a learner.** Not teaching, retrieval, mastery,
scheduling, interleaving, or Today. Enforced in `lib/domain/gate.ts` and called
from engine entry points. If you add a new path into the learning system, it
calls `assertActive()` or `activeOnly()`. Tests in `tests/unit/gate.test.ts`
exist to catch you.

**2. Immediate remediation success does not clear WEAK.** A correct answer in
`IMMEDIATE_REMEDIATION` context sets `immediateRemediationPassed` and leaves
mastery alone. Only `SPACED` / `INTERLEAVED` successes advance the ladder. This
looks like a bug when you first read it. It is the product.

**3. Mastery is never a percentage.** Five buckets. If you need more resolution,
use FSRS stability — do not invent a number.

**4. Every Concept keeps its SourceRef.** Course, lecture, document, page,
verbatim excerpt. Excerpts must be genuine substrings of the cited page;
`tests/unit/grading.test.ts` asserts it and has already caught two paraphrased
quotes.

**5. Extraction selects; it never asserts.** A candidate's title is a span of
its source sentence, its `summary` IS that sentence, and its `source.excerpt`
is the same text. Tests assert all three for every candidate. When a model
starts writing explanations, generated prose must still be consistent with, and
cite, the stored excerpt. Prerequisites are only linked where the earlier
concept's title appears literally in the later sentence — never inferred from
subject knowledge.

**6. A chunk with no ACTIVE concepts is never complete.** `[].every(...)` is
true, so the original completion rule let an all-DRAFT chunk complete on being
read and unlock the next lecture. `isChunkComplete()` now requires at least one
ACTIVE concept and `getNextStep()` returns `AWAITING_APPROVAL`. Any future
notion of completion must mean "approved and retrieved", never "seen".

**7. API keys stay server-side.** `lib/ai/index.ts` must never be imported into
a client component. Nothing goes through `NEXT_PUBLIC_*`.

**8. Keep the engine out of React.** `lib/domain` is pure and imports nothing
outward. The whole tutor runs headless in tests — keep it that way.

## How the session loop works

`getNextStep(curriculum, learner, lectureId, now)` is pure. It returns one of:

| Step | Meaning | How state advances |
|---|---|---|
| `TEACH` | ACTIVE summaries + approved source excerpts | `markChunkTaught()` |
| `RETRIEVE` | First unaided test (`INITIAL`) | `recordAttempt()` |
| `REMEDIATE` | Re-teach after a failure (`IMMEDIATE_REMEDIATION`) | `recordAttempt()` |
| `INTERLEAVE` | Weak/due concept from an earlier lecture (`INTERLEAVED`) | `recordAttempt()` |
| `AWAITING_APPROVAL` | Chunk has no ACTIVE concepts yet | approve drafts |
| `LECTURE_COMPLETE` | Nothing left in this lecture | — |

The UI is a thin driver: ask for the step, render it, call back, repeat.
`tests/unit/driver.ts` drives the identical loop headlessly — if you change the
loop, that driver is the fastest way to see the consequences.

Order inside `getNextStep`: locked-lecture check → find first incomplete chunk
→ **curriculum-wide remediation check** → interleaving (before teaching only,
once per chunk) → teach → untested concepts → complete.

## State shape

Two stores, deliberately separate (AD-8):

- `medrecall.learner.v1` — per-learner progress, FSRS cards, completion
- `medrecall.curriculum.v1` — shared curriculum: approval decisions
  (`statusById`), human edits (`edits`), user-created lectures, ingested
  documents with their generated chunks, and candidate concepts

`statusById` and `edits` are separate on purpose: editing a draft must never
approve it. `migrateOverrides()` preserves authored approvals, while legacy PDF
identities require a one-time review because their old hashes could collide.

Both are version-checked on read; corrupt or future-version data returns `null`
rather than throwing. Completion is **derived** by `reconcile()` and
stable across later weakness; newly approved, unattempted concepts reopen their chunk. Never write completion directly.

## Adding things

**A new retrieval form** — add to `RetrievalKind`, author items, extend
`pickItem()` if selection should change. Mastery and scheduling need no changes.

**A real AI provider** — implement `AiProvider` in `src/lib/ai/`, bind it in
`getProvider()`. `extractConcepts()` must return `status: "DRAFT"` with a
populated `SourceRef`. Run it server-side only.

**A real extraction provider** — implement `extractConcepts` in a new
`AiProvider`. It must return `status: "DRAFT"` with a populated `SourceRef`,
and run server-side inside `/api/ingest`. `DeterministicProvider` stays as the
offline fallback and the test oracle.

**A new course** — mirror `src/lib/content/pathology.ts`. Chunks are 2–5 pages.
Excerpts must be verbatim. Give each concept at least two retrieval items so
remediation can use a different form from the initial question.

**Server-side learner state** — implement `LearnerStateRepository`. Nothing
above that interface knows where state lives.

## Verifying

```bash
npm run lint && npm run typecheck && npm run test && npm run build && npm run e2e
```

176 unit tests, 42 E2E tests across iPad and desktop viewports. The E2E suite
drives the real UI through the complete demo journey, including the deliberate
ATP-depletion failure.

If Playwright cannot find a browser, set `CHROMIUM_PATH` to an existing
Chromium; the config prefers it over downloading.

## Traps that already bit

- **`reconcile()` used to delete completion**, so failing an interleaved
  question in Lecture 2 re-locked Lecture 2 mid-session. Completion is now
  preserved across weakness, with reopening only for newly approved, unattempted material (AD-6).
- **Remediation used to be scoped to the current chunk**, so failing an
  interleaved question produced no re-teaching (AD-7).
- **`ButtonLink` silently dropped `data-testid`**, so eight E2E tests timed out
  against a button that was plainly on screen. Prop-forwarding on wrapper
  components matters.
- **Playwright's iPad descriptors default to WebKit.** The `ipad` project pins
  Chromium with an iPad viewport, DPR and touch so one browser runs everything.
- **Two source excerpts were stitched from separate sentences** and failed the
  verbatim-provenance test. Quote, do not paraphrase.
- **Bundling pdfjs breaks it.** It resolves its worker through a runtime
  dynamic import; bundled, every upload fails with "Setting up fake worker
  failed". `serverExternalPackages: ["pdfjs-dist"]` fixes it. Unit tests under
  plain Node never reproduce this — which is why E2E runs against a production
  build.
- **Simulating a Vercel function with `output: "standalone"` is only valid
  OUTSIDE the repository.** Inside the repo, Node's module resolution walks up
  from `.next/standalone/node_modules` to the repo's own `node_modules`, so a
  file you delete from the bundle is silently found in the parent. Copy
  `.next/standalone` somewhere with no `node_modules` ancestor before testing a
  missing-file scenario. Standalone also merges every route's traced files into
  one tree, so it cannot reveal a per-route gap; `npm run build` checks the
  per-route manifests for that.
- **An all-DRAFT chunk used to complete itself** and unlock the next lecture,
  because `[].every(...)` is true. See rule 6 above.

## Current limitations

Per-browser persistence, keyword grading, no OCR for scanned PDFs, no merging
of duplicate candidates across documents, prerequisite graph not hand-editable,
"View Source" shows the excerpt rather than the page image, one fixed course
(lectures can be created), `reconcile()` unindexed. See ROADMAP.md.


## Independent Milestone 2 audit

The audit branch fixes teaching-text leakage, PDF identity collisions, cross-lecture
replacement, stale retrieval after editing, late-approval skipping, blank/discarded
chunk deadlocks, malformed curriculum persistence, silent quota errors, unsaved
review approval and other-tab stale approval state. Tests are in
`tests/unit/m2-audit.test.ts`, `tests/unit/ingest-route-audit.test.ts`, and
`tests/e2e/m2-audit.spec.ts`. No Milestone 3 work or Concept-model change is included.

The existing `medrecall.curriculum.v1` key remains; its payload version becomes 3.
Legacy uploaded approvals need source review once; authored approvals survive.
Re-upload originals if same-name files overwrote one another under Milestone 2.

Local unit tests and a production API smoke check passed. E2E execution and actual
iPad/Safari verification were blocked in the audit environment and must run before
merging. The 42 E2E cases are defined, not claimed as passed. Remote branch creation
was rejected by the connected GitHub integration (403), so this work was exported
as a patch; do not assume a PR exists or has been merged.
