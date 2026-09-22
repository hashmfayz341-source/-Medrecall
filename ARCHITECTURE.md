# Architecture

Each entry records the **decision**, the **reason**, the **tradeoff** accepted,
and the **future implication**.

## Layers

```
app/ components/        React, Next.js — rendering and state wiring only
        ↓ calls
lib/engine/             Tutor orchestration, priority, FSRS scheduling
        ↓ calls
lib/domain/             Pure types, approval gate, mastery rules  (no imports out)
lib/grading/            Deterministic grading (pure)
lib/ingestion/          PDF text extraction + candidate concept generation
lib/persistence/        Repository interfaces + implementations
lib/content/            Authored curriculum data
lib/ai/                 Provider-agnostic interface + deterministic implementation
```

Dependencies point inward. `lib/domain` imports nothing from the outer layers.

---

## AD-1 — Concept is the central entity, not the flashcard

**Decision.** `Concept` owns identity, provenance, prerequisites and a list of
`RetrievalItem`s. Questions are representations of a Concept.

**Reason.** The product needs to answer "does this learner understand ATP
depletion?" — not "did they get card #412 right?". Mastery, weakness,
scheduling and interleaving are all properties of the idea. A card-centric
model makes cross-lecture memory near-impossible: the same idea appears as
several unrelated cards with unrelated schedules.

**Tradeoff.** More indirection than a flat card list, and a Concept with many
retrieval forms needs a selection policy (`pickItem`). Importing an existing
Anki deck is not a trivial mapping.

**Future implication.** New retrieval forms (clinical vignettes, image-based
recall) are additive: extend `RetrievalKind` and add items. Nothing about
mastery or scheduling changes.

---

## AD-2 — The approval gate lives in the domain layer

**Decision.** `assertActive()` / `activeOnly()` in `lib/domain/gate.ts` guard
teaching, retrieval, mastery, scheduling, interleaving and Today. Engine entry
points call them; `recordAttempt` and `scheduleAfterAttempt` throw
`ConceptNotActiveError` on a non-ACTIVE concept.

**Reason.** Enforcing it in the UI only means the next caller — an API route, a
background import, a future mobile client — silently bypasses it. Unreviewed
generated medical content reaching a learner is the single worst failure mode
this product has.

**Tradeoff.** Throwing on a DRAFT concept means callers must filter first or
handle the error. Slightly noisier call sites; deliberately so.

**Future implication.** A server-side extraction pipeline can write DRAFT
concepts freely without any risk of them leaking into a session.

---

## AD-3 — Mastery buckets, not percentages

**Decision.** `NEW · LEARNING · WEAK · STABLE · STRONG`, driven by a streak of
consecutive spaced successes since the last failure.

**Reason.** "73% mastery" implies a calibrated measurement we cannot produce
from a handful of retrievals. Buckets communicate confidence honestly.

**Tradeoff.** Coarse. Two STABLE concepts may differ in real strength, and
progress inside a bucket is invisible to the learner.

**Future implication.** If finer granularity is needed, FSRS *stability* is
already stored per concept and can back a sub-bucket signal — without inventing
a percentage.

---

## AD-4 — Immediate remediation never clears WEAK

**Decision.** `RetrievalContext` distinguishes `INITIAL`,
`IMMEDIATE_REMEDIATION`, `SPACED` and `INTERLEAVED`. A correct answer in
`IMMEDIATE_REMEDIATION` sets `immediateRemediationPassed` and leaves mastery
untouched. Only `SPACED` / `INTERLEAVED` successes advance the ladder.

**Reason.** Answering correctly ten seconds after reading the answer measures
recognition and short-term memory, not retrieval. Clearing weakness there is
how a tutor convinces a student they know something they do not.

**Tradeoff.** Learners may feel they are being punished for recovering. The UI
compensates by explaining the rule at the moment it bites (`weakness-note`).

**Future implication.** The context enum is the extension point for future
distinctions — exam conditions, timed recall, clinical application — each with
its own mastery weight.

---

## AD-5 — FSRS owns WHEN; MedRecall owns WHAT and HOW

**Decision.** `ts-fsrs` schedules intervals. Selection, priority, teaching order
and retrieval form are MedRecall's. A remediation pass is graded `Hard`, never
`Good`.

**Reason.** Spaced-repetition interval maths is a solved, well-researched
problem; curriculum sequencing is not. Mapping our contexts onto FSRS grades
keeps both concerns honest.

**Tradeoff.** Two sources of truth about urgency — the FSRS due date and our
priority score — that must be kept coherent.

