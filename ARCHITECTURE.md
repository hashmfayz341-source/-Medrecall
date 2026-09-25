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

## AD-25 — FSRS schedules each card; self-ratings feed concept mastery

**Decision.** `LearnerState.cards` (optional, keyed by item id) holds each
card's own FSRS schedule, review count and last rating, as Anki schedules each
card of a note separately.

- **Additive.** State saved before card study has no `cards` and loads
  unchanged. `sanitizeLearnerState` validates card records one by one, and the
  legacy-identity quarantine also strips card schedules of untrusted concepts.
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
    The independent tutor-parity oracle, 2,033 attempts against `main`, is
    byte-identical.
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

