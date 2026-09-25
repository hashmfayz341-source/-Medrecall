import { LEARNER_STATE_VERSION, createLearnerState } from "@/lib/engine/tutor";
import type { LearnerState } from "@/lib/domain/types";
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

  const progress: LearnerState["progress"] = {};
  const dropped: string[] = [];
  for (const [conceptId, record] of Object.entries(value.progress)) {
    if (isConceptProgress(record, conceptId)) {
      progress[conceptId] = record as LearnerState["progress"][string];
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
      window.localStorage.setItem(this.key, JSON.stringify(state));
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
