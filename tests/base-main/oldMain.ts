import path from "node:path";
import { materializeBase } from "./materialize";

/**
 * A browser tab still running main@482824c, built from that commit's real
 * code (see materialize.ts): its LocalStorageLearnerRepository (the exact
 * load/sanitize/save it ships), its Tutor engine and its curriculum.
 *
 * Learner state is opaque here on purpose: it is whatever main produces.
 */

// Deliberately loose: this is main's shape, not this build's.
export type OldLearnerState = {
  progress: Record<string, Record<string, unknown> & { schedule: Record<string, unknown> }>;
  [key: string]: unknown;
};

interface OldRepo {
  load(): OldLearnerState | null;
  save(state: OldLearnerState): boolean;
  clear(): void;
}

export interface OldMainTab {
  /** main's `new LocalStorageLearnerRepository().load()` — reads window.localStorage. */
  load(): OldLearnerState | null;
  /** main's `save()` — writes `medrecall.learner.v1` exactly as main does. */
  save(state: OldLearnerState): boolean;
  /** main's Reset: removes `medrecall.learner.v1` (main knows no other key). */
  clear(): void;
  markChunkTaught(state: OldLearnerState, chunkId: string): OldLearnerState;
  /** main's deterministic `recordAttempt` (grade + fold into state). */
  answer(
    state: OldLearnerState,
    input: { conceptId: string; itemId: string; answer: string; context: string; chunkId?: string; now: Date },
  ): OldLearnerState;
  nextStepKind(state: OldLearnerState, lectureId: string, now: Date): { kind: string; conceptId?: string };
}

export async function openOldMainTab(): Promise<OldMainTab> {
  const dir = materializeBase();
  const load = (file: string) => import(/* @vite-ignore */ path.join(dir, file));
  const persistence = await load("src/lib/persistence/localStorage.ts");
  const tutor = await load("src/lib/engine/tutor.ts");
  const content = await load("src/lib/content/pathology.ts");
  const curriculum = content.pathologyCurriculum;
  const repo = (): OldRepo => new persistence.LocalStorageLearnerRepository();
  return {
    load: () => repo().load(),
    save: (state) => repo().save(state),
    clear: () => repo().clear(),
    markChunkTaught: (state, chunkId) => tutor.markChunkTaught(curriculum, state, chunkId),
    answer: (state, input) => tutor.recordAttempt(curriculum, state, input).learner,
    nextStepKind: (state, lectureId, now) => {
      const step = tutor.getNextStep(curriculum, state, lectureId, now);
      return { kind: step.kind, conceptId: step.concept?.id };
    },
  };
}
