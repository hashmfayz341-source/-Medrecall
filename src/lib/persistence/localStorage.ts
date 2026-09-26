import { tutorScheduleRevision } from "@/lib/domain/mastery";
import {
  LEARNER_STATE_VERSION,
  createLearnerState,
  inferLegacyPendingTutorRemediation,
} from "@/lib/engine/tutor";
import type { CardProgress, ConceptProgress, LearnerState } from "@/lib/domain/types";
import type { LearnerStateRepository } from "./repository";

/**
 * The learner envelope. main before card study also reads and REWRITES this
 * key: it keeps each concept record as stored but rebuilds the envelope with
 * only the fields it knows, so anything else stored here (e.g. `cards`) is
 * lost whenever a tab still running main saves.
 */
export const STORAGE_KEY = "medrecall.learner.v1";

/**
 * Study-card FSRS progress, owned only by card study. main never reads or
 * writes this key, so a stale main tab cannot erase card schedules.
 */
export const STUDY_CARDS_STORAGE_KEY = "medrecall.study-cards.v1";
export const STUDY_CARDS_VERSION = 1;

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
  // Absent in state saved before they existed (derived on load, below);
  // present, they must be well formed like every other field.
  if (
    value.pendingTutorRemediation !== undefined &&
    typeof value.pendingTutorRemediation !== "boolean"
  ) {
    return false;
  }
  if (
    value.pendingTutorRemediationRevision !== undefined &&
    typeof value.pendingTutorRemediationRevision !== "string"
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

/** Validate card records one by one, dropping malformed ones. */
function sanitizeCardRecords(
  value: Record<string, unknown>,
  dropped: string[],
): Record<string, CardProgress> {
  const cards: Record<string, CardProgress> = {};
  for (const [itemId, record] of Object.entries(value)) {
    if (isCardProgress(record, itemId)) {
      cards[itemId] = record as CardProgress;
    } else {
      dropped.push(`card:${itemId}`);
    }
  }
  return cards;
}

/**
 * Validate the Study-card sidecar. Returns null when it cannot be trusted as a
 * whole (not an object, unknown version, `cards` not an object); otherwise the
 * valid card records, with malformed ones dropped individually.
 */
export function sanitizeStudyCards(
  value: unknown,
): { cards: Record<string, CardProgress>; dropped: string[] } | null {
  if (!isRecord(value)) return null;
  if (value.version !== STUDY_CARDS_VERSION) return null;
  if (!isRecord(value.cards)) return null;
  const dropped: string[] = [];
  return { cards: sanitizeCardRecords(value.cards, dropped), dropped };
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
      const valid = record as Omit<
        ConceptProgress,
        "pendingTutorRemediation" | "pendingTutorRemediationRevision"
      > &
        Partial<Pick<ConceptProgress, "pendingTutorRemediation" | "pendingTutorRemediationRevision">>;
      // A stored flag is trusted only if it was decided at the Tutor schedule
      // revision the record has now. main keeps both fields as stored, so if a
      // tab running main made a Tutor attempt on this concept since, the
      // revision no longer matches and the flag may be stale; main's own rule
      // then decides, as it does for state main wrote before the field existed.
      const revision = tutorScheduleRevision(valid.schedule);
      const current =
        typeof valid.pendingTutorRemediation === "boolean" &&
        valid.pendingTutorRemediationRevision === revision;
      progress[conceptId] = {
        ...valid,
        pendingTutorRemediation: current
          ? valid.pendingTutorRemediation!
          : inferLegacyPendingTutorRemediation(valid),
        pendingTutorRemediationRevision: revision,
      };
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

  // Cards inside the envelope exist only in state written by earlier builds
  // of card study, before the sidecar. They are still read — the repository
  // uses them when there is no valid sidecar yet — and malformed records are
  // dropped one by one, like concept records.
  if (value.cards !== undefined) {
    if (!isRecord(value.cards)) return null;
    state.cards = sanitizeCardRecords(value.cards, dropped);
  }

  return { state, dropped };
}

function readJson(key: string): unknown {
  const raw = window.localStorage.getItem(key);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Learner state in two keys: the envelope (`STORAGE_KEY`) and the Study-card
 * sidecar (`STUDY_CARDS_STORAGE_KEY`).
 *
 * LOAD. The envelope is sanitized as always; without one there is no learner
 * (the sidecar is never used on its own). Card progress then comes from:
 *   1. a valid sidecar — authoritative whenever it exists;
 *   2. otherwise `cards` inside the envelope (state from earlier card-study
 *      builds): migrated, and moved to the sidecar by the next save;
 *   3. otherwise none.
 * A stale main tab rewriting the envelope without `cards` therefore never
 * loses card schedules. Quarantine runs on the merged state as before, and its
 * result is saved through here, so removed cards are removed from the sidecar
 * and cannot come back.
 *
 * SAVE. localStorage cannot update two keys atomically, so the order is fixed:
 *   1. the sidecar, if the state has card progress. A state with no `cards`
 *      at all never erases the sidecar of an existing learner; it removes
 *      one only when no envelope is stored either (a new learner after a
 *      Reset, including a Reset in a stale main tab, which removes only the
 *      envelope) so cleared card schedules cannot come back;
 *   2. then the envelope, without `cards`, only if step 1 succeeded.
 * If the sidecar write fails, nothing is written: storage keeps the last saved
 * pair. If the envelope write fails after the sidecar, card progress is the
 * newer one while concept progress is the last saved (a card is never lost;
 * at most one save's mastery change is). Either way `save` returns false and
 * the app reports the failure — no transaction is claimed.
 *
 * CLEAR removes both keys.
 */
export class LocalStorageLearnerRepository implements LearnerStateRepository {
  constructor(
    private readonly key: string = STORAGE_KEY,
    private readonly cardsKey: string = STUDY_CARDS_STORAGE_KEY,
  ) {}

  load(): LearnerState | null {
    if (typeof window === "undefined") return null;
    try {
      const sanitized = sanitizeLearnerState(readJson(this.key));
      if (!sanitized) return null;
      if (sanitized.state.version !== LEARNER_STATE_VERSION) return null;
      const state = sanitized.state;
      const sidecar = sanitizeStudyCards(readJson(this.cardsKey));
      if (sidecar) {
        state.cards = sidecar.cards;
      }
      return state;
    } catch {
      // Corrupt or unavailable storage must never break the app.
      return null;
    }
  }

  save(state: LearnerState): boolean {
    if (typeof window === "undefined") return false;
    const { cards, ...envelope } = state;
    try {
      if (cards !== undefined) {
        window.localStorage.setItem(
          this.cardsKey,
          JSON.stringify({ version: STUDY_CARDS_VERSION, cards }),
        );
      } else if (window.localStorage.getItem(this.key) === null) {
        // No learner envelope and no cards in memory: this is a new learner
        // (first save, or after a Reset — possibly one made by a tab still
        // running main, which only removes the envelope). A sidecar left
        // behind belongs to the cleared learner and must not come back.
        window.localStorage.removeItem(this.cardsKey);
      }
    } catch {
      return false;
    }
    try {
      window.localStorage.setItem(this.key, JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    if (typeof window === "undefined") return;
    for (const key of [this.key, this.cardsKey]) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // ignore
      }
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
