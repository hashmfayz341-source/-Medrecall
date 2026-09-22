import type { LearnerState } from "@/lib/domain/types";

/**
 * Learner-state persistence.
 *
 * Deliberately narrow: load, save, clear. Milestone 1 stores per-learner state
 * in the browser, but nothing above this interface knows that. Moving learner
 * state to a server later means adding one implementation, not touching the
 * engine.
 *
 * Shared curriculum state (course, lectures, concepts) is NOT stored here — it
 * is separate by design, so a future release can host curriculum centrally
 * while learner records stay per-user.
 */
export interface LearnerStateRepository {
  load(): LearnerState | null;
  save(state: LearnerState): boolean;
  clear(): void;
}