**Future implication.** FSRS can be upgraded, re-parameterised or replaced
behind `lib/engine/scheduler.ts` without touching tutoring logic.

---

## AD-6 — Completion is derived and monotonic

**Decision.** `reconcile()` computes chunk and lecture completion from concept
progress. The UI never asserts "this lecture is done". Completion only ever
*adds*.

**Reason.** Derived state cannot drift from reality, and a client cannot fake
progress. Monotonicity matters because a concept can go WEAK again later — when
it is interleaved into a future lecture — and that must not retroactively
re-lock a lecture the learner finished weeks ago.

**Tradeoff.** `reconcile()` walks the whole curriculum on every attempt. Fine at
this size; it will need indexing at hundreds of lectures.

**Future implication.** Completion rules can change and old state recomputes
correctly, because nothing is stored that cannot be re-derived.

---

## AD-7 — Remediation is checked curriculum-wide, not per chunk

**Decision.** `getNextStep()` looks for any ACTIVE concept awaiting remediation
across the whole curriculum before advancing the current chunk.

**Reason.** An interleaved question comes from an *earlier* lecture. Scoping the
check to the current chunk meant failing an injected question produced no
re-teaching at all — the exact moment the learner most needs it.

**Tradeoff.** A leftover weakness from a previous session can interrupt the
start of new material.

**Future implication.** This is the natural hook for a dedicated "review
session" mode that drains outstanding remediation before new teaching.

---

## AD-8 — Shared curriculum state is separate from learner state

**Decision.** Two stores. Learner progress under `medrecall.learner.v1`;
concept approval status under `medrecall.curriculum.v1`, applied as overrides
over the authored curriculum.

**Reason.** Approving a concept changes the *course* — for every learner.
Mastery is personal. Conflating them would make a future server split a
rewrite.

**Tradeoff.** Two stores to version and migrate, and an override layer to apply
on every read.

**Future implication.** Curriculum moves server-side by swapping one repository
implementation. `/api/curriculum` already serves shared state and deliberately
returns no learner data.

---

## AD-9 — Deterministic grading is the floor, not a placeholder

**Decision.** Keyword-group matching with synonyms, word-boundary aware. Each
group must be satisfied by at least one synonym.

**Reason.** Milestone 1 runs with no AI key, and grading must be explainable and
repeatable — a test suite needs an oracle. It also rewards recalling the
mechanism over reproducing a sentence.

**Tradeoff.** No credit for a correct answer phrased outside the synonym lists.
Authoring items requires care.

**Future implication.** `gradeFreeAnswer()` on the provider interface can route
to a model, with this implementation staying as the offline fallback and the
regression oracle.

---

## AD-10 — Provider-agnostic AI interface, keys server-side

**Decision.** `AiProvider` declares `extractConcepts`,
`generateTeachingExplanation`, `generateRetrievalItems`, `gradeFreeAnswer` and
`generateRemediation`. `DeterministicProvider` implements it with authored
content. No vendor SDK is imported anywhere.

**Reason.** Vendor choice should be a one-line change. Extraction must always
return DRAFT concepts with a populated `SourceRef`, whoever implements it.

**Tradeoff.** The interface is guessed ahead of a real model integration and
will need revision (streaming, token budgets, partial failure).

**Future implication.** Any hosted provider must run inside a route handler or
server action. No key may ever be exposed through `NEXT_PUBLIC_*`.

---

## AD-11 — Source provenance is mandatory and tested

**Decision.** Every `Concept` carries `SourceRef` — course, lecture, document,
page number and a verbatim excerpt. Tests assert the cited page exists and that
the excerpt is genuinely a substring of that page's text.

**Reason.** Generated medical content that has lost its source is unverifiable
and unsafe. "View Source" must always be possible.

**Tradeoff.** Authoring is stricter — excerpts must be quoted, not paraphrased.
This caught two stitched-together excerpts during Milestone 1.

**Future implication.** Supports "View Source" UI, citation export, and
re-grounding a concept when source material is revised.

---

## AD-12 — Browser-local persistence behind a repository interface

**Decision.** `LearnerStateRepository` with localStorage and in-memory
implementations. Every read is validated and version-checked; corrupt or
future-version state returns `null` rather than throwing.

**Reason.** Milestone 1 explicitly should not build auth or a backend. Storage
is untrusted input like any other.

**Tradeoff.** Progress is per-device and per-browser, and is lost when site data
is cleared.

**Future implication.** A server-backed implementation is additive. The version
field is the migration hook.


---

## AD-13 — PDF text is extracted page by page, server-side

