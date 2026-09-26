import {
  LEARNER_STATE_VERSION,
  createLearnerState,
  inferLegacyPendingTutorRemediation,
} from "@/lib/engine/tutor";
import type { ConceptProgress, LearnerState } from "@/lib/domain/types";
import type { LearnerStateRepository } from "./repository";

export const STORAGE_KEY = "medrecall.learner.v1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

const MASTERY_STATES = ["NEW", "LEARNING", "WEAK", "STABLE", "STRONG"];

/**
 * A schedule is only usable if every field the FSRS engine reads is present
 * and well formed. A record with `due` missing would reach `new Date(undefined)`
 * and put NaN through the Today queue and the scheduler.
 */
function isScheduleState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.due !== "string") return false;
  if (Number.isNaN(new Date(value.due).getTime())) return false;
  if (value.last_review !== undefined) {
    if (typeof value.last_review !== "string") return false;
    if (Number.isNaN(new Date(value.last_review).getTime())) return false;
  }
  return [
    "stability",
    "difficulty",
    "elapsed_days",
    "scheduled_days",
    "learning_steps",
    "reps",
    "lapses",
    "state",
  ].every((key) => Number.isFinite(value[key]));
}

function isConceptProgress(value: unknown, conceptId: string): boolean {
  if (!isRecord(value)) return false;
  if (value.conceptId !== conceptId) return false;
  if (!MASTERY_STATES.includes(String(value.mastery))) return false;
  if (
    !["consecutiveSpacedSuccesses", "totalAttempts", "totalCorrect"].every((key) =>
      Number.isInteger(value[key]),
    )
  ) {
    return false;
  }
  if (typeof value.everWrong !== "boolean") return false;
  if (typeof value.immediateRemediationPassed !== "boolean") return false;
  // Absent in state saved before it existed (derived on load, below);
  // present, it must be a boolean like every other flag.
  if (
    value.pendingTutorRemediation !== undefined &&
    typeof value.pendingTutorRemediation !== "boolean"
  ) {
    return false;
  }
  if (value.lastAttemptAt !== null && typeof value.lastAttemptAt !== "string") {
    return false;
  }
  return isScheduleState(value.schedule);
}

const SELF_RATINGS = ["AGAIN", "HARD", "GOOD", "EASY"];

function isCardProgress(value: unknown, itemId: string): boolean {
  if (!isRecord(value)) return false;
  if (value.itemId !== itemId) return false;
  if (typeof value.conceptId !== "string" || value.conceptId.length === 0) return false;
  if (!Number.isInteger(value.reviews) || (value.reviews as number) < 0) return false;
  if (value.lastRating !== null && !SELF_RATINGS.includes(String(value.lastRating))) return false;
  if (value.lastReviewedAt !== null && typeof value.lastReviewedAt !== "string") return false;
  return isScheduleState(value.schedule);
}

/**
 * Envelope key marking learner state written by a build that maintains
 * `ConceptProgress.pendingTutorRemediation`.
 *
 * main before card study keeps every progress record exactly as stored but
 * rebuilds the envelope, dropping keys it does not know. A tab still running
 * that build after an update would therefore save records whose flag it never
 * updated — a Tutor failure over a stale `false`, or a passed remediation over
 * a stale `true` — and it always drops this mark. So the mark's absence means
 * "flags not maintained by the last writer", and every record's flag is
 * re-derived with main's rule. Not a timestamp or content heuristic: only
 * `serializeLearnerState` writes it.
 */
export const EXPLICIT_REMEDIATION_MARK = "tutorRemediationExplicit";

/** The exact string this build stores for a learner state. */
export function serializeLearnerState(state: LearnerState): string {
  return JSON.stringify({ ...state, [EXPLICIT_REMEDIATION_MARK]: true });
}

/**
 * Validate stored learner state, dropping individual progress records that are
 * malformed rather than discarding a learner's entire history.
 *
 * Returns null only when the envelope itself cannot be trusted.
 */
export function sanitizeLearnerState(
  value: unknown,
): { state: LearnerState; dropped: string[] } | null {
  if (!isRecord(value)) return null;
  if (typeof value.version !== "number") return null;
  if (!isRecord(value.progress)) return null;
  if (!isStringArray(value.taughtChunkIds)) return null;
  if (!isStringArray(value.completedChunkIds)) return null;
  if (!isStringArray(value.completedLectureIds)) return null;
  if (!isRecord(value.injectedByChunk)) return null;
  if (!Object.values(value.injectedByChunk).every(isStringArray)) return null;

  // Stored flags are authoritative only in an envelope this build wrote.
  const explicit = value[EXPLICIT_REMEDIATION_MARK] === true;

  const progress: LearnerState["progress"] = {};
  const dropped: string[] = [];
  for (const [conceptId, record] of Object.entries(value.progress)) {
    if (isConceptProgress(record, conceptId)) {
      const valid = record as Omit<ConceptProgress, "pendingTutorRemediation"> & {
        pendingTutorRemediation?: boolean;
      };
      // State last written by a build that did not maintain the flag — main
      // before card study, or a tab still running it — gets it from main's
      // own rule, which is exact for everything such a build did. Otherwise a
      // stored value is authoritative and never re-inferred.
      progress[conceptId] =
        explicit && valid.pendingTutorRemediation !== undefined
          ? (valid as ConceptProgress)
          : { ...valid, pendingTutorRemediation: inferLegacyPendingTutorRemediation(valid) };
    } else {
      dropped.push(conceptId);
    }
  }

  const state: LearnerState = {
    version: value.version,
    progress,
    taughtChunkIds: value.taughtChunkIds,
    completedChunkIds: value.completedChunkIds,
    completedLectureIds: value.completedLectureIds,
    injectedByChunk: value.injectedByChunk as LearnerState["injectedByChunk"],
  };

  // Study-card progress is optional: state saved before card study existed
  // has none and loads unchanged. Malformed card records are dropped one by
  // one, like concept records, rather than discarding the learner's history.
  if (value.cards !== undefined) {
    if (!isRecord(value.cards)) return null;
    const cards: NonNullable<LearnerState["cards"]> = {};
    for (const [itemId, record] of Object.entries(value.cards)) {
      if (isCardProgress(record, itemId)) {
        cards[itemId] = record as NonNullable<LearnerState["cards"]>[string];
      } else {
        dropped.push(`card:${itemId}`);
      }
    }
    state.cards = cards;
  }

  return { state, dropped };
}

export class LocalStorageLearnerRepository implements LearnerStateRepository {
  constructor(private readonly key: string = STORAGE_KEY) {}

  load(): LearnerState | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return null;
      const sanitized = sanitizeLearnerState(JSON.parse(raw));
      if (!sanitized) return null;
      if (sanitized.state.version !== LEARNER_STATE_VERSION) return null;
      return sanitized.state;
    } catch {
      // Corrupt or unavailable storage must never break the app.
      return null;
    }
  }

  save(state: LearnerState): boolean {
    if (typeof window === "undefined") return false;
    try {
      window.localStorage.setItem(this.key, serializeLearnerState(state));
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(this.key);
    } catch {
      // ignore
    }
  }
}

/** In-memory implementation for tests and server rendering. */
export class InMemoryLearnerRepository implements LearnerStateRepository {
  private state: LearnerState | null = null;

  load(): LearnerState | null {
    return this.state;
  }

  save(state: LearnerState): boolean {
    this.state = state;
    return true;
  }

  clear(): void {
    this.state = null;
  }
}

export function loadOrCreate(repo: LearnerStateRepository): LearnerState {
  return repo.load() ?? createLearnerState();
}
