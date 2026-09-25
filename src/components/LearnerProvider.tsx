"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  addIngestedDocument,
  addLecture,
  applyOverrides,
  createOverrides,
  editConcept,
  hasLegacyDocumentIdentity,
  setConceptStatus,
  setConceptStatuses,
  type ConceptEdit,
  type CurriculumOverrides,
  type IngestedDocument,
} from "@/lib/domain/curriculum";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { createLearnerState } from "@/lib/engine/tutor";
import { LocalStorageLearnerRepository, STORAGE_KEY } from "@/lib/persistence/localStorage";
import { acceptIncomingLearnerState } from "@/lib/domain/quarantine";
import { LocalStorageCurriculumRepository, CURRICULUM_STORAGE_KEY } from "@/lib/persistence/curriculumStore";
import type {
  Concept,
  ConceptStatus,
  Curriculum,
  LearnerState,
  Lecture,
} from "@/lib/domain/types";

interface LearnerContextValue {
  /** Authored content + ingested material + edits + approval decisions. */
  curriculum: Curriculum;
  learner: LearnerState;
  /** False until localStorage has been read on the client. */
  ready: boolean;
  setLearner: (next: LearnerState) => void;
  /**
   * The freshest curriculum and learner state available right now: what is
   * persisted (so another tab's writes are seen even before its storage event
   * arrives), quarantine-filtered, falling back to this tab's memory. Used to
   * apply an asynchronous grade to current state rather than a stale render.
   */
  snapshot: () => { curriculum: Curriculum; learner: LearnerState };
  /** Re-read both stores into this tab, as a storage event would. */
  syncFromStorage: () => void;
  updateConceptStatus: (conceptId: string, status: ConceptStatus) => void;
  updateConceptStatuses: (conceptIds: readonly string[], status: ConceptStatus) => void;
  updateConceptText: (conceptId: string, edit: ConceptEdit) => void;
  createLecture: (lecture: Lecture) => void;
  storeIngestedDocument: (
    ingested: IngestedDocument,
    concepts: readonly Concept[],
  ) => void;
  resetAll: () => void;
}

const LearnerContext = createContext<LearnerContextValue | null>(null);

