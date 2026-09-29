# Architecture

Each entry records the **decision**, the **reason**, the **tradeoff** accepted,
and the **future implication**.

## Layers

```
app/ components/        React, Next.js — rendering and state wiring only
        ↓ calls
lib/session/            One learner submission: gate → server grade → engine
        ↓ calls
lib/engine/             Tutor orchestration, card study (study.ts), priority, FSRS
        ↓ calls
lib/domain/             Pure types, approval gate, mastery rules  (no imports out)
lib/grading/            Deterministic grading, grade validation, /api/grade wire
                        contract, remediation composed from reviewed material
lib/ingestion/          PDF text extraction + candidate concept generation
lib/persistence/        Repository interfaces + implementations
lib/content/            Authored curriculum data
lib/ai/                 SERVER ONLY. Provider roles (GradingProvider,
                        ExtractionProvider), one resolver per role, deterministic
                        provider, grading service for /api/grade, hosted policy
```

Dependencies point inward. `lib/domain` imports nothing from the outer layers.
No client component reaches `lib/ai`, directly or transitively;
`tests/unit/client-boundary.test.ts` walks the import graph to enforce it.

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

## AD-6 — Completion is derived and stable for previously tested material

**Decision.** `reconcile()` computes chunk and lecture completion from concept
progress. The UI never asserts "this lecture is done". Completion survives later weakness, but newly approved, unattempted concepts reopen their chunk.

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

**Decision.** Providers are split by role. `GradingProvider` has
`gradeFreeAnswer({ concept, item, answer })`. `ExtractionProvider` has
`extractConcepts`. Both declare `name` and `hosted`. `AiProvider` is the full
surface `DeterministicProvider` implements with authored content (both roles
plus `generateTeachingExplanation` and `generateRetrievalItems`). Each role is
resolved separately (AD-23). No vendor SDK is imported anywhere. Providers
write no remediation (AD-21).

**Reason.** Vendor choice should be an adapter plus a binding for one role,
gated by AD-22. Extraction must always
return DRAFT concepts with a populated `SourceRef`, whoever implements it.

**Tradeoff.** The interface is guessed ahead of a real model integration and
will need revision (streaming, token budgets, partial failure).

**Future implication.** Any hosted provider must run inside a route handler or
server action. No key may ever be exposed through `NEXT_PUBLIC_*`. As of AD-19
grading and remediation run only behind `POST /api/grade`.

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
concepts. Draft-only chunks wait for approval. Blank and explicitly discarded
sections are skipped when there is other material to learn; an entirely
discarded lecture earns no completion.

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

---

## AD-19 — GRADING DECISION ≠ STATE MUTATION (Milestone 3, Stage A)

**Decision.** Assessing an answer and applying that assessment to learner
state are two separate steps, owned by two separate parties.

- **The provider decides the assessment, and only the assessment.**
  `POST /api/grade` calls `getGradingProvider().gradeFreeAnswer({ concept,
  item, answer })` server-side. It uses the grading resolver only (AD-23). The provider receives the approved concept's
  identity, wording and verbatim `SourceRef` excerpt, the retrieval item with
  its reviewed rubric, and the answer, so a future model can grade against the
  source without another interface change. It returns an outcome and the
  rubric terms matched or missed. It writes no learner-facing text (AD-21). The
  route returns a small validated `{ provider, conceptId, itemId, grade,
  remediation }` and nothing else. The provider never sees, and cannot write,
  learner state.
- **The deterministic engine decides what that assessment does.**
  `recordGradedAttempt(curriculum, learner, input, grade, precondition?)` in
  `lib/engine/tutor.ts` is pure. It re-checks the approval gate and that the
  item belongs to the concept. It checks the attempt precondition (AD-20) and
  validates the grade. Then it applies mastery, FSRS, interleaving bookkeeping
  and completion atomically. It never calls a provider or the network, and it
  never re-grades.

The learner flow is:

```
submit → gate check + precondition captured (browser)
       → POST /api/grade → provider decides the grade; remediation composed from reviewed material (server)
       → reply validated → precondition re-checked against the freshest persisted state (browser)
       → recordGradedAttempt → persist → feedback
```

`recordAttempt()` survives as a deterministic compatibility wrapper
(`gradeAnswer` → `recordGradedAttempt`). It is the parity oracle and serves
internal callers and tests. The learner's path no longer uses it.

**Grade outcomes.** `GradeResult.outcome` is `INCORRECT | PARTIAL | CORRECT`.
`correct` stays for compatibility and is true **only** for `CORRECT`. A grade
whose `correct` flag disagrees with its outcome is rejected at every boundary:
provider → route, route → browser, and browser → engine. That stops a malformed
PARTIAL from ever being credited. The deterministic grader emits only
`INCORRECT`/`CORRECT`. **PARTIAL has no mastery policy yet.** Until Stage B
defines one, the engine treats it exactly like INCORRECT, and a test pins this
so the change has to be deliberate. There is no mastery percentage (AD-3).

**Request contract** (`lib/grading/request.ts`). Curriculum is still
browser-local, so the browser sends the narrow slice needed to grade one
attempt: the concept's identity, title, summary, status and `SourceRef`, the
one retrieval item, and the answer. Unknown keys are rejected at every level,
so a client cannot supply a prompt, instructions, model or provider options.
The route rejects: a `status` other than ACTIVE (422), an item whose
`conceptId` is not the concept (400), a missing or empty source excerpt or
cross-lecture provenance (400), an empty answer (400), an answer over 4,000
characters (413), and bodies over 256 KB (413). Error bodies are
`{ code, error, retryable }` with fixed strings. The browser shows messages by
code from its own table.

