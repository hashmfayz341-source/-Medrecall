import { S_MIN, State } from "ts-fsrs";
import { tutorScheduleRevision } from "@/lib/domain/mastery";
import {
  LEARNER_STATE_VERSION,
  createLearnerState,
  inferLegacyPendingTutorRemediation,
} from "@/lib/engine/tutor";
import type {
  CardFlags,
  CardProgress,
  ConceptProgress,
  LearnerState,
  StudyDayLog,
} from "@/lib/domain/types";
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
/** Bumped when the sidecar gained `generation`; a v1 sidecar is unbound. */
export const STUDY_CARDS_VERSION = 2;

/**
 * Learner generation: the identity of one learner lineage, created when this
 * build first saves a learner that has none, and carried in the envelope AND
 * stamped into every stored concept record. main rebuilds the envelope (the
 * envelope-level copy is lost) but keeps each concept record as stored (the
 * stamps survive), while a Reset — in any build — removes every record. So
 * after a Reset in a stale main tab followed by main's fresh learner, no
 * stamp remains and the old sidecar, bound to the old generation, cannot
 * attach. It is a random id, never a timestamp.
 */
const GENERATION = "generation";

function newGeneration(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  let id = "";
  while (id.length < 32) id += Math.floor(Math.random() * 16).toString(16);
  return id;
}

/** Every generation a stored envelope carries: its own field plus record stamps. */
function learnerGenerations(envelope: unknown): Set<string> {
  const found = new Set<string>();
  if (!isRecord(envelope)) return found;
  if (typeof envelope[GENERATION] === "string") found.add(envelope[GENERATION]);
  if (isRecord(envelope.progress)) {
    for (const record of Object.values(envelope.progress)) {
      if (isRecord(record) && typeof record[GENERATION] === "string") found.add(record[GENERATION]);
    }
  }
  return found;
}

/** The generation a save continues: the envelope's, else the first stamp, else a new one. */
function learnerGeneration(envelope: unknown): string {
  if (isRecord(envelope) && typeof envelope[GENERATION] === "string") return envelope[GENERATION];
  const stamped: string[] = [];
  if (isRecord(envelope) && isRecord(envelope.progress)) {
    for (const conceptId of Object.keys(envelope.progress).sort()) {
      const record = envelope.progress[conceptId];
      if (isRecord(record) && typeof record[GENERATION] === "string") stamped.push(record[GENERATION]);
    }
  }
  return stamped[0] ?? newGeneration();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

const MASTERY_STATES = ["NEW", "LEARNING", "WEAK", "STABLE", "STRONG"];

/** The FSRS states the installed ts-fsrs defines: New, Learning, Review, Relearning. */
const FSRS_STATES = new Set<unknown>(Object.values(State).filter((v) => typeof v === "number"));

/**
 * A schedule is only usable if every field the FSRS engine reads is present
 * and well formed. A record with `due` missing would reach `new Date(undefined)`
 * and put NaN through the Today queue and the scheduler; a `state` FSRS does
 * not define, or a memory state FSRS rejects, throws inside the library the
 * next time the card is rated. Both rules come from ts-fsrs itself: `State`,
 * and `next_state`'s precondition (an empty memory state, or difficulty >= 1
 * and stability >= S_MIN).
 */
function isScheduleState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.due !== "string") return false;
  if (Number.isNaN(new Date(value.due).getTime())) return false;
  if (value.last_review !== undefined) {
    if (typeof value.last_review !== "string") return false;
    if (Number.isNaN(new Date(value.last_review).getTime())) return false;
  }
  if (
    ![
      "stability",
      "difficulty",
      "elapsed_days",
      "scheduled_days",
      "learning_steps",
      "reps",
      "lapses",
    ].every((key) => Number.isFinite(value[key]))
  ) {
    return false;
  }
  if (!FSRS_STATES.has(value.state)) return false;
  const difficulty = value.difficulty as number;
  const stability = value.stability as number;
  return (difficulty === 0 && stability === 0) || (difficulty >= 1 && stability >= S_MIN);
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

