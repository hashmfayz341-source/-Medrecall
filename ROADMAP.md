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

## Milestone 2 — Real content ingestion

- [ ] PDF and slide upload with page-level text extraction
- [ ] Model-backed `extractConcepts()` behind the existing interface
- [ ] Concept review queue at volume: bulk approve, edit, merge duplicates
- [ ] Prerequisite graph inferred from extraction, editable by hand
- [ ] "View Source" opening the actual page image, not just the excerpt

Extraction must keep returning DRAFT concepts with populated `SourceRef`. The
gate does not move.

## Milestone 3 — Model-graded free recall

- [ ] `gradeFreeAnswer()` routed to a provider, server-side only
- [ ] Deterministic grading retained as fallback and regression oracle
- [ ] Partial-credit grading feeding a finer mastery signal
- [ ] Model-generated remediation grounded strictly in the source excerpt
- [ ] Disagreement logging between deterministic and model grading

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