**The route's ACTIVE check is not authoritative.** The server has no
curriculum of its own yet, so `status`, rubric and source are whatever the
caller sends. A direct caller can forge `status: "ACTIVE"`. The route check
validates client-supplied state. It catches bugs and honest mistakes, not a
determined caller. The authoritative approval gate for the legitimate app
is the domain/engine gate (`assertActive` in `resolveAttemptTarget`, run
before the request is built and again before the grade is applied). It
remains mandatory. A server-authoritative gate needs server-side curriculum
(Milestone 4). See AD-22 for why this matters before any paid provider.

**Provider output is untrusted, and the server owns the final GradeResult.**
`lib/ai/grade.ts` enforces a 12 s timeout per provider call and validates the
provider's grade. It then builds the GradeResult itself:

- `outcome` and `correct` come from the provider; they must agree.
- `matched` and `missing` come from the provider, restricted to the item's
  reviewed vocabulary (rubric synonyms and accepted answers) and
  de-duplicated in stable order.
- `normalizedAnswer` is always `normalize(answer)`, computed by MedRecall.
  The provider's value is discarded, and the browser rejects a reply whose
  `normalizedAnswer` is not the normalization of what it sent.

**What `matched` and `missing` mean.** They are explanatory metadata: which
reviewed terms the grader found, and which it judged absent. Only the
**outcome** drives mastery and FSRS. `missing` is used for exactly one thing,
naming missed terms in the deterministic remediation. The contract, enforced
by `isValidGradeResult` at every boundary (provider → route, route → browser,
browser → engine): **a CORRECT grade carries no missing terms.** INCORRECT
and PARTIAL are deliberately not further constrained. A semantic grader may
judge an answer insufficient even when every keyword appears, and PARTIAL
policy is Stage B.
Every provider failure is a neutral, retryable 502/504 with no exception text,
stack, path, prompt or raw provider response.

**Atomicity.** `lib/session/submitAnswer.ts` calls the engine only after a
validated grade exists and the precondition still holds (AD-20). Any failure
returns the learner state untouched. A failed grading request is not a failed
retrieval attempt: no attempt counter, no WEAK, no FSRS lapse, no interleaving
bookkeeping. A single-flight guard plus a disabled button stop a double tap
from recording two attempts.

**Reason.** A model call can fail, time out, return malformed output, or
disagree with the deterministic grader. When grading and mutation were fused
in one synchronous client function, none of that could be handled without
risking a partially applied attempt. Separating them also makes the learning
rules (AD-4, AD-5) independent of who graded. A lenient model cannot clear
WEAK from an immediate-remediation answer, because that rule lives in the
engine, not the grader.

**Tradeoff.** Grading now needs a network round trip, so offline use of the
learning loop is lost. While curriculum stays browser-local, the server grades
against the rubric the browser sends. The boundary protects learner state and
keeps provider code server-side. It does not make grading tamper-proof against
the learner's own browser, nor stop a direct caller. The first is no weaker
than before, because the learner already owns their local state. The second
is harmless while the provider is free (AD-22).

**Future implication.** A real model grader is an adapter implementing
`GradingProvider.gradeFreeAnswer` plus a `getGradingProvider()` binding. It is
refused until the AD-22 safeguards exist, and binding it cannot affect
extraction (AD-23). The tutor engine, `submitAnswer`, the UI and the
response contract do not change. Stage B adds the PARTIAL mastery policy and
disagreement logging. `tests/unit/grade-parity.test.ts` must keep passing for
the deterministic provider.

---

## AD-20 — A pending grade applies only to the state it was made against

**Decision.** Optimistic concurrency on every asynchronous attempt. At submit,
`captureAttemptPrecondition()` records the concept and item ids, this
concept's progress version (`totalAttempts`, `lastAttemptAt`, the FSRS
`last_review`) and `gradingTargetFingerprint()`. The fingerprint is a
deterministic serialisation of every field grading depends on: the concept's
identity, title, summary and status, its full `SourceRef`, and the item's id,
kind, prompt, rubric, accepted answers and explanation. When the grade
arrives, `recordGradedAttempt(..., precondition)` refuses with
`StaleAttemptError`, before touching anything, if:

- the ids differ (`TARGET_MISMATCH`);
- the concept, item, rubric or source changed (`TARGET_CHANGED`);
- this concept was attempted since, in this tab or another (`PROGRESS_CHANGED`);
- the attempt time is earlier than the card's `last_review` or the concept's
  last attempt (`OUT_OF_ORDER`). FSRS is never run backwards.

The precondition is captured from the state the learner was shown. The grade
is applied to the freshest persisted state: `LearnerProvider.snapshot()`
reads localStorage, so another tab's write is seen even before its storage
event arrives. Progress on other concepts does not invalidate the attempt and
is preserved rather than overwritten. A stale grade shows "This question has
moved on" with a Continue button, and nothing is recorded. It is not an error
to retry: the learner is taken to the current question.

**Reason.** Grading became asynchronous. Without this, a grade computed while
another tab answered the same question was applied on top, recording one
question twice and advancing mastery and FSRS twice. That was reproduced in
the E2E suite before the fix: two attempts for one question. A grade computed
against an old rubric could also be credited to an edited item.

**Tradeoff.** Legitimate concurrent use, such as two tabs on the same question,
discards the slower answer instead of merging it. If the device clock runs
backwards past a card's last review, attempts on that concept are refused as
OUT_OF_ORDER until the clock passes it again. Both are deliberate: safety of
the schedule over availability of one attempt. localStorage has no
transactions, so a write from another tab between the snapshot read and this
tab's write can still be lost. This is the pre-existing multi-tab limit,
narrowed rather than removed.

