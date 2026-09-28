"use client";

import { useCallback, useSyncExternalStore } from "react";
import { DEFAULT_STUDY_LIMITS, type StudyLimits } from "@/lib/engine/study";
import {
  STUDY_SETTINGS_STORAGE_KEY,
  loadStudySettings,
  saveStudySettings,
} from "@/lib/persistence/studySettings";

/*
 * Daily Study limits as an external store: read from localStorage on the
 * client (the server snapshot is the defaults, so markup agrees), saved on
 * change, and picked up from another tab through its storage event.
 */

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedLimits: StudyLimits = DEFAULT_STUDY_LIMITS;

function snapshot(): StudyLimits {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STUDY_SETTINGS_STORAGE_KEY);
  } catch {
    raw = null;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedLimits = loadStudySettings();
  }
  return cachedLimits;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STUDY_SETTINGS_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useStudySettings(): { limits: StudyLimits; setLimits: (next: StudyLimits) => boolean } {
  const limits = useSyncExternalStore(subscribe, snapshot, () => DEFAULT_STUDY_LIMITS);
  const setLimits = useCallback((next: StudyLimits) => {
    const saved = saveStudySettings(next);
    if (saved) for (const listener of listeners) listener();
    return saved;
  }, []);
  return { limits, setLimits };
}
