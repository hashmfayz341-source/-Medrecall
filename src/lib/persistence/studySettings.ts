import { DEFAULT_STUDY_LIMITS, type StudyLimits } from "@/lib/engine/study";

/**
 * Study options (daily limits), in their own key. They are preferences, not
 * learner progress: a Reset of learner state leaves them alone, and a tab still
 * running an older build never touches them.
 */
export const STUDY_SETTINGS_STORAGE_KEY = "medrecall.study-settings.v1";
export const STUDY_SETTINGS_VERSION = 1;

export const STUDY_LIMIT_MAX = 9999;

function isLimit(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= STUDY_LIMIT_MAX;
}

/** Valid settings, or null for anything that cannot be trusted. */
export function sanitizeStudySettings(value: unknown): StudyLimits | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== STUDY_SETTINGS_VERSION) return null;
  if (!isLimit(record.newPerDay) || !isLimit(record.reviewsPerDay)) return null;
  return { newPerDay: record.newPerDay, reviewsPerDay: record.reviewsPerDay };
}

export function loadStudySettings(): StudyLimits {
  if (typeof window === "undefined") return DEFAULT_STUDY_LIMITS;
  try {
    const raw = window.localStorage.getItem(STUDY_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_STUDY_LIMITS;
    return sanitizeStudySettings(JSON.parse(raw)) ?? DEFAULT_STUDY_LIMITS;
  } catch {
    return DEFAULT_STUDY_LIMITS;
  }
}

export function saveStudySettings(limits: StudyLimits): boolean {
  if (typeof window === "undefined") return false;
  if (!isLimit(limits.newPerDay) || !isLimit(limits.reviewsPerDay)) return false;
  try {
    window.localStorage.setItem(
      STUDY_SETTINGS_STORAGE_KEY,
      JSON.stringify({ version: STUDY_SETTINGS_VERSION, ...limits }),
    );
    return true;
  } catch {
    return false;
  }
}
