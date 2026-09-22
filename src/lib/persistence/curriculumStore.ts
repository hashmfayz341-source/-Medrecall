import {
  CURRICULUM_OVERRIDES_VERSION,
  createOverrides,
  migrateOverrides,
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
      // migrateOverrides validates the shape and upgrades older versions,
      // so a Milestone 1 store keeps its approval decisions.
      const migrated = migrateOverrides(stored);
      if (!migrated) return null;

      // An older payload may still hold decisions the migration strips as
      // unsafe. Write the cleaned version back so the unsafe one does not
      // remain on disk for another tab or a later reader to pick up.
      const storedVersion =
        typeof stored === "object" && stored !== null
          ? (stored as { version?: unknown }).version
          : undefined;
      if (storedVersion !== CURRICULUM_OVERRIDES_VERSION) {
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
