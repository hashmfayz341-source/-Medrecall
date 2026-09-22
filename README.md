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

## Milestone 1 status

A complete deterministic tutor. **No AI key required.** The demo course is
Pathology, with two lectures: Cell Injury and Inflammation.

The full journey works end to end: learn in chunks → fail ATP depletion → it is
marked WEAK and re-taught → immediate remediation does *not* clear the weakness
→ finish Lecture 1 → Lecture 2 unlocks → ATP depletion is injected into Lecture
2 → answer it correctly → mastery improves → reload and everything persists.

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
```

Verification:

```bash
npm run lint
npm run typecheck
npm run test         # 87 unit tests
npm run build
npm run e2e          # 16 Playwright tests, iPad + desktop viewports
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
    grading/      Deterministic free-recall grading
    persistence/  Repository interfaces + browser-local implementations
    content/      The authored Pathology demo curriculum
    ai/           Provider-agnostic AI interface + deterministic implementation
tests/
  unit/           Vitest: gate, mastery, grading, unlock, interleaving, journey
  e2e/            Playwright: the full journey at iPad and desktop viewports
```

The learning engine is deliberately **not** inside React components. Everything
in `lib/domain` is pure and framework-free; you can run the whole tutor in a
test without rendering anything.

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — decisions, with reasons and tradeoffs
- [ROADMAP.md](./ROADMAP.md) — what is built and what comes next
- [AI_HANDOFF.md](./AI_HANDOFF.md) — briefing for the next contributor