**Future implication.** Server-side learner state (Milestone 4) should make
the same precondition a real compare-and-swap on the stored record.

---

## AD-21 — Remediation is composed from reviewed material, never written by a provider

**Decision.** The provider decides whether remediation is needed (the outcome)
and which of the item's own rubric terms were missed. The learner-facing text
is assembled deterministically on the server by `composeRemediation()` in
`lib/grading/remediation.ts`, from exactly three parts:

1. a fixed sentence naming missed terms, restricted to terms already in the
   item's reviewed rubric or accepted answers (`restrictToReviewedTerms`);
2. the item's reviewed `explanation`;
3. the concept's verbatim `SourceRef` excerpt, document and page.

`generateRemediation` is no longer part of `AiProvider`, and the grading
service never calls a provider for text.

**What a future hosted model may create: no learner-facing medical prose at
all.** Its influence on what the learner reads is limited to the verdict and a
selection among the item's own reviewed terms. Enabling model-written
explanations would need a new, structured grounding contract and its own
review. It cannot happen through this path.

**Why not "remediation must quote the excerpt"?** Stage A first shipped that
check, and it is not grounding. A paragraph can quote the source verbatim and
add invented medicine around it. A regression test shows exactly that passing
the old check. The check survives only as `quotesSourceExcerpt()`, a
provenance tripwire on our own composer's output, and is documented as never
admitting free-form text.

**Tradeoff.** Remediation stays as good as the reviewed explanation, no
better. Richer re-teaching waits for a grounding contract.

---

## AD-22 — No paid hosted provider without server-side abuse control

**Decision.** `AiProvider.hosted` declares whether a provider costs money or
reaches a third party. Both role resolvers, `getGradingProvider()` and
`getExtractionProvider()`, always return through `assertProviderPermitted()` (`lib/ai/policy.ts`), which refuses any provider
that is not explicitly `hosted: false` unless every
`HOSTED_PROVIDER_SAFEGUARDS` flag is true, for each role independently. The only flag, `abuseControl`, is
false and frozen, because none exists: no authentication, rate limiting or
spend quota on `/api/grade` or `/api/ingest`.

**Reason.** The server cannot authenticate callers or verify approval yet
(AD-19). Anyone can POST a forged ACTIVE concept to `/api/grade`. With the
deterministic provider that costs nothing. With a paid model it is an open
relay for spend and abuse.

**Stage B prerequisite.** Before any hosted provider is bound, implement
server-side abuse control on every route that calls it: authentication,
per-user or per-IP rate limiting and a spend quota, or an equivalent
protection. Set `abuseControl: true` only in that same reviewed change.
Changing an env var alone cannot enable a paid model.

## M2 audit corrections

Teaching payloads now contain only ACTIVE concept summaries and their own source
excerpts. Raw stored chunk prose and full source pages are not lesson content.
PDF identity is computed before pdfjs detaches its input buffer and includes the
filename, original bytes, course and lecture using SHA-256. Same-lecture repeated
uploads are idempotent, retaining chunk order and existing review decisions.

Stored curriculum version 3 quarantines ACTIVE concepts from legacy 8-digit PDF
identities as DRAFT once during migration. Those approvals may have survived a
same-name content replacement; the missing original bytes cannot be recovered.
Authored Milestone 1 approvals and modern identities are preserved. A deliberate
new review after migration persists normally. The Concept model is unchanged.

Human edits rebuild retrieval prompts, answers and feedback from the reviewed
wording while retaining the immutable SourceRef. Failed storage writes produce a
visible warning, and other-tab status changes refresh the learning gate.

---

## AD-23 — One provider resolver per role: grading and extraction are decoupled

**Decision.** There is no single `getProvider()`. Each role has its own
resolver in its own module:

| Role | Resolver | Module | Sole caller |
|---|---|---|---|
| Grading | `getGradingProvider(): GradingProvider` | `lib/ai/gradingProvider.ts` | `POST /api/grade` |
| Extraction | `getExtractionProvider(): ExtractionProvider` | `lib/ai/extractionProvider.ts` | `POST /api/ingest` |

Both currently return `DeterministicProvider`, through the AD-22 tripwire.
Routes import their resolver module directly, never the `lib/ai` barrel. The
resolver modules do not import each other, and any future configuration for a
role is read in that role's module only.

**Reason.** Stage B introduces a hosted model **grader** only. With one shared
resolver, binding it would have changed Milestone 2 PDF extraction too, made
uploads call a paid model, and forced the grading adapter to implement
extraction. Each of those is a separate decision that deserves its own
review.

**Enforcement.** `tests/unit/client-boundary.test.ts` requires that the only
modules reachable from BOTH resolvers are `deterministic.ts`, `policy.ts`,
`provider.ts` and their own dependencies, checked on the real runtime import
graph with no filenames special-cased. A shared resolver, factory, config or
env-reading module, inside `lib/ai` or anywhere else, fails it. Three
mutations (a shared resolver in `lib/ai`, per-role config modules that both
read one switch outside `lib/ai`, and a differently named factory) each failed
this test. The first of those had passed every earlier test.
`tests/unit/provider-separation.test.ts` checks that each route calls only its
own resolver, that substituting one role leaves the
other's output byte-identical, that a hosted grader stand-in is never used for
extraction, and that a grading-only provider type-checks without
`extractConcepts`. `tests/unit/client-boundary.test.ts` walks the import graph:
the grade route reaches the grading resolver and not the extraction one, and
vice versa, and neither route reaches the barrel. A mutation that routed
ingestion through the grading resolver failed five of these tests.

