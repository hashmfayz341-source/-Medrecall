import { describe, expect, it } from "vitest";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { applyOverrides, createOverrides, setConceptStatus } from "@/lib/domain/curriculum";
import { createProgress } from "@/lib/domain/mastery";
import type {
  ConceptProgress,
  Curriculum,
  LearnerState,
  RetrievalContext,
  SelfRating,
} from "@/lib/domain/types";
import { recordCardRating } from "@/lib/engine/study";
import {
  createLearnerState,
  getConcept,
  getNextStep,
  isLectureUnlocked,
  markChunkTaught,
  pendingRemediation,
  recordAttempt,
  type SessionStep,
} from "@/lib/engine/tutor";
import {
  STUDY_CARDS_STORAGE_KEY,
  LocalStorageLearnerRepository,
  STORAGE_KEY,
  sanitizeLearnerState,
} from "@/lib/persistence/localStorage";
import { MAIN_PENDING_REMEDIATION, MAIN_REMEDIATED } from "../fixtures/main-learner-state";
import { driveLecture } from "./driver";
import { ANSWERS, WRONG } from "./helpers";

/**
 * Pending immediate TUTOR remediation is its own state, not a reading of WEAK.
 *
 * Mastery is shared by the Tutor and Card Study, so a concept can be WEAK
 * because of a Study AGAIN that happened before the Tutor ever asked about it.
 * That weakness must not be reinterpreted, after the Tutor's first retrieval,
 * as a Tutor failure awaiting remediation. The Tutor remediates only what it
 * failed itself, or what Study failed after the Tutor had covered it.
 */

const C = pathologyCurriculum;
const L1 = "lecture-cell-injury";
const L2 = "lecture-inflammation";
const CHUNK1 = "chunk-ci-1";
const HYPOXIA = "c-hypoxia";
const REV = "c-reversible-irreversible";
const T0 = new Date("2026-06-01T09:00:00.000Z");
const at = (m: number) => new Date(T0.getTime() + m * 60_000);
const DAY = 60 * 24;

type Question = Extract<SessionStep, { item: unknown }>;

function study(
  learner: LearnerState,
  conceptId: string,
  rating: SelfRating,
  now: Date,
  itemIndex = 0,
  curriculum: Curriculum = C,
): LearnerState {
  const concept = getConcept(curriculum, conceptId);
  return recordCardRating(curriculum, learner, {
    conceptId,
    itemId: concept.retrievalItems[itemIndex]!.id,
    rating,
    now,
  }).learner;
}

function asQuestion(step: SessionStep): Question {
  if (!("item" in step)) throw new Error(`expected a question step, got ${step.kind}`);
  return step;
}

function answer(
  learner: LearnerState,
  step: SessionStep,
  correct: boolean,
  now: Date,
  curriculum: Curriculum = C,
) {
  const q = asQuestion(step);
  const result = recordAttempt(curriculum, learner, {
    conceptId: q.concept.id,
    itemId: q.item.id,
    answer: correct ? ANSWERS[q.concept.id]! : WRONG,
    context: q.context,
    chunkId: q.chunk.id,
    now,
  });
  expect(result.grade.correct, `${q.kind} ${q.concept.id}`).toBe(correct);
  return result.learner;
}

const flag = (learner: LearnerState, id: string) => learner.progress[id]?.pendingTutorRemediation;
const pending = (learner: LearnerState, id: string) => pendingRemediation(learner.progress[id]);
const shape = (s: SessionStep) => [s.kind, "concept" in s ? s.concept.id : null, "item" in s ? s.item.id : null];

/** Tutor-only learner: chunk 1 taught, c-hypoxia answered correctly. */
function tutorOnlyAfterHypoxia(): LearnerState {
  const learner = markChunkTaught(C, createLearnerState(), CHUNK1);
  return answer(learner, getNextStep(C, learner, L1, at(2)), true, at(2));
}

