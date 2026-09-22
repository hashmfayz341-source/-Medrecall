import {
  CURRICULUM_OVERRIDES_VERSION,
  createOverrides,
  type CurriculumOverrides,
} from "@/lib/domain/curriculum";

export const CURRICULUM_STORAGE_KEY = "medrecall.curriculum.v1";

export interface CurriculumOverridesRepository {
  load(): CurriculumOverrides | null;
  save(value: CurriculumOverrides): void;
  clear(): void;
}

function isOverrides(value: unknown): value is CurriculumOverrides {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<CurriculumOverrides>;
  return (
    typeof v.version === "number" &&
    typeof v.statusById === "object" &&
    v.statusById !== null
  );
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
      const parsed: unknown = JSON.parse(raw);
      if (!isOverrides(parsed)) return null;
      if (parsed.version !== CURRICULUM_OVERRIDES_VERSION) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  save(value: CurriculumOverrides): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(this.key, JSON.stringify(value));
    } catch {
      // ignore
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
