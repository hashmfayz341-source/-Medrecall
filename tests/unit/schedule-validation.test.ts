import { describe, expect, it } from "vitest";
import { S_MIN, State } from "ts-fsrs";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import { createProgress } from "@/lib/domain/mastery";
import type { CardProgress, ScheduleState } from "@/lib/domain/types";
import { newSchedule, scheduleAfterRating } from "@/lib/engine/scheduler";
import { buildStudyQueue, recordCardRating } from "@/lib/engine/study";
import { createLearnerState } from "@/lib/engine/tutor";
import {
  STUDY_CARDS_VERSION,
  sanitizeLearnerState,
  sanitizeStudyCards,
} from "@/lib/persistence/localStorage";
import { MAIN_PENDING_REMEDIATION, MAIN_REMEDIATED } from "../fixtures/main-learner-state";

/**
 * A stored schedule is usable only if the installed FSRS (ts-fsrs) accepts
 * it. `state` must be one of the library's own `State` values, and a card
 * with a memory state must satisfy the library's `next_state` precondition
 * (difficulty >= 1 and stability >= S_MIN); anything else throws inside FSRS
 * when the card is next rated, which took the whole Study session down.
 */

const T0 = new Date("2026-06-01T09:00:00.000Z");
const HYPOXIA = "c-hypoxia";

/** The FSRS states this repository's ts-fsrs actually defines. */
const SUPPORTED_STATES = Object.values(State).filter((v): v is State => typeof v === "number");

function reviewed(patch: Partial<ScheduleState>): ScheduleState {
  return {
    ...newSchedule(T0),
    state: State.Review,
    reps: 3,
    lapses: 0,
    stability: 4.2,
    difficulty: 5.1,
    last_review: T0.toISOString(),
    ...patch,
  };
}

function card(itemId: string, schedule: ScheduleState): CardProgress {
  return { itemId, conceptId: HYPOXIA, schedule, reviews: 1, lastRating: "GOOD", lastReviewedAt: T0.toISOString() };
}

const loadConcept = (schedule: unknown) =>
  sanitizeLearnerState({
    ...createLearnerState(),
    progress: { [HYPOXIA]: { ...createProgress(HYPOXIA, newSchedule(T0)), schedule } },
  })!;

const loadCard = (schedule: unknown) =>
  sanitizeStudyCards({
    version: STUDY_CARDS_VERSION,
    generation: "g",
    cards: { "c-hypoxia-1": card("c-hypoxia-1", schedule as ScheduleState) },
  })!;

describe("M2: only FSRS-supported schedule states are accepted", () => {
  it("the installed ts-fsrs defines exactly New, Learning, Review and Relearning", () => {
    expect(SUPPORTED_STATES).toEqual([State.New, State.Learning, State.Review, State.Relearning]);
  });

  it("reproduces the crash: a card whose stored state is 99 throws inside FSRS when rated", () => {
    const concept = C.concepts.find((c) => c.id === HYPOXIA)!;
    expect(() => scheduleAfterRating(concept, reviewed({ state: 99 }), "GOOD", T0)).toThrow();
  });

  for (const state of SUPPORTED_STATES) {
    it(`accepts a ${State[state]} schedule for concepts and cards`, () => {
      const schedule =
        state === State.New ? newSchedule(T0) : reviewed({ state, learning_steps: state === State.Review ? 0 : 1 });
      expect(loadConcept(schedule).dropped).toEqual([]);
      expect(loadCard(schedule).dropped).toEqual([]);
    });
  }

  for (const [label, state] of [
    ["99", 99],
    ["-1", -1],
    ["NaN", Number.NaN],
    ["a fraction", 1.5],
    ["a string", "2"],
    ["null", null],
    ["undefined", undefined],
  ] as const) {
    it(`rejects state ${label} for concepts and cards`, () => {
      const schedule = reviewed({ state: state as number });
      expect(loadConcept(schedule).dropped).toEqual([HYPOXIA]);
      expect(loadCard(schedule).dropped).toEqual(["card:c-hypoxia-1"]);
    });
  }

  it("mirrors FSRS's memory-state precondition: an empty memory state is fine, otherwise difficulty >= 1 and stability >= S_MIN", () => {
    expect(loadCard(newSchedule(T0)).dropped).toEqual([]); // New: difficulty 0, stability 0
    expect(loadCard(reviewed({ stability: S_MIN })).dropped).toEqual([]);
    expect(loadCard(reviewed({ stability: -5 })).dropped).toEqual(["card:c-hypoxia-1"]);
    expect(loadCard(reviewed({ stability: 0 })).dropped).toEqual(["card:c-hypoxia-1"]);
    expect(loadCard(reviewed({ difficulty: 0.5 })).dropped).toEqual(["card:c-hypoxia-1"]);
    expect(loadCard(reviewed({ difficulty: 99, stability: 0 })).dropped).toEqual(["card:c-hypoxia-1"]);
    expect(loadConcept(reviewed({ stability: -5 })).dropped).toEqual([HYPOXIA]);
  });

  it("isolates a malformed card: the valid card and the concept progress survive, and Study continues without crashing", () => {
    let learner = createLearnerState();
    learner = recordCardRating(C, learner, { conceptId: HYPOXIA, itemId: "c-hypoxia-1", rating: "GOOD", now: T0 }).learner;
    learner = recordCardRating(C, learner, { conceptId: HYPOXIA, itemId: "c-hypoxia-2", rating: "GOOD", now: T0 }).learner;
    const stored = JSON.parse(JSON.stringify(learner)) as { cards: Record<string, CardProgress> };
    stored.cards["c-hypoxia-2"]!.schedule.state = 99;

    const sidecar = sanitizeStudyCards({ version: STUDY_CARDS_VERSION, generation: "g", cards: stored.cards })!;
    expect(sidecar.dropped).toEqual(["card:c-hypoxia-2"]);
    expect(sidecar.cards["c-hypoxia-1"]).toEqual(learner.cards!["c-hypoxia-1"]);

    const envelope = sanitizeLearnerState({ ...stored, cards: undefined })!;
    expect(envelope.dropped).toEqual([]);
    const merged = { ...envelope.state, cards: sidecar.cards };
    expect(merged.progress[HYPOXIA]).toEqual(learner.progress[HYPOXIA]);

    const later = new Date(T0.getTime() + 60_000);
    const queue = buildStudyQueue(C, merged, "lecture-cell-injury", later);
    expect(queue.queue.find((c) => c.item.id === "c-hypoxia-2")?.queue).toBe("NEW"); // the dropped card starts over
    const rated = recordCardRating(C, merged, { conceptId: HYPOXIA, itemId: "c-hypoxia-1", rating: "GOOD", now: later }).learner;
    expect(rated.cards!["c-hypoxia-1"]!.reviews).toBe(2);
    const fresh = recordCardRating(C, rated, { conceptId: HYPOXIA, itemId: "c-hypoxia-2", rating: "GOOD", now: later }).learner;
    expect(fresh.cards!["c-hypoxia-2"]!.reviews).toBe(1);
  });

  it("real main@482824c states pass the stricter validation untouched", () => {
    for (const fixture of [MAIN_PENDING_REMEDIATION, MAIN_REMEDIATED]) {
      expect(sanitizeLearnerState(JSON.parse(JSON.stringify(fixture)))!.dropped).toEqual([]);
    }
  });
});
