import {
  CURRICULUM_OVERRIDES_VERSION,
  createOverrides,
  sanitizeOverrides,
  type CurriculumOverrides,
} from "@/lib/domain/curriculum";

export const CURRICULUM_STORAGE_KEY = "medrecall.curriculum.v1";

export interface CurriculumOverridesRepository {
  load(): CurriculumOverrides | null;
  save(value: CurriculumOverrides): boolean;
  clear(): void;
}

export class LocalStorageCurriculumRepository
  implements CurriculumOverridesRepository
{
  constructor(private readonly key: string = CURRICULUM_STORAGE_KEY) {}

  load(): CurriculumOverrides | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return null;

      const stored: unknown = JSON.parse(raw);
      // sanitizeOverrides validates the shape and upgrades older versions,
      // so a Milestone 1 store keeps its approval decisions. Merge-related
      // entries and derived concept fields are validated one record at a
      // time: a malformed one is dropped on its own, never the whole store.
      const result = sanitizeOverrides(stored);
      if (!result) return null;
      const { overrides: migrated, dropped } = result;

      // An older payload may still hold decisions the migration strips as
      // unsafe, and a current one may hold entries that were just dropped.
      // Write the cleaned version back so the unsafe one does not remain on
      // disk for another tab or a later reader to pick up.
      const storedVersion =
        typeof stored === "object" && stored !== null
          ? (stored as { version?: unknown }).version
          : undefined;
      if (storedVersion !== CURRICULUM_OVERRIDES_VERSION || dropped.length > 0) {
        // Best effort: if the write fails the returned value is still the
        // safe, migrated one.
        this.save(migrated);
      }

      return migrated;
    } catch {
      return null;
    }
  }

  save(value: CurriculumOverrides): boolean {
    if (typeof window === "undefined") return false;
    try {
      window.localStorage.setItem(this.key, JSON.stringify(value));
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

export class InMemoryCurriculumRepository
  implements CurriculumOverridesRepository
{
  private value: CurriculumOverrides | null = null;
  load() {
    return this.value;
  }
  save(value: CurriculumOverrides) {
    this.value = value;
    return true;
  }
  clear() {
    this.value = null;
  }
}

export function loadOrCreateOverrides(
  repo: CurriculumOverridesRepository,
): CurriculumOverrides {
  return repo.load() ?? createOverrides();
}

/**
 * Apply a curriculum mutation to what is stored NOW and persist the result.
 *
 * Every mutation is an id-keyed decision (approve this concept, edit that
 * title, merge these two), so it can be rebased onto the current store. A
 * tab's in-memory snapshot goes stale the moment another tab writes — or
 * whenever a storage event is missed — and serialising that snapshot would
 * silently drop the other tab's decisions: a merge, a Keep both, an Undo.
 * The snapshot is used only when nothing can be read from storage (nothing
 * stored yet, or storage unavailable), where it is the freshest state there
 * is. The operation itself may throw (e.g. `MergeError` against the current
 * state); nothing is written then.
 */
export function commitOverrides(
  repo: CurriculumOverridesRepository,
  fallback: CurriculumOverrides,
  fn: (current: CurriculumOverrides) => CurriculumOverrides,
): { next: CurriculumOverrides; saved: boolean } {
  const next = fn(repo.load() ?? fallback);
  return { next, saved: repo.save(next) };
}