**Future implication.** Changing extraction to a model is its own Stage, with
its own resolver change, safeguards and review.

---

## AD-24 — Anki-first at the learner experience layer; Concept stays internal

**Decision.** The learner studies CARDS in an Anki-style loop: front, **Show
Answer**, back, then **Again / Hard / Good / Easy**. Each `RetrievalItem` of an
ACTIVE Concept is one card (`lib/engine/study.ts`, `/study/[lectureId]`). The
Concept remains the internal semantic entity: it owns approval status,
`SourceRef` provenance and mastery, and every card cites its concept's source.
Study UI never shows approval vocabulary (ACTIVE, DRAFT, chunks).

**How it works.**

- `studyCardsForLecture` yields ACTIVE concepts' items only, and skips an item
  whose `conceptId` is not its concept's.
- `buildStudyQueue` classifies cards as New, Learning or Review from their FSRS
  state. It orders due learning, then due review, then new, then learning due
  within a 20-minute learn-ahead window, and reports counts derived from the
  same classification.
- `recordCardRating` is pure. It checks the approval gate and item membership,
  runs exactly one FSRS transition for the card, applies one concept mastery
  transition, then reconciles.
- Revealing the answer records nothing. No grading request is made: the
  self-rating is the assessment. `/api/grade` and the typed-answer tutor are
  unchanged and still available.

**Reason.** The product correction: learners expect Anki's interaction model.
Keeping the Concept underneath preserves everything the earlier milestones
built: the approval gate, provenance and mastery.

**Tradeoff.** Two study modes coexist, the guided tutor and card study. They
share concept mastery but not scheduling state (see AD-25). Study is not gated
by the tutor's lecture-order lock: Anki has no such lock, and only approved
content is studyable either way.

## AD-28 — Lecture → flashcards: cards are the learner-facing object, Concepts stay underneath

**Decision.** The default experience is *upload a lecture PDF → choose
language and count → generate → review → study*. Nothing in the Concept-first
architecture is replaced: every generated card is one DRAFT Concept with one
RetrievalItem, enters through the same approval gate, keeps a full
`SourceRef`, feeds the same mastery, and is scheduled by the same FSRS. The
Tutor remains available on the demo course.