function isCardFlags(value: unknown): value is CardFlags {
  if (!isRecord(value)) return false;
  if (typeof value.conceptId !== "string" || value.conceptId.length === 0) return false;
  if (value.suspended !== undefined && typeof value.suspended !== "boolean") return false;
  if (value.buriedUntil !== undefined) {
    if (typeof value.buriedUntil !== "string") return false;
    if (Number.isNaN(new Date(value.buriedUntil).getTime())) return false;
  }
  return value.suspended === true || typeof value.buriedUntil === "string";
}

function isStudyDayLog(value: unknown): value is StudyDayLog {
  return (
    isRecord(value) &&
    typeof value.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value.day) &&
    Number.isInteger(value.newIntroduced) &&
    (value.newIntroduced as number) >= 0 &&
    Number.isInteger(value.reviews) &&
    (value.reviews as number) >= 0
  );
}

export interface StudySidecar {
  generation: string;
  cards: Record<string, CardProgress>;
  /** Absent when the sidecar predates flags, or has none. */
  flags?: Record<string, CardFlags>;
  studyDay?: StudyDayLog;
  dropped: string[];
}

/**
 * Validate the Study-card sidecar. Returns null when it cannot be trusted as a
 * whole (not an object, unknown version, no generation, `cards` not an
 * object); otherwise the learner generation it is bound to and the valid card
 * records, with malformed ones dropped individually. Suspend/bury flags and
 * today's Study tally travel in the same sidecar (Study-owned, never in the
 * envelope); malformed flags are dropped one by one, a malformed tally as a
 * whole (it only costs today's limit count).
 */