describe("Astra repro: a Study failure before the Tutor is not a Tutor remediation", () => {
  it("fresh → Study c-hypoxia AGAIN → chunk taught → Tutor INITIAL c-hypoxia CORRECT → normal next step, not REMEDIATE", () => {
    let learner = study(createLearnerState(), HYPOXIA, "AGAIN", T0);
    expect(learner.progress[HYPOXIA]!.mastery).toBe("WEAK");
    expect(learner.progress[HYPOXIA]!.schedule.reps).toBe(0);

    const teach = getNextStep(C, learner, L1, at(1));
    expect(teach.kind).toBe("TEACH");
    if (teach.kind === "TEACH") expect(teach.chunk.id).toBe(CHUNK1);
    learner = markChunkTaught(C, learner, CHUNK1);

    const retrieve = getNextStep(C, learner, L1, at(2));
    expect(retrieve.kind).toBe("RETRIEVE");
    expect(asQuestion(retrieve).concept.id).toBe(HYPOXIA);
    expect(asQuestion(retrieve).context).toBe("INITIAL");
    learner = answer(learner, retrieve, true, at(2));

    // The normal next Tutor step: exactly what a Tutor-only learner gets.
    const next = getNextStep(C, learner, L1, at(3));
    expect(next.kind).not.toBe("REMEDIATE");
    expect(shape(next)).toEqual(["RETRIEVE", REV, "c-rev-1"]);
    expect(shape(next)).toEqual(shape(getNextStep(C, tutorOnlyAfterHypoxia(), L1, at(3))));

    const p = learner.progress[HYPOXIA]!;
    // Shared mastery: an INITIAL success does not clear WEAK. That is fine.
    expect(p.mastery).toBe("WEAK");
    expect(p.schedule.reps).toBe(1);
    expect(pendingRemediation(p)).toBe(false);
    expect(p.pendingTutorRemediation).toBe(false);

    // Completion: the chunk completes once its other concept is retrieved,
    // although c-hypoxia is still WEAK (weakness does not block completion).
    learner = answer(learner, next, true, at(3));
    expect(learner.completedChunkIds).toContain(CHUNK1);
    expect(learner.progress[HYPOXIA]!.mastery).toBe("WEAK");
  });

  it("the no-REMEDIATE outcome survives save and reload (an explicit false is never re-inferred)", () => {
    let learner = study(createLearnerState(), HYPOXIA, "AGAIN", T0);
    learner = markChunkTaught(C, learner, CHUNK1);
    learner = answer(learner, getNextStep(C, learner, L1, at(2)), true, at(2));
    const reloaded = sanitizeLearnerState(JSON.parse(JSON.stringify(learner)))!;
    expect(reloaded.dropped).toEqual([]);
    expect(flag(reloaded.state, HYPOXIA)).toBe(false);
    expect(shape(getNextStep(C, reloaded.state, L1, at(3)))).toEqual(["RETRIEVE", REV, "c-rev-1"]);
  });
});