- **Generation is a third provider role** (`CardGenerationProvider`,
  `getGenerationProvider()`, `POST /api/generate`), resolved separately from
  grading and extraction (AD-23) and behind the same hosted-provider gate
  (AD-22). The deterministic implementation (`lib/generation/`) extracts
  grounded facts — definitions, superlatives ("X is the most common cause of
  Y"), mechanisms (cause given, consequence blanked), bullet lists under a
  heading, statements as clozes, figures — scores them for medical retrieval
  value, drops administrative slides, de-duplicates (content-word overlap,
  and never two cards with the same question), and phrases them in the
  requested language's scaffolding. Ids are deterministic
  (`${document}-p${page}-f${fact}`), so *Generate more* adds only new facts
  and existing cards keep their FSRS history. A requested count is never
  padded: the maximum useful set is returned with a `shortfall`; AUTO keeps
  facts at or above a score threshold.
- **Arabic cards are rendered from the fact's structure, never wrapped**
  (`lib/generation/arabic.ts`). A sentence is split into noun phrases and
  the connectors between them; connectors, verbs and question words are
  Arabic, so question AND answer are Arabic sentences. A noun phrase is
  rendered as a whole or kept exactly as written — never word by word, which
  would scramble Arabic word order. `ar-en` keeps medical noun phrases in
  English; `ar` writes the ones its general lexicon knows in Arabic with the
  English in brackets and puts adjective + noun phrases in Arabic order.
  Templates exist for the generator's fact kinds; anything else becomes an
  Arabic fill-in-the-blank, and a card whose sentence kept an English clause
  is counted as `partial` and disclosed in the UI. The source excerpt stays
  the lecture's verbatim English; View source shows it. Full translation is
  a hosted-generator capability behind the same boundary. Arabic text is
  laid out with `dir="auto"`.
- **An image question needs a visual answer the image supports.** Captions
  and labels come from the page's positioned text (`annotateFigures`):
  the caption is the text in a narrow band just outside the figure; labels
  are the text inside it. Only a raster figure with a caption becomes a
  question, answered by that caption, and not when the answer is printed
  inside the picture. A sentence elsewhere on the slide never answers an
  image. A labelled diagram is not a question (it shows its answer); it
  illustrates the back of text cards that share a specific word with its
  caption or labels, and a figure with neither is attached to nothing.
  Figures whose rendered content is identical (a perceptual hash) keep one
  question when their captions agree and none when they contradict; an
  image question that only repeats a text card is dropped.
- **Generation reads the lecture's documents, not "the" document.** A
  lecture may hold several PDFs (*Add a PDF*); *Generate more* reads all of
  them or the one chosen, de-duplicates against the whole lecture, and every
  card keeps its own document, page, excerpt and image.
- **Visual material is original and geometric.** Every page is rendered in
  the browser (pdfjs legacy build) and stored in IndexedDB
  (`medrecall.assets.v1`) with figures cropped from it; figures are found
  from operator lists (`lib/visuals/analyze.ts`): raster images large enough
  to look at, vector diagrams (path density and bounds), whole-page images;
  logos and repeated template images (same place and size on several pages),
  icons, rules and pixel placeholders are rejected. A card stores only a
  `CardImage` reference (asset id, document, page, region, placement);
  malformed references are dropped record-locally like every other stored
  field. No image is ever synthesised. Reset clears the asset store.
- **The session composer orders; FSRS schedules** (`lib/engine/session.ts`).
  While studying one lecture, cards of other lectures that are overdue (due
  more than a day ago), due, or near due (within 24 h) are inserted about
  one after every four current cards, most urgent first, each at most once;
  when the current queue is exhausted the owed overdue/due reviews follow
  (near-due ones do not). The composer never reads or writes a due date;
  rating an inserted card is the ordinary `recordCardRating` on its own
  concept, so ownership, provenance and history are unchanged. New cards are
  never inserted (FSRS has no memory of them), nor suspended or buried ones.
  Inserted REVIEW-queue cards draw on the existing *reviews per day*
  allowance — what today's reviews and the lecture's own shown reviews
  leave — most urgent first; learning cards are never limited, as in any
  queue. An old card rated in the session is remembered: it returns only
  when FSRS makes it due again (Again's relearning step), never as
  near-due, so Hard, Good and Easy do not bring it back early.
- **One commit per upload.** The lecture, its document, chunks, figure
  metadata, cards and language are stored in a single `commitOverrides`
  mutation, so an interrupted upload leaves nothing half-made.

## AD-27 — Duplicate candidates across documents: suggested, merged by a reviewer

**Decision.** Extraction de-duplicates by title within one document only;
across documents the same idea arrives twice. Detection
(`lib/domain/duplicates.ts`) is deterministic and purely textual — equal
normalised titles, or summary content words with Jaccard overlap ≥ 0.6 when
both summaries have at least three content words (a one-word summary such
as "cells" overlaps itself completely and says nothing) — and only ever a
suggestion. Merging is a reviewer's explicit decision
recorded in the curriculum overrides (`merges`: duplicate → canonical;
`keptApart`: rejected suggestions), like approval and edits (AD-16).

- **The duplicate is DISCARDED** (`mergedInto` set on the composed concept);
  no stored status can resurrect it while the merge exists. It therefore
  never enters teaching, retrieval, Study, mastery, scheduling, Today or
  interleaving on its own — the approval gate is unchanged.
- **The canonical's status is never changed** by a merge; approving stays a
  separate decision. It gains the duplicate's `SourceRef` as
  `additionalSources` ("Also in …"); its own `source` stays the reviewed one.
- **Teaching chunks that named the duplicate name the canonical** instead,
  de-duplicated, so the duplicate's page is still teaching material for the
  idea: a generated chunk's TEACH excerpts now come from any of the
  concept's sources on that chunk's document and page (own source or an
  additional one). If the canonical was already retrieved by the Tutor and is
  not pending remediation, the chunk completes once taught — the idea was
  tested already. Lecture completion and unlocking rules are unchanged.
- **Study:** the canonical's cards stay in its own lecture's deck, once; the
  duplicate has none.
- **Learner state is not touched.** Progress and card records under the
  duplicate's id remain stored and unused; undoing the merge (which returns
  the duplicate to DRAFT, never ACTIVE) brings nothing back automatically.
- **Chains and cycles:** merge targets resolve through chains; a merge that
  would form a cycle is refused, and a dangling or cyclic stored merge is
  ignored rather than trusted.
- Detection ignores DISCARDED and merged concepts and never pairs two
  concepts of the same document.
- **Concurrent tabs cannot undo a decision by accident.** Every curriculum
  mutation is applied to what is stored *now* (`commitOverrides`), never to
  the tab's in-memory snapshot: a tab that has not seen another tab's merge
  and then edits an unrelated title, approves, or clicks Keep both rebases
  that decision onto the current store, so the merge stays. A decision about
  a merged duplicate (approve, Keep both) is not recorded while the merge
  exists; Undo merge is the explicit way back. No timestamps or backend are
  involved; the snapshot is used only when storage has nothing to read.
- **Malformed stored merge state is isolated, never fatal.** `merges` and
  `keptApart` are validated entry by entry: a malformed entry is dropped on
  its own and the cleaned store is written back; documents, concepts and
  every other decision load. `mergedInto` and `additionalSources` are
  derived fields and are never trusted from storage — `mergedInto` is
  stripped (the merge map is the only source), and only well-formed
  `additionalSources` entries are kept — so nothing malformed can reach the
  Tutor's TEACH step or a Study card, and recovery never changes a status.

## AD-26 — Decks, browser, suspend/bury, custom study: derived over Concepts

**Decision.** Step 2 adds deck and browser views, per-card Study flags, card
wording edits, custom study and daily limits — all as derivations over the
existing Course → Lecture → Concept → RetrievalItem model and each card's own
FSRS state. There is no deck entity, no deck membership, no second tagging
system, and no second scheduling engine.

- **Decks are lectures** (`lectureDecks`, `courseDeck`): each is its ACTIVE
  concepts' cards, computed on every render. Approving, editing or discarding
  a concept changes the deck at once; DRAFT/DISCARDED cards are never in one.
  Counts come from `buildStudyQueueFor` over those cards — Card FSRS state
  with the daily limits applied — never from concept mastery. The course
  deck's new/review counts come from the course-wide queue, so the limits
  (per learner, not per deck) apply once.
- **The browser** (`browseCards`) lists cards with concept, lecture, source
  document and Study status (`NEW | LEARNING | REVIEW | SUSPENDED | BURIED`,
  plus a due-now filter). Filters use existing metadata: lecture, item kind,
  concept importance, status, text.
- **Suspend / bury are Study flags** in `LearnerState.cardFlags` (keyed by
  item id, carrying the concept id so quarantine can strip them). They only
  remove a card from the queue: `cards[*].schedule`, reviews and concept
  mastery are untouched, resume continues the schedule exactly, and a
  suspended card is never Tutor evidence (`hasTutorAttempt` reads the
  concept schedule only). Bury stores `buriedUntil` = the next local midnight
  computed from `now` (deterministic; no "today" boolean); expiry is simply
  that time passing. Suspend and bury are distinct states. Both go through the
  approval gate (`resolveAttemptTarget`).
- **Card edits** (`CurriculumOverrides.cardEdits`, keyed by item id) apply
  after concept edits have rebuilt items, changing only `prompt` and
  `explanation`. The item id, rubric, accepted answers, source excerpt and
  concept status are unchanged, so Card FSRS history is kept and DRAFT stays
  DRAFT; the content fingerprint changes, so a rating revealed against the
  old wording is refused as stale (AD-20). The Tutor asks the edited wording
  too — one card, one truth. Known: an authored concept's *first*
  title/summary edit rebuilds its item ids, orphaning card edits keyed by the
  old ids.
- **Custom study** (`resolveStudySelection`) only decides WHICH cards are in
  the queue: a lecture, every due card across the course (no new cards), or a
  browser filter. The queue, ordering and `recordCardRating` are the same;
  FSRS is never altered. The one option is ignoring the daily limits. The
  selection lives in the URL so a refresh resumes it.
- **Daily limits** (`StudyLimits`: new per day, reviews per day; defaults
  20/200) are preferences in `medrecall.study-settings.v1`, validated as
  whole numbers in [0, 9999], untouched by a learner Reset. Today's tally
  (`learner.studyDay`, in the Study sidecar) is kept by `recordCardRating`: a
  first rating introduces a new card; rating a Review-queue card is a review;
  learning steps count as neither. `buildStudyQueueFor` holds back new cards
  and due reviews beyond today's remaining allowance and reports them as
  `heldByLimits`; learning cards are never held back.
- **Persistence.** Flags and the tally travel in the Study sidecar
  (`{ version: 2, generation, cards, flags?, studyDay? }`), so a stale main
  tab cannot erase them and they are bound to the learner generation like
  cards. Malformed flags are dropped one by one; a malformed tally as a whole.
  A save whose state carries no `cards` keeps the stored cards, and keeps
  stored flags and tally the state does not mention.

## AD-25 — FSRS schedules each card; self-ratings feed concept mastery

**Decision.** `LearnerState.cards` (optional, keyed by item id) holds each
card's own FSRS schedule, review count and last rating, as Anki schedules each
card of a note separately.

- **Additive.** State saved before card study has no cards and loads
  unchanged. Card records are validated one by one, and the legacy-identity
  quarantine also strips card schedules of untrusted concepts.
- **Stored in their own key, `medrecall.study-cards.v1`** (`{ version: 2,
  generation, cards }`), not in the learner envelope. A browser tab still
  running main rewrites `medrecall.learner.v1` with only the fields main
  knows, so cards kept there would be erased by any main save; main never
  touches the sidecar. `LocalStorageLearnerRepository` owns both keys.
- **Bound by a learner generation.** The mere existence of an envelope never
  attaches a sidecar: a Reset in a main tab removes only the envelope, and
  main's next fresh learner must not inherit the old cards. The generation is
  a random id (never a timestamp), minted by this build's first save of a
  learner that has none, written in the envelope's own `generation` field and
  stamped as `generation` on every stored concept record, and written into
  the sidecar. main drops the envelope field but keeps every concept record
  as stored, so the stamps survive an ordinary main write; a Reset, in any
  build, removes every record, so nothing survives it. A sidecar is accepted
  only when the envelope carries its generation (field or any stamp). The
  stamp is a persistence-only field, stripped on load, so in-memory state and
  types are unchanged. A version-1 sidecar (unmerged preview builds of this
  PR) has no generation and is treated as unbound.
  - **Load:** the envelope as before; card progress from a valid sidecar of
    the envelope's generation (malformed records dropped one by one); else
    from `cards` inside the envelope — state written by earlier builds of this
    PR — migrated and moved to the sidecar by the next save; else none.
    Quarantine runs on the merged state and its result is saved through the
    repository, so removed cards leave the sidecar and cannot return.
  - **Save:** the generation is the stored envelope's (field or first stamp),
    or new. The sidecar first, then the envelope without `cards`, and the
    envelope only if the sidecar write succeeded. localStorage cannot write
    two keys atomically: if the sidecar write fails nothing is written (the
    last saved pair stays); if the envelope write fails afterwards, cards are
    the newer and concept progress the last saved (no card is lost; at most
    one save's mastery change is; both carry one generation). Both return
    `false`, and the app shows its storage-error banner. A state with no
    `cards` at all never erases the sidecar of the same generation; a sidecar
    of another generation is an orphan and is removed. Two tabs minting a
    generation for the same new learner in the same instant would leave one
    sidecar an orphan; the window is a single save.
  - **Clear** (Reset) removes both keys.
  - **Cross-tab:** `LearnerProvider` re-reads both keys on a storage event for
    either, so an envelope written by a main tab (no cards) never drops this
    tab's cards, and another tab's card ratings become visible here. A
    storage event that *removed* the envelope (`newValue === null`, or
    `localStorage.clear()`) is a Reset made elsewhere — a current tab or a
    main tab — and resets this tab's in-memory learner at once, so its next
    rating cannot write the cleared progress and cards back. Syncing writes
    only when quarantine removed something, so it cannot loop.
- **Schedules are validated against the installed FSRS.** `state` must be one
  of ts-fsrs's own `State` values (New, Learning, Review, Relearning), and a
  card with a memory state must meet the library's `next_state` precondition
  (difficulty ≥ 1 and stability ≥ `S_MIN`; an empty memory state, 0/0, is a
  New card). A stored `state: 99` used to pass validation and then throw
  inside FSRS on the next rating, taking the Study session down; it is now
  dropped on load like any malformed record — that card alone, with the
  learner's other cards and concept progress kept. The same validator covers
  the Tutor's concept schedules; every schedule real `main@482824c` writes
  (19,614 checked) satisfies it. Counters such as `learning_steps`, `reps`
  and `lapses` are still only required to be finite: FSRS tolerates
  out-of-range values there without throwing.
- **Ratings map one-to-one** (`FSRS_RATING`): Again→Again, Hard→Hard,
  Good→Good, Easy→Easy. This is a separate path (`scheduleAfterRating`) from
  the graded-answer `ratingFor`, which is untouched and never produces Easy.
- **Interval previews** (`previewRatings`) are pure.
- **Concept schedule untouched.** The concept-level `ConceptProgress.schedule`
  used by the tutor is not advanced by card study. Advancing it for every
  sibling-card rating would over-advance the concept, since several cards of
  one concept can be rated in one session.

**Invariant: card FSRS and tutor concept FSRS are distinct.**

- **Card study may update shared concept mastery.**
- **A never-reviewed concept schedule is not a tutor schedule.** Card study
  can create a concept's progress record, with an untouched schedule whose
  `due` is its creation time. That placeholder must never count as a due tutor
  review.
- **`isDue` enforces this.** It returns true only when the concept schedule
  has recorded at least one concept-level FSRS review (`schedule.reps > 0`)
  and is due. It is used by the Today queue, the priority score and
  cross-lecture interleaving.
- **Why `reps > 0` is the right test** (verified against ts-fsrs 5.4.2):
  - An empty card has `reps` 0; any review makes it at least 1.
  - Every tutor attempt runs FSRS, so tutor-scheduled concepts are unaffected.
    The tutor-parity oracle (the same random journeys through the real
    grading route on both trees) is byte-identical against `main`.
  - A placeholder schedule later reviewed by the tutor schedules exactly as a
    fresh one would.
- **WEAK still surfaces regardless of due state**, so a card rated Again
  appears in Today and can be interleaved.
- **Where card-level due lives.** A card studied Good or Easy is due in Study
  (its own schedule), not in the tutor's Due recall.

**Mastery semantics (`applySelfRatingToMastery`).** The context comes from the
card's FSRS state before the rating, never from the UI:

- **AGAIN:** a failed retrieval. WEAK, streak reset (the existing rule).
- **HARD:** recalled with difficulty. Counts as an attempt and as correct.
  Never a spaced success: it does not advance the streak and never clears WEAK.
  A NEW concept becomes LEARNING.
- **GOOD / EASY:** success under the existing rules for the card's context.
  - **New card:** first exposure, NEW→LEARNING.
  - **Learning/Relearning card:** immediate-remediation success. It does NOT
    clear WEAK.
  - **Review card** (came due after an interval): spaced success, which
    advances the streak and can clear WEAK.
  - Good and Easy have the same mastery effect; only FSRS differs.

**Conflict with the Step 1 brief, documented.** The brief suggested GOOD
counts as a successful *spaced* retrieval. Applied to a card re-shown a minute
after Again (a Relearning step), that would clear WEAK immediately. That
contradicts AD-4, the product's central rule that recognition straight after
seeing the answer is not recall. So Good/Easy count as spaced success only for
a Review-state card.

Known limitation: a concept with several cards can have WEAK cleared by a
*different* card that happens to be in Review state and due soon after a
lapse. This is spaced by FSRS's definition, not by wall-clock time since the
failure.

**Invariant: Study shares mastery with the Tutor, never Tutor evidence.**
Concept mastery and `totalAttempts` are shared aggregate history. Whether the
**Tutor** retrieved a concept is answered only by the concept-level FSRS
schedule, which only Tutor attempts advance: `tutorAttemptCount(progress) =
schedule.reps` and `hasTutorAttempt(progress) = reps > 0`. For learner state
from before card study, `reps === totalAttempts`. The tutor-parity oracle
against `main@482824c` is byte-identical: 2,273 records covering
TEACH, INITIAL retrieval, remediation, interleaving, item rotation, FSRS and
72 lecture completions and unlocks.

Tutor decisions that now require Tutor evidence:

- **Untested detection:** a concept rated only in Study still gets its Tutor
  RETRIEVE step.
- **Completion:** chunk completion, `reconcile`'s monotonic-completion and
  reopen rules, and therefore lecture completion and unlocking. Study ratings
  alone never complete a chunk or lecture or unlock the next lecture. Chunks
  legitimately completed through the Tutor stay complete.
- **Item rotation (`pickItem`):** Study ratings never change which
  representation the Tutor asks.
- **Immediate remediation (`pendingRemediation`):** requires a Tutor attempt
  AND explicit pending state — see the next invariant. `getNextStep` considers
  only the current lecture and earlier lectures, so a later or locked lecture
  never interrupts an earlier one. Tutor failures, including INTERLEAVED
  failures on earlier-lecture concepts, are still re-taught at once.

Deliberately still aggregate:

- the Today queue's WEAK surfacing;
- interleaving candidates, which come from earlier lectures only;
- the dashboard's "concepts started";
- the Tutor's stale-grade precondition, which conservatively treats any rating
  of the concept as a change.

**Invariant: pending Tutor remediation is explicit state, not WEAK.**
`ConceptProgress.pendingTutorRemediation` records that a failure the TUTOR
must immediately re-teach is outstanding. It is never derived from mastery,
because mastery is shared: deriving "pending" from `WEAK && reps > 0 &&
!immediateRemediationPassed` turned a Study AGAIN made *before* the Tutor ever
asked about a concept into a Tutor remediation as soon as the Tutor's first
retrieval succeeded (INITIAL success leaves WEAK in place). `pendingRemediation
= pendingTutorRemediation && reps > 0 && WEAK`.

| Event | `pendingTutorRemediation` after |
|---|---|
| New progress (`createProgress`) | false |
| Tutor INITIAL / SPACED / INTERLEAVED / remediation **incorrect** | true |
| Tutor IMMEDIATE_REMEDIATION **correct** | false (mastery unchanged: still WEAK, AD-4) |
| Tutor INITIAL / SPACED / INTERLEAVED **correct** | unchanged while WEAK; false once no longer WEAK |
| Study AGAIN, concept **never** retrieved by the Tutor | false — the Tutor teaches and retrieves it normally first |
| Study AGAIN, concept already retrieved by the Tutor | true — re-taught on the next Tutor visit to its lecture or a later one; completion is not revoked |
| Study HARD / GOOD / EASY | never sets it; unchanged while WEAK, false once no longer WEAK |

- **Pure Tutor is unchanged.** For a Tutor-only learner the transitions give,
  at every step, exactly main's rule (`totalAttempts > 0 && WEAK &&
  !immediateRemediationPassed`). Checked by a unit table (every context ×
  outcome × starting state), by the grade-parity suite (whole-state equality
  against main's `recordAttempt` at every step), and by the oracle against
  real `main@482824c`: 2,273 records byte-identical with the field stripped,
  and the field equal to main's rule in all 19,614 per-concept checks.
- **Study never satisfies the Tutor's remediation.** A Study success on a
  Learning/Relearning card (re-study right after Again) still sets
  `immediateRemediationPassed`, as before, but no longer clears a pending
  Tutor remediation: only the Tutor's own IMMEDIATE_REMEDIATION does. The one
  exception is shared mastery: a Study spaced success (Review-state card) that
  lifts the concept out of WEAK leaves nothing to remediate.
- **`immediateRemediationPassed` keeps its meaning** — the learner followed a
  remediation — and is not a proxy for where a failure came from.
- **Migration, no timestamps.** Learner state saved before the field existed
  (main before card study) has no Study history, so main's rule is exact for
  it: `sanitizeLearnerState` derives the field on load from `reps > 0 &&
  WEAK && !immediateRemediationPassed` (`reps === totalAttempts` there).
  `LEARNER_STATE_VERSION` is unchanged, so no state is discarded. A present
  but non-boolean value makes the record malformed and it is dropped, like any
  other malformed field.
- **Mixed versions: per-concept provenance.** A browser tab still running
  main after this deploys shares `medrecall.learner.v1`. main keeps every
  concept record exactly as stored (our fields included) but rebuilds the
  envelope, and its own Tutor attempts leave our flag untouched — so after a
  main write a stored flag may be stale for the concepts main changed, and
  still exactly right for every other concept. An envelope-level marker
  cannot tell those apart (main drops it on any write, which re-derived every
  flag and could turn a legitimate `true` into `false`). So each record
  carries `pendingTutorRemediationRevision`: the concept's Tutor schedule
  revision (`tutorScheduleRevision` = `reps|last_review`) at which the flag
  was decided, written by `withPendingTutorRemediation` on every transition.
  Every Tutor attempt in any build runs FSRS and changes that revision; Study
  never touches the concept schedule. On load:
  - flag and revision present, and the revision equals the record's current
    Tutor schedule revision → the stored flag is trusted exactly;
  - otherwise (field absent: main's own state or an earlier build of this PR;
    or the revision differs: main made a Tutor attempt on this concept since)
    → main's rule decides, which is exact for whatever main did.

  Invariant: a stored flag is trusted after an old-main write only if that
  concept's Tutor schedule revision still matches the one it was recorded
  at. Tested with main@482824c's real repository and engine, taken from git
  at test time (`tests/base-main`): main changing another concept keeps a
  legitimate `true` (and a legitimate `false`); main remediating the concept
  is not resurrected; a main failure on the concept is recovered.

  One case follows main rather than this build: WEAK from a Study AGAIN made
  before the Tutor, then a Tutor attempt made *in the main tab*. main's rule
  then reports pending — exactly the remediation main's own tab showed.

**Concurrency and content.** `captureCardPrecondition` is taken when the
answer is shown. It records the card's progress version and
`gradingTargetFingerprint(concept, item)`. That is the same definition that
protects graded attempts (AD-20), so the two cannot drift. It covers:

- the concept's identity, title, summary and status;
- the full `SourceRef`;
- the item's id, kind, prompt, rubric, accepted answers and explanation.

The rating is applied to the freshest persisted state and refused with
`StaleAttemptError`, before any mastery or FSRS transition, in these cases:

- the card was rated since (another tab, or a repeated tap);
- its content, source or status changed since Show Answer (`TARGET_CHANGED`);
- the concept left ACTIVE (`ConceptNotActiveError`).

So one showing yields at most one review, always of the content that was
shown. FSRS is never run backwards.

**Card identity across edits.** A human edit rebuilds a concept's retrieval
items as `${conceptId}-r1` / `-r2` (`buildRetrievalItems`):

- **Ingested (PDF) concepts** already use those ids, so their cards keep their
  ids and FSRS progress across ordinary edits, as in Anki.
- **Authored demo concepts** start with their own item ids (`c-atp-1`, …). The
  *first* edit replaces those, so their old card progress no longer matches a
  card and the rebuilt cards start as New. Concept mastery, keyed by concept
  id, is kept. Later edits keep the ids stable.
- **In every case** a rating already in progress against the old content is
  refused.