export function sanitizeStudyCards(value: unknown): StudySidecar | null {
  if (!isRecord(value)) return null;
  if (value.version !== STUDY_CARDS_VERSION) return null;
  if (typeof value[GENERATION] !== "string" || value[GENERATION].length === 0) return null;
  if (!isRecord(value.cards)) return null;
  const dropped: string[] = [];
  const result: StudySidecar = {
    generation: value[GENERATION],
    cards: sanitizeCardRecords(value.cards, dropped),
    dropped,
  };
  if (isRecord(value.flags)) {
    const flags: Record<string, CardFlags> = {};
    for (const [itemId, record] of Object.entries(value.flags)) {
      if (isCardFlags(record)) flags[itemId] = record;
      else dropped.push(`flags:${itemId}`);
    }
    result.flags = flags;
  }
  if (isStudyDayLog(value.studyDay)) result.studyDay = value.studyDay;
  return result;
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
      // The generation stamp is a persistence-only field (see GENERATION).
      const { [GENERATION]: _stamp, ...valid } = record as Omit<
        ConceptProgress,
        "pendingTutorRemediation" | "pendingTutorRemediationRevision"
      > &
        Partial<Pick<ConceptProgress, "pendingTutorRemediation" | "pendingTutorRemediationRevision">> & {
          [GENERATION]?: unknown;
        };
      void _stamp;
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
  // Likewise Study-owned flags and today's tally: never written to the
  // envelope by this build, but read if present so a serialized LearnerState
  // round-trips; the repository's sidecar takes precedence.
  if (isRecord(value.cardFlags)) {
    const cardFlags: Record<string, CardFlags> = {};
    for (const [itemId, record] of Object.entries(value.cardFlags)) {
      if (isCardFlags(record)) cardFlags[itemId] = record;
      else dropped.push(`flags:${itemId}`);
    }
    state.cardFlags = cardFlags;
  }
  if (isStudyDayLog(value.studyDay)) state.studyDay = value.studyDay;

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
 * sidecar (`STUDY_CARDS_STORAGE_KEY`), bound together by the learner
 * generation (see GENERATION).
 *
 * LOAD. The envelope is sanitized as always; without one there is no learner
 * (the sidecar is never used on its own). Card progress then comes from:
 *   1. a valid sidecar whose generation the envelope carries (its own field,
 *      or a stamp on any concept record) — authoritative whenever it exists.
 *      A sidecar bound to another generation is an orphan of a learner that
 *      was Reset (possibly in a stale main tab, which removes only the
 *      envelope) and is ignored: the mere presence of an envelope never
 *      attaches it;
 *   2. otherwise `cards` inside the envelope (state from earlier card-study
 *      builds): migrated, and moved to the sidecar by the next save;
 *   3. otherwise none.
 * A stale main tab rewriting the envelope without `cards` therefore never
 * loses card schedules: the stamps it keeps still bind the sidecar. Quarantine
 * runs on the merged state as before, and its result is saved through here,
 * so removed cards are removed from the sidecar and cannot come back.
 *
 * SAVE. The generation is the stored envelope's (field or stamp), or a new one
 * for a learner that has none — a first save, or the first save after a Reset.
 * localStorage cannot update two keys atomically, so the order is fixed:
 *   1. the sidecar, if the state has card progress. A state with no `cards`
 *      at all never erases the sidecar of the same generation (an existing
 *      learner); a sidecar of another generation is an orphan and is removed,
 *      so cleared card schedules cannot come back;
 *   2. then the envelope, without `cards`, with the generation in its own
 *      field and stamped on every concept record, only if step 1 succeeded.
 * If the sidecar write fails, nothing is written: storage keeps the last saved
 * pair. If the envelope write fails after the sidecar, card progress is the
 * newer one while concept progress is the last saved (a card is never lost;
 * at most one save's mastery change is; both carry the same generation).
 * Either way `save` returns false and the app reports the failure — no
 * transaction is claimed.
 *
 * Two tabs saving a learner that has no generation yet, in the same instant,
 * could each mint one; the last envelope written wins and a sidecar written
 * with the other would be treated as an orphan. The window is one save.
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
      const raw = readJson(this.key);
      const sanitized = sanitizeLearnerState(raw);
      if (!sanitized) return null;
      if (sanitized.state.version !== LEARNER_STATE_VERSION) return null;
      const state = sanitized.state;
      const sidecar = sanitizeStudyCards(readJson(this.cardsKey));
      if (sidecar && learnerGenerations(raw).has(sidecar.generation)) {
        state.cards = sidecar.cards;
        if (sidecar.flags) state.cardFlags = sidecar.flags;
        if (sidecar.studyDay) state.studyDay = sidecar.studyDay;
      }
      return state;
    } catch {
      // Corrupt or unavailable storage must never break the app.
      return null;
    }
  }

  save(state: LearnerState): boolean {
    if (typeof window === "undefined") return false;
    // Everything Study-owned goes to the sidecar, never the envelope.
    const { cards, cardFlags, studyDay, ...envelope } = state;
    // Flags can exist before any card was rated (a never-studied card can be
    // suspended), so any Study-owned state at all is written.
    const hasStudyState = cards !== undefined || cardFlags !== undefined || studyDay !== undefined;
    let generation: string;
    try {
      generation = learnerGeneration(readJson(this.key));
      if (hasStudyState) {
        // A state that carries no `cards` at all never erases the stored
        // cards of this learner: they are kept, and only what the state does
        // carry (flags, today's tally) is written over.
        const stored = cards === undefined ? sanitizeStudyCards(readJson(this.cardsKey)) : null;
        const keptCards = stored && stored.generation === generation ? stored.cards : {};
        window.localStorage.setItem(
          this.cardsKey,
          JSON.stringify({
            version: STUDY_CARDS_VERSION,
            [GENERATION]: generation,
            cards: cards ?? keptCards,
            ...(cardFlags ? { flags: cardFlags } : {}),
            ...(studyDay ? { studyDay } : {}),
          }),
        );
      } else if (sanitizeStudyCards(readJson(this.cardsKey))?.generation !== generation) {
        // Nothing to write, and whatever sidecar is stored belongs to another
        // learner (one that was Reset) or is unreadable: it must not survive.
        window.localStorage.removeItem(this.cardsKey);
      }
    } catch {
      return false;
    }
    try {
      const progress: Record<string, ConceptProgress & { [GENERATION]: string }> = {};
      for (const [conceptId, record] of Object.entries(envelope.progress)) {
        progress[conceptId] = { ...record, [GENERATION]: generation };
      }
      window.localStorage.setItem(
        this.key,
        JSON.stringify({ ...envelope, progress, [GENERATION]: generation }),
      );
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
