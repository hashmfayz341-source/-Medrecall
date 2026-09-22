import { LEARNER_STATE_VERSION, createLearnerState } from "@/lib/engine/tutor";
import type { LearnerState } from "@/lib/domain/types";
import type { LearnerStateRepository } from "./repository";

export const STORAGE_KEY = "medrecall.learner.v1";

/** Narrow runtime check — storage is untrusted input like any other. */
function isLearnerState(value: unknown): value is LearnerState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<LearnerState>;
  return (
    typeof v.version === "number" &&
    typeof v.progress === "object" &&
    v.progress !== null &&
    Array.isArray(v.taughtChunkIds) &&
    Array.isArray(v.completedChunkIds) &&
    Array.isArray(v.completedLectureIds) &&
    typeof v.injectedByChunk === "object" &&
    v.injectedByChunk !== null
  );
}

export class LocalStorageLearnerRepository implements LearnerStateRepository {
  constructor(private readonly key: string = STORAGE_KEY) {}

  load(): LearnerState | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isLearnerState(parsed)) return null;
      if (parsed.version !== LEARNER_STATE_VERSION) return null;
      return parsed;
    } catch {
      // Corrupt or unavailable storage must never break the app.
      return null;
    }
  }

  save(state: LearnerState): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(this.key, JSON.stringify(state));
    } catch {
      // Quota or private-mode failures are non-fatal.
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

  save(state: LearnerState): void {
    this.state = state;
  }

  clear(): void {
    this.state = null;
  }
}

export function loadOrCreate(repo: LearnerStateRepository): LearnerState {
  return repo.load() ?? createLearnerState();
}