export function LearnerProvider({ children }: { children: React.ReactNode }) {
  const [learner, setLearnerState] = useState<LearnerState>(createLearnerState);
  const [overrides, setOverrides] = useState<CurriculumOverrides>(createOverrides);
  const [ready, setReady] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [quarantined, setQuarantined] = useState(0);
  const overridesRef = useRef(overrides);
  // The storage handler is registered once, so it reads the current learner
  // state through a ref rather than a stale closure.
  const learnerRef = useRef(learner);
  useEffect(() => {
    learnerRef.current = learner;
  }, [learner]);

  const learnerRepo = useRef(new LocalStorageLearnerRepository());
  const curriculumRepo = useRef(new LocalStorageCurriculumRepository());
  // When a write fails, storage no longer holds this tab's latest state, so
  // snapshots must come from memory instead.
  const lastSaveFailed = useRef(false);

  /** Filter incoming learner state, persist and report any quarantine. */
  const acceptLearnerState = useCallback(
    (incoming: LearnerState, overridesForCheck: CurriculumOverrides | null) => {
      const result = acceptIncomingLearnerState(incoming, overridesForCheck);
      setLearnerState(result.learner);
      // Persist whenever anything was removed, not only concept progress:
      // legacy chunk, lecture and interleaving state can exist on its own, and
      // cleaning it only in memory lets it return on the next reload.
      if (result.changed) {
        learnerRepo.current.save(result.learner);
      }
      if (result.quarantinedConceptIds.length > 0) {
        setQuarantined((current) =>
          Math.max(current, result.quarantinedConceptIds.length),
        );
      }
      return result;
    },
    [],
  );

  /**
   * Pull both stores into this tab. Shared by the storage event and by
   * `syncFromStorage()`.
   */
  const sync = useCallback(
    (curriculumChanged: boolean) => {
      // Always refresh curriculum first: the quarantine decision depends on
      // which document identities are currently known to be untrusted.
      const latestOverrides = curriculumRepo.current.load();
      if (latestOverrides) overridesRef.current = latestOverrides;

      if (curriculumChanged) {
        const latest = latestOverrides ?? createOverrides();
        overridesRef.current = latest;
        setOverrides(latest);
      }

      // Re-check learner state on EITHER event, not just a learner one.
      //
      // A curriculum event can be what first reveals a document identity as
      // untrusted. Waiting for a separate learner event (or a reload) would
      // leave legacy mastery, completion and interleaving state live in this
      // tab in the meantime. Running it on both events also makes the two
      // possible orderings converge on the same safe result.
      //
      // acceptLearnerState only writes when something was actually removed,
      // so repeating this is idempotent and cannot loop.
      acceptLearnerState(
        learnerRepo.current.load() ?? learnerRef.current,
        overridesRef.current,
      );
    },
    [acceptLearnerState],
  );
  const syncRef = useRef(sync);
  useEffect(() => {
    syncRef.current = sync;
  }, [sync]);

  // Hydrate from storage after mount so server and client markup agree.
  useEffect(() => {
    const storedLearner = learnerRepo.current.load();
    const storedOverrides = curriculumRepo.current.load();

    if (storedOverrides) {
      overridesRef.current = storedOverrides;
      setOverrides(storedOverrides);
    }

    if (storedLearner) {
      // Progress recorded against a colliding legacy document identity may
      // belong to a different PDF entirely, so it is discarded once rather
      // than silently carried into re-approved material.
      acceptLearnerState(storedLearner, storedOverrides);
    }

    setReady(true);
    function onStorage(event: StorageEvent) {
      const curriculumChanged =
        event.key === CURRICULUM_STORAGE_KEY || event.key === null;
      const learnerChanged = event.key === STORAGE_KEY || event.key === null;
      if (!curriculumChanged && !learnerChanged) return;
      syncRef.current(curriculumChanged);
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [acceptLearnerState]);

  const setLearner = useCallback((next: LearnerState) => {
    setLearnerState(next);
    learnerRef.current = next;
    const saved = learnerRepo.current.save(next);
    lastSaveFailed.current = !saved;
    if (!saved) setStorageError(true);
  }, []);

  const snapshot = useCallback(() => {
    if (lastSaveFailed.current) {
      return {
        curriculum: applyOverrides(pathologyCurriculum, overridesRef.current),
        learner: learnerRef.current,
      };
    }
    const overrides = curriculumRepo.current.load() ?? overridesRef.current;
    const stored = learnerRepo.current.load() ?? learnerRef.current;
    return {
      curriculum: applyOverrides(pathologyCurriculum, overrides),
      learner: acceptIncomingLearnerState(stored, overrides).learner,
    };
  }, []);

  const syncFromStorage = useCallback(() => sync(true), [sync]);

  /** Apply a change to curriculum state and persist it in one step. */
  const mutate = useCallback(
    (fn: (current: CurriculumOverrides) => CurriculumOverrides) => {
      const next = fn(overridesRef.current);
      if (!curriculumRepo.current.save(next)) setStorageError(true);
      overridesRef.current = next;
      setOverrides(next);
    },
    [],
  );

  const updateConceptStatus = useCallback(
    (conceptId: string, status: ConceptStatus) =>
      mutate((current) => setConceptStatus(current, conceptId, status)),
    [mutate],
  );

  const updateConceptStatuses = useCallback(
    (conceptIds: readonly string[], status: ConceptStatus) =>
      mutate((current) => setConceptStatuses(current, conceptIds, status)),
    [mutate],
  );

  const updateConceptText = useCallback(
    (conceptId: string, edit: ConceptEdit) =>
      mutate((current) => editConcept(current, conceptId, edit)),
    [mutate],
  );

  const createLecture = useCallback(
    (lecture: Lecture) => mutate((current) => addLecture(current, lecture)),
    [mutate],
  );

  const storeIngestedDocument = useCallback(
    (ingested: IngestedDocument, concepts: readonly Concept[]) =>
      mutate((current) => addIngestedDocument(current, ingested, concepts)),
    [mutate],
  );

  const resetAll = useCallback(() => {
    const fresh = createLearnerState();
    lastSaveFailed.current = false;
    learnerRepo.current.clear();
    curriculumRepo.current.clear();
    setLearnerState(fresh);
    const freshOverrides = createOverrides();
    overridesRef.current = freshOverrides;
    setOverrides(freshOverrides);
    setStorageError(false);
  }, []);

  const curriculum = useMemo(
    () => applyOverrides(pathologyCurriculum, overrides),
    [overrides],
  );

  const value = useMemo<LearnerContextValue>(
    () => ({
      curriculum,
      learner,
      ready,
      setLearner,
      snapshot,
      syncFromStorage,
      updateConceptStatus,
      updateConceptStatuses,
      updateConceptText,
      createLecture,
      storeIngestedDocument,
      resetAll,
    }),
    [
      curriculum,
      learner,
      ready,
      setLearner,
      snapshot,
      syncFromStorage,
      updateConceptStatus,
      updateConceptStatuses,
      updateConceptText,
      createLecture,
      storeIngestedDocument,
      resetAll,
    ],
  );

  return (
    <LearnerContext.Provider value={value}>
      {storageError && (
        <div role="alert" data-testid="storage-error" className="sticky top-0 z-50 border-b border-red-300 bg-red-50 p-4 text-red-800">
          Your latest changes could not be saved. Browser storage is full or unavailable.
          Keep this tab open: reloading may lose uploaded material, review decisions or progress.
        </div>
      )}
      {ready && curriculum.concepts.some((c) => c.status === "DRAFT" && hasLegacyDocumentIdentity(c.source.documentId)) && (
        <div role="status" className="border-b border-amber-300 bg-amber-50 p-4 text-amber-900">
          Earlier PDF uploads need source review because their file identity was unreliable.
          Re-upload the original PDFs and review or discard the earlier candidates before learning them.
          {quarantined > 0 && (
            <span data-testid="quarantine-note">
              {" "}Progress recorded against {quarantined} of those candidates has been
              cleared, because it may have belonged to a different document.
            </span>
          )}
        </div>
      )}
      {children}
    </LearnerContext.Provider>
  );
}

export function useLearner(): LearnerContextValue {
  const ctx = useContext(LearnerContext);
  if (!ctx) throw new Error("useLearner must be used inside <LearnerProvider>");
  return ctx;
}