describe("state machine", () => {
  describe("A: Study AGAIN before any Tutor retrieval, then Tutor INITIAL correct → no remediation", () => {
    const histories: [string, (l: LearnerState) => LearnerState][] = [
      ["AGAIN on card 1", (l) => study(l, HYPOXIA, "AGAIN", T0)],
      ["AGAIN on card 2", (l) => study(l, HYPOXIA, "AGAIN", T0, 1)],
      ["AGAIN, AGAIN", (l) => study(study(l, HYPOXIA, "AGAIN", T0), HYPOXIA, "AGAIN", at(0.5))],
      ["AGAIN, GOOD", (l) => study(study(l, HYPOXIA, "AGAIN", T0), HYPOXIA, "GOOD", at(0.5))],
      ["AGAIN, HARD", (l) => study(study(l, HYPOXIA, "AGAIN", T0), HYPOXIA, "HARD", at(0.5))],
      ["AGAIN on both cards", (l) => study(study(l, HYPOXIA, "AGAIN", T0), HYPOXIA, "AGAIN", at(0.5), 1)],
    ];
    for (const [name, history] of histories) {
      it(`${name}: the whole lecture runs exactly like a Tutor-only learner's`, () => {
        const studied = history(createLearnerState());
        expect(studied.progress[HYPOXIA]!.mastery).toBe("WEAK");

        const withStudy = driveLecture(studied, L1, at(5));
        const tutorOnly = driveLecture(createLearnerState(), L1, at(5));
        expect(withStudy.log.filter((l) => l.kind === "REMEDIATE")).toEqual([]);
        expect(withStudy.log.map((l) => [l.kind, l.conceptId, l.itemId])).toEqual(
          tutorOnly.log.map((l) => [l.kind, l.conceptId, l.itemId]),
        );
        expect(flag(studied, HYPOXIA)).toBe(false);
        expect(withStudy.learner.completedLectureIds).toContain(L1);
        expect(isLectureUnlocked(C, withStudy.learner, L2)).toBe(true);
        expect(withStudy.learner.progress[HYPOXIA]!.schedule.reps).toBe(1);
        expect(flag(withStudy.learner, HYPOXIA)).toBe(false);
        // Still WEAK, so the NEXT lecture brings it back by interleaving —
        // spaced retrieval, not immediate remediation.
        const l2 = getNextStep(C, withStudy.learner, L2, at(6));
        expect(l2.kind).toBe("INTERLEAVE");
        expect(asQuestion(l2).concept.id).toBe(HYPOXIA);
      });
    }
  });

  it("B: Study AGAIN before any Tutor retrieval, then Tutor INITIAL incorrect → REMEDIATE", () => {
    let learner = markChunkTaught(C, study(createLearnerState(), HYPOXIA, "AGAIN", T0), CHUNK1);
    learner = answer(learner, getNextStep(C, learner, L1, at(2)), false, at(2));
    expect(flag(learner, HYPOXIA)).toBe(true);
    expect(pending(learner, HYPOXIA)).toBe(true);
    const next = getNextStep(C, learner, L1, at(3));
    expect(shape(next)).toEqual(["REMEDIATE", HYPOXIA, "c-hypoxia-2"]);
  });

  it("C: Tutor INITIAL incorrect → REMEDIATE", () => {
    let learner = markChunkTaught(C, createLearnerState(), CHUNK1);
    learner = answer(learner, getNextStep(C, learner, L1, T0), false, T0);
    expect(flag(learner, HYPOXIA)).toBe(true);
    expect(learner.completedChunkIds).not.toContain(CHUNK1);
    expect(shape(getNextStep(C, learner, L1, at(1)))).toEqual(["REMEDIATE", HYPOXIA, "c-hypoxia-2"]);
  });

  it("C': Tutor SPACED incorrect → pending", () => {
    let learner = tutorOnlyAfterHypoxia();
    expect(flag(learner, HYPOXIA)).toBe(false);
    learner = recordAttempt(C, learner, {
      conceptId: HYPOXIA, itemId: "c-hypoxia-2", answer: WRONG, context: "SPACED", now: at(DAY),
    }).learner;
    expect(flag(learner, HYPOXIA)).toBe(true);
    expect(shape(getNextStep(C, learner, L1, at(DAY + 1)))).toEqual(["REMEDIATE", HYPOXIA, "c-hypoxia-2"]);
  });

  it("D: Tutor INTERLEAVED incorrect → REMEDIATE (earlier-lecture concept, current-lecture visit)", () => {
    let learner = driveLecture(createLearnerState(), L1, T0).learner;
    const later = at(2 * DAY);
    const step = getNextStep(C, learner, L2, later);
    expect(step.kind).toBe("INTERLEAVE");
    const q = asQuestion(step);
    expect(flag(learner, q.concept.id)).toBe(false);
    learner = answer(learner, step, false, later);
    expect(flag(learner, q.concept.id)).toBe(true);
    const next = getNextStep(C, learner, L2, later);
    expect(next.kind).toBe("REMEDIATE");
    expect(asQuestion(next).concept.id).toBe(q.concept.id);
  });

  describe("E: the Tutor's own remediation", () => {
    function failed(): LearnerState {
      const learner = markChunkTaught(C, createLearnerState(), CHUNK1);
      return answer(learner, getNextStep(C, learner, L1, T0), false, T0);
    }

    it("answered correctly clears pending; mastery semantics are unchanged (still WEAK)", () => {
      let learner = failed();
      learner = answer(learner, getNextStep(C, learner, L1, at(1)), true, at(1));
      const p = learner.progress[HYPOXIA]!;
      expect(p.pendingTutorRemediation).toBe(false);
      expect(p.mastery).toBe("WEAK");
      expect(p.immediateRemediationPassed).toBe(true);
      expect(p.schedule.reps).toBe(2);
      expect(shape(getNextStep(C, learner, L1, at(2)))).toEqual(["RETRIEVE", REV, "c-rev-1"]);
      learner = answer(learner, getNextStep(C, learner, L1, at(2)), true, at(2));
      expect(learner.completedChunkIds).toContain(CHUNK1);
    });

    it("answered incorrectly stays pending → REMEDIATE again", () => {
      let learner = failed();
      learner = answer(learner, getNextStep(C, learner, L1, at(1)), false, at(1));
      expect(flag(learner, HYPOXIA)).toBe(true);
      expect(learner.completedChunkIds).not.toContain(CHUNK1);
      expect(getNextStep(C, learner, L1, at(2)).kind).toBe("REMEDIATE");
    });
  });

  it("pure Tutor: the flag equals main's rule after every context × outcome, from every starting state", () => {
    // main@482824c: pending ⇔ totalAttempts > 0 && WEAK && !immediateRemediationPassed.
    const mainRule = (p: ConceptProgress) =>
      p.totalAttempts > 0 && p.mastery === "WEAK" && !p.immediateRemediationPassed;
    const taught = markChunkTaught(C, createLearnerState(), CHUNK1);
    const tutor = (l: LearnerState, context: RetrievalContext, correct: boolean, itemId: string, now: Date) =>
      recordAttempt(C, l, { conceptId: HYPOXIA, itemId, answer: correct ? ANSWERS[HYPOXIA]! : WRONG, context, now }).learner;
    const failed = tutor(taught, "INITIAL", false, "c-hypoxia-1", T0);
    const starts: Record<string, LearnerState> = {
      "never attempted": taught,
      "Tutor success": tutor(taught, "INITIAL", true, "c-hypoxia-1", T0),
      "Tutor failure (pending)": failed,
      "remediated (WEAK, passed)": tutor(failed, "IMMEDIATE_REMEDIATION", true, "c-hypoxia-2", at(1)),
      "remediation failed": tutor(failed, "IMMEDIATE_REMEDIATION", false, "c-hypoxia-2", at(1)),
    };
    let checked = 0;
    for (const [name, start] of Object.entries(starts)) {
      const before = start.progress[HYPOXIA];
      if (before) expect(before.pendingTutorRemediation, name).toBe(mainRule(before));
      for (const context of ["INITIAL", "IMMEDIATE_REMEDIATION", "SPACED", "INTERLEAVED"] as const) {
        for (const correct of [true, false]) {
          for (const itemId of ["c-hypoxia-1", "c-hypoxia-2"]) {
            const after = tutor(start, context, correct, itemId, at(DAY)).progress[HYPOXIA]!;
            expect(after.pendingTutorRemediation, `${name} → ${context} ${correct} ${itemId}`).toBe(mainRule(after));
            expect(pendingRemediation(after)).toBe(mainRule(after));
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(80);
  });

  describe("F: Study AGAIN after a legitimate Tutor retrieval → pending", () => {
    it("same lecture: the next Tutor step is REMEDIATE, and the Tutor's remediation clears it", () => {
      let learner = tutorOnlyAfterHypoxia();
      learner = study(learner, HYPOXIA, "AGAIN", at(3));
      expect(learner.progress[HYPOXIA]!.mastery).toBe("WEAK");
      expect(flag(learner, HYPOXIA)).toBe(true);
      const step = getNextStep(C, learner, L1, at(4));
      expect(shape(step)).toEqual(["REMEDIATE", HYPOXIA, "c-hypoxia-2"]);
      learner = answer(learner, step, true, at(4));
      expect(flag(learner, HYPOXIA)).toBe(false);
      expect(shape(getNextStep(C, learner, L1, at(5)))).toEqual(["RETRIEVE", REV, "c-rev-1"]);
    });

    it("next lecture: the next valid Tutor visit remediates it", () => {
      let learner = driveLecture(createLearnerState(), L1, T0).learner;
      learner = study(learner, "c-atp-depletion", "AGAIN", at(DAY));
      expect(flag(learner, "c-atp-depletion")).toBe(true);
      expect(learner.completedLectureIds).toContain(L1);
      const step = getNextStep(C, learner, L2, at(DAY + 1));
      expect(step.kind).toBe("REMEDIATE");
      expect(asQuestion(step).concept.id).toBe("c-atp-depletion");
    });

    it("Study re-study success (card in Learning) does not satisfy a pending Tutor remediation", () => {
      let learner = markChunkTaught(C, createLearnerState(), CHUNK1);
      learner = answer(learner, getNextStep(C, learner, L1, T0), false, T0);
      learner = study(learner, HYPOXIA, "AGAIN", at(1));
      for (const rating of ["HARD", "GOOD", "EASY"] as const) {
        const after = study(learner, HYPOXIA, rating, at(2));
        expect(after.progress[HYPOXIA]!.mastery, rating).toBe("WEAK");
        expect(flag(after, HYPOXIA), rating).toBe(true);
        expect(getNextStep(C, after, L1, at(3)).kind, rating).toBe("REMEDIATE");
      }
    });

    it("a Study rating on a Review-state card that leaves the concept WEAK (HARD) keeps the Tutor remediation pending", () => {
      let learner = study(createLearnerState(), HYPOXIA, "EASY", T0); // card → Review
      learner = markChunkTaught(C, learner, CHUNK1);
      learner = answer(learner, getNextStep(C, learner, L1, at(1)), false, at(1));
      const later = at(30 * DAY);
      learner = study(learner, HYPOXIA, "HARD", later);
      expect(learner.progress[HYPOXIA]!.mastery).toBe("WEAK");
      expect(flag(learner, HYPOXIA)).toBe(true);
      expect(getNextStep(C, learner, L1, later).kind).toBe("REMEDIATE");
    });

    it("a Study spaced success that lifts WEAK leaves nothing to remediate (shared mastery)", () => {
      // Card studied Easy long ago → Review state; the Tutor then fails the concept.
      let learner = study(createLearnerState(), HYPOXIA, "EASY", T0);
      learner = markChunkTaught(C, learner, CHUNK1);
      learner = answer(learner, getNextStep(C, learner, L1, at(1)), false, at(1));
      expect(flag(learner, HYPOXIA)).toBe(true);
      const later = at(30 * DAY);
      learner = study(learner, HYPOXIA, "GOOD", later);
      expect(learner.progress[HYPOXIA]!.mastery).toBe("LEARNING");
      expect(flag(learner, HYPOXIA)).toBe(false);
      expect(getNextStep(C, learner, L1, later).kind).not.toBe("REMEDIATE");
    });
  });

  describe("G: a Study failure in a future/locked lecture never interrupts an earlier Tutor lecture", () => {
    it("no Tutor exposure: WEAK, not pending, no interruption", () => {
      const learner = study(createLearnerState(), "c-cardinal-signs", "AGAIN", T0);
      expect(flag(learner, "c-cardinal-signs")).toBe(false);
      expect(isLectureUnlocked(C, learner, L2)).toBe(false);
      expect(getNextStep(C, learner, L1, at(1)).kind).toBe("TEACH");
    });

    it("with Tutor exposure: pending, but only a Lecture 2 visit remediates it — never reopened Lecture 1", () => {
      let learner = driveLecture(createLearnerState(), L1, T0).learner;
      learner = markChunkTaught(C, learner, "chunk-inf-1");
      const retrieve = getNextStep(C, learner, L2, at(10));
      expect(shape(retrieve)).toEqual(["RETRIEVE", "c-cardinal-signs", "c-signs-1"]);
      learner = answer(learner, retrieve, true, at(10));

      // Newly approved Lecture 1 material reopens Lecture 1 (and locks Lecture 2).
      const reopened = applyOverrides(C, setConceptStatus(createOverrides(), "c-draft-lysosomal", "ACTIVE"));
      learner = study(learner, "c-cardinal-signs", "AGAIN", at(11), 0, reopened);
      expect(flag(learner, "c-cardinal-signs")).toBe(true);
      expect(isLectureUnlocked(reopened, learner, L2)).toBe(false);

      const answers: Record<string, string> = { ...ANSWERS, "c-draft-lysosomal": "hydrolases" };
      const kinds: string[] = [];
      for (let i = 0; i < 20; i++) {
        const step = getNextStep(reopened, learner, L1, at(12 + i));
        kinds.push(step.kind);
        expect(step.kind).not.toBe("REMEDIATE");
        if (step.kind === "LECTURE_COMPLETE") break;
        if (step.kind === "TEACH") {
          learner = markChunkTaught(reopened, learner, step.chunk.id);
          continue;
        }
        const q = asQuestion(step);
        learner = recordAttempt(reopened, learner, {
          conceptId: q.concept.id, itemId: q.item.id, answer: answers[q.concept.id]!,
          context: q.context, chunkId: q.chunk.id, now: at(12 + i),
        }).learner;
      }
      expect(kinds.at(-1)).toBe("LECTURE_COMPLETE");

      // Back in Lecture 2, the pending remediation is served.
      const l2 = getNextStep(reopened, learner, L2, at(40));
      expect(l2.kind).toBe("REMEDIATE");
      expect(asQuestion(l2).concept.id).toBe("c-cardinal-signs");
    });
  });

  describe("H: Study HARD / GOOD / EASY never create pending remediation", () => {
    const starts: [string, () => LearnerState][] = [
      ["no Tutor history", () => createLearnerState()],
      ["after a Tutor success", () => tutorOnlyAfterHypoxia()],
      ["WEAK from a pre-Tutor Study failure, then a Tutor success", () => {
        const l = markChunkTaught(C, study(createLearnerState(), HYPOXIA, "AGAIN", T0), CHUNK1);
        return answer(l, getNextStep(C, l, L1, at(2)), true, at(2));
      }],
    ];
    for (const [name, start] of starts) {
      for (const rating of ["HARD", "GOOD", "EASY"] as const) {
        it(`${rating}, ${name}: New → Learning/Review → Review, never pending`, () => {
          let learner = start();
          // Minutes apart, then weeks apart: covers every card state.
          for (const [i, when] of [at(4), at(5), at(60 * DAY), at(200 * DAY)].entries()) {
            for (const index of [0, 1]) {
              learner = study(learner, HYPOXIA, rating, new Date(when.getTime() + index * 1000));
              expect(flag(learner, HYPOXIA), `step ${i} card ${index}`).toBe(false);
              expect(pending(learner, HYPOXIA)).toBe(false);
            }
            expect(getNextStep(C, learner, L1, when).kind).not.toBe("REMEDIATE");
          }
        });
      }
    }
  });

  describe("I: WEAK alone is not pending remediation", () => {
    const tutorReviewed = {
      ...createProgress(HYPOXIA, {
        due: "2026-06-01T09:10:00.000Z", stability: 1, difficulty: 5, elapsed_days: 0,
        scheduled_days: 0, learning_steps: 0, reps: 1, lapses: 0, state: 1,
        last_review: "2026-06-01T09:00:00.000Z",
      }),
      mastery: "WEAK",
      totalAttempts: 2,
      everWrong: true,
      immediateRemediationPassed: false,
    } satisfies ConceptProgress;

    it("WEAK + Tutor-attempted + remediation not passed, but not flagged → not pending", () => {
      expect(pendingRemediation({ ...tutorReviewed, pendingTutorRemediation: false })).toBe(false);
      const learner: LearnerState = {
        ...createLearnerState(),
        taughtChunkIds: [CHUNK1],
        progress: { [HYPOXIA]: { ...tutorReviewed, pendingTutorRemediation: false } },
      };
      expect(shape(getNextStep(C, learner, L1, at(1)))).toEqual(["RETRIEVE", REV, "c-rev-1"]);
    });

    it("flagged → pending; flagged without Tutor evidence or without WEAK → not pending", () => {
      expect(pendingRemediation({ ...tutorReviewed, pendingTutorRemediation: true })).toBe(true);
      expect(pendingRemediation({
        ...tutorReviewed, pendingTutorRemediation: true, schedule: { ...tutorReviewed.schedule, reps: 0 },
      })).toBe(false);
      expect(pendingRemediation({ ...tutorReviewed, pendingTutorRemediation: true, mastery: "LEARNING" })).toBe(false);
      expect(pendingRemediation(undefined)).toBe(false);
    });

    it("a new concept starts not pending", () => {
      expect(createProgress(HYPOXIA, tutorReviewed.schedule).pendingTutorRemediation).toBe(false);
    });
  });
});

describe("legacy learner state (main@482824c, no pendingTutorRemediation field)", () => {
  const load = (value: unknown) => sanitizeLearnerState(JSON.parse(JSON.stringify(value)));

  it("a pending Tutor failure saved by main is still remediated after load", () => {
    expect("pendingTutorRemediation" in MAIN_PENDING_REMEDIATION.progress[HYPOXIA]).toBe(false);
    const loaded = load(MAIN_PENDING_REMEDIATION)!;
    expect(loaded.dropped).toEqual([]);
    expect(flag(loaded.state, HYPOXIA)).toBe(true);
    const step = getNextStep(C, loaded.state, L1, at(1));
    expect(shape(step)).toEqual(["REMEDIATE", HYPOXIA, "c-hypoxia-2"]);
    const after = answer(loaded.state, step, true, at(1));
    expect(flag(after, HYPOXIA)).toBe(false);
    expect(shape(getNextStep(C, after, L1, at(2)))).toEqual(["RETRIEVE", REV, "c-rev-1"]);
  });

  it("a remediation main already passed is not re-opened", () => {
    const loaded = load(MAIN_REMEDIATED)!;
    expect(loaded.dropped).toEqual([]);
    expect(flag(loaded.state, HYPOXIA)).toBe(false);
    expect(shape(getNextStep(C, loaded.state, L1, at(2)))).toEqual(["RETRIEVE", REV, "c-rev-1"]);
  });

  it("non-WEAK and never-attempted legacy records infer false; everything else is preserved", () => {
    const legacy = JSON.parse(JSON.stringify(MAIN_PENDING_REMEDIATION));
    legacy.progress[HYPOXIA].mastery = "LEARNING";
    legacy.progress[REV] = { ...legacy.progress[HYPOXIA], conceptId: REV, mastery: "WEAK" };
    legacy.progress[REV].schedule = { ...legacy.progress[HYPOXIA].schedule, reps: 0 };
    const loaded = load(legacy)!;
    expect(flag(loaded.state, HYPOXIA)).toBe(false);
    expect(flag(loaded.state, REV)).toBe(false);
    expect(loaded.state.progress[HYPOXIA]).toEqual({
      ...legacy.progress[HYPOXIA],
      pendingTutorRemediation: false,
      pendingTutorRemediationRevision: "1|2026-06-01T09:00:00.000Z",
    });
    expect(loaded.state.taughtChunkIds).toEqual(legacy.taughtChunkIds);
  });

  it("migration does not mutate the input", () => {
    const raw = JSON.parse(JSON.stringify(MAIN_PENDING_REMEDIATION));
    sanitizeLearnerState(raw);
    expect("pendingTutorRemediation" in raw.progress[HYPOXIA]).toBe(false);
  });

  const FAILURE_REVISION = "1|2026-06-01T09:00:00.000Z"; // MAIN_PENDING_REMEDIATION's schedule
  const REMEDIATED_REVISION = "2|2026-06-01T09:01:00.000Z"; // MAIN_REMEDIATED's schedule

  it("a stored flag decided at the record's current Tutor revision is authoritative, never re-inferred", () => {
    const stored = JSON.parse(JSON.stringify(MAIN_PENDING_REMEDIATION));
    stored.progress[HYPOXIA].pendingTutorRemediationRevision = FAILURE_REVISION;
    stored.progress[HYPOXIA].pendingTutorRemediation = false;
    expect(flag(load(stored)!.state, HYPOXIA)).toBe(false);
    stored.progress[HYPOXIA].pendingTutorRemediation = true;
    expect(flag(load(stored)!.state, HYPOXIA)).toBe(true);
  });

  describe("a stored flag decided at a DIFFERENT Tutor revision → main's rule", () => {
    // main keeps both fields exactly as stored, so a Tutor attempt made by a
    // tab still running main leaves them describing an older schedule.
    it("a Tutor failure main recorded over a stale `false` is still remediated", () => {
      const written = JSON.parse(JSON.stringify(MAIN_PENDING_REMEDIATION));
      written.progress[HYPOXIA].pendingTutorRemediation = false; // decided before main's attempt
      written.progress[HYPOXIA].pendingTutorRemediationRevision = "0|";
      const loaded = load(written)!;
      expect(flag(loaded.state, HYPOXIA)).toBe(true);
      expect(loaded.state.progress[HYPOXIA]!.pendingTutorRemediationRevision).toBe(FAILURE_REVISION);
      expect(getNextStep(C, loaded.state, L1, at(1)).kind).toBe("REMEDIATE");
    });

    it("a remediation main recorded as passed over a stale `true` is not re-opened", () => {
      const written = JSON.parse(JSON.stringify(MAIN_REMEDIATED));
      written.progress[HYPOXIA].pendingTutorRemediation = true; // decided at the failure
      written.progress[HYPOXIA].pendingTutorRemediationRevision = FAILURE_REVISION;
      const loaded = load(written)!;
      expect(flag(loaded.state, HYPOXIA)).toBe(false);
      expect(loaded.state.progress[HYPOXIA]!.pendingTutorRemediationRevision).toBe(REMEDIATED_REVISION);
      expect(shape(getNextStep(C, loaded.state, L1, at(2)))).toEqual(["RETRIEVE", REV, "c-rev-1"]);
    });

    it("a flag with no revision (earlier builds of this PR) gets main's rule", () => {
      const written = JSON.parse(JSON.stringify(MAIN_PENDING_REMEDIATION));
      written.progress[HYPOXIA].pendingTutorRemediation = false;
      expect(flag(load(written)!.state, HYPOXIA)).toBe(true);
    });
  });

  it("a malformed flag or revision drops that record like any other malformed field", () => {
    for (const [field, bad] of [
      ["pendingTutorRemediation", "yes"], ["pendingTutorRemediation", 1], ["pendingTutorRemediation", null], ["pendingTutorRemediation", {}],
      ["pendingTutorRemediationRevision", 1], ["pendingTutorRemediationRevision", null], ["pendingTutorRemediationRevision", {}],
    ] as const) {
      const stored = JSON.parse(JSON.stringify(MAIN_PENDING_REMEDIATION));
      stored.progress[HYPOXIA][field] = bad;
      const loaded = load(stored)!;
      expect(loaded.dropped, `${field} ${String(bad)}`).toEqual([HYPOXIA]);
      expect(loaded.state.progress[HYPOXIA]).toBeUndefined();
    }
  });

  it("the repository round-trips this build's state exactly (flags, revisions, cards in the sidecar)", () => {
    const store = new Map<string, string>();
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    };
    try {
      // c-hypoxia: WEAK from Study, not pending. c-atp-depletion: pending.
      let learner = markChunkTaught(C, study(createLearnerState(), HYPOXIA, "AGAIN", T0), CHUNK1);
      learner = answer(learner, getNextStep(C, learner, L1, at(2)), true, at(2));
      learner = recordAttempt(C, learner, {
        conceptId: "c-atp-depletion", itemId: "c-atp-1", answer: WRONG, context: "SPACED", now: at(3),
      }).learner;
      expect(flag(learner, HYPOXIA)).toBe(false);
      expect(flag(learner, "c-atp-depletion")).toBe(true);
      expect(learner.cards).toBeDefined();

      const repo = new LocalStorageLearnerRepository();
      expect(repo.save(learner)).toBe(true);
      expect(JSON.parse(store.get(STORAGE_KEY)!).cards).toBeUndefined();
      expect(JSON.parse(store.get(STUDY_CARDS_STORAGE_KEY)!).cards).toEqual(learner.cards);
      const reloaded = new LocalStorageLearnerRepository().load();
      expect(reloaded).toEqual(learner);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