**Decision.** `lib/ingestion/pdf.ts` walks a PDF page by page with pdfjs and
returns one record per page, carrying its number, heading and text. Parsing
runs in the `/api/ingest` route handler, never in the browser.

**Reason.** Page provenance is the product's safety property (AD-11). A
flattened text blob makes a page number a guess, which makes "View Source" a
lie. Running server-side also keeps a megabyte-scale parser out of the client
bundle and puts extraction where a hosted provider's API key will live.

**Tradeoff.** The PDF is uploaded rather than parsed locally, so ingestion needs
a round trip and a request-size limit (12MB).

**Future implication.** Swapping in OCR for scanned PDFs, or a layout-aware
parser, happens behind `extractPdfPages()` without touching extraction or the
gate. Today a scan with no text layer is rejected with an explicit message
rather than silently producing nothing.

---

## AD-14 — Extraction selects; it never asserts

**Decision.** A candidate concept's title is a span of its source sentence, its
explanation **is** that sentence, and its excerpt is the same text again. The
extractor chooses which sentences are worth surfacing and nothing else.

**Reason.** The one thing a medical tutor must never do is invent a fact and
present it as sourced. Making "explanation == verbatim source sentence" an
invariant means the question "did the model make this up?" cannot arise for
Milestone 2 output, and a test asserts it for every candidate.

**Tradeoff.** Explanations read like the textbook rather than like a tutor, and
a sentence with no clear subject/verb boundary is skipped instead of guessed at.

**Future implication.** When a model-backed provider generates real
explanations, this invariant becomes the thing to defend: generated prose must
still cite, and stay consistent with, the stored excerpt.

---

## AD-15 — Prerequisites only from literal textual evidence

**Decision.** A candidate links to an earlier candidate only when that earlier
concept's title appears verbatim in the later concept's source sentence.

**Reason.** A prerequisite graph drives teaching order and priority. Inferring
"ATP depletion precedes cellular swelling" from subject knowledge would be the
extractor asserting medicine. Textual containment is evidence the document
itself supplies.

**Tradeoff.** The graph is sparse and misses real dependencies expressed in
different words.

**Future implication.** A model-backed extractor can propose richer links, but
they should arrive as reviewable suggestions, not as silent edges.

---

## AD-16 — Curriculum state v2: edits are separate from approval

**Decision.** Shared curriculum state now carries ingested documents, generated
chunks, candidate concepts, a `statusById` map and a separate `edits` map.
`migrateOverrides()` upgrades a Milestone 1 store in place.

**Reason.** Editing and approving are different decisions by different
intentions. Correcting a draft's wording must not make it teachable — a
reviewer fixing a typo has not endorsed the concept. Keeping the maps separate
makes that structural rather than a UI convention.

**Tradeoff.** Two maps to keep coherent, and the live curriculum is composed on
every read rather than stored flat.

**Future implication.** Edit history, per-reviewer attribution and approval
workflows all hang off `edits` without disturbing `statusById`.

---

## AD-17 — A chunk with nothing approved can never be complete

**Decision.** `isChunkComplete()` returns false when a chunk has no ACTIVE
concepts, and `getNextStep()` returns an `AWAITING_APPROVAL` step instead of
teaching one.

**Reason.** Found while writing the Milestone 2 gate tests. Chunk completion
was "every ACTIVE concept has been attempted", and `[].every(...)` is true — so
a chunk whose candidates were all still DRAFT completed the moment it was read,
and could unlock the next lecture. Unreviewed material would have satisfied
lecture unlock logic, which the approval gate exists to prevent.

**Tradeoff.** A lecture whose candidates are all discarded can never complete,
so its chunk sits in `AWAITING_APPROVAL`. That is the honest state: there is
nothing approved to learn.

**Future implication.** Any future notion of completion must ask "approved and
retrieved", never "seen".

---

## AD-18 — pdfjs stays out of the server bundle

**Decision.** `serverExternalPackages: ["pdfjs-dist"]` in `next.config.ts`.

**Reason.** pdfjs resolves its worker through a runtime dynamic import. Bundled,
that path is rewritten and every upload fails with "Setting up fake worker
failed" — which unit tests running under plain Node never reproduce. Marking it
external leaves the import resolving from `node_modules`, matching test
behaviour.

**Tradeoff.** The package is traced rather than bundled, so it must be present
in the deployment's `node_modules`.

**Future implication.** Any parser with a runtime-resolved worker needs the same
treatment. It is also why the E2E suite runs against a production build: this
failure mode is invisible in unit tests.
