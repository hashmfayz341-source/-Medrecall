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
  setConceptStatus,
  setConceptStatuses,
  type ConceptEdit,
  type CurriculumOverrides,
  type IngestedDocument,
} from "@/lib/domain/curriculum";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { createLearnerState } from "@/lib/engine/tutor";
import { LocalStorageLearnerRepository } from "@/lib/persistence/localStorage";
import { LocalStorageCurriculumRepository } from "@/lib/persistence/curriculumStore";
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

  const learnerRepo = useRef(new LocalStorageLearnerRepository());
  const curriculumRepo = useRef(new LocalStorageCurriculumRepository());

  // Hydrate from storage after mount so server and client markup agree.
  useEffect(() => {
    const storedLearner = learnerRepo.current.load();
    if (storedLearner) setLearnerState(storedLearner);
    const storedOverrides = curriculumRepo.current.load();
    if (storedOverrides) setOverrides(storedOverrides);
    setReady(true);
  }, []);

  const setLearner = useCallback((next: LearnerState) => {
    setLearnerState(next);
    learnerRepo.current.save(next);
  }, []);

  /** Apply a change to curriculum state and persist it in one step. */
  const mutate = useCallback(
    (fn: (current: CurriculumOverrides) => CurriculumOverrides) => {
      setOverrides((current) => {
        const next = fn(current);
        curriculumRepo.current.save(next);
        return next;
      });
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
    learnerRepo.current.clear();
    curriculumRepo.current.clear();
    setLearnerState(fresh);
    setOverrides(createOverrides());
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
      updateConceptStatus,
      updateConceptStatuses,
      updateConceptText,
      createLecture,
      storeIngestedDocument,
      resetAll,
    ],
  );

  return (
    <LearnerContext.Provider value={value}>{children}</LearnerContext.Provider>
  );
}

export function useLearner(): LearnerContextValue {
  const ctx = useContext(LearnerContext);
  if (!ctx) throw new Error("useLearner must be used inside <LearnerProvider>");
  return ctx;
}
