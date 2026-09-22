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
  applyOverrides,
  createOverrides,
  setConceptStatus,
  type CurriculumOverrides,
} from "@/lib/domain/curriculum";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { createLearnerState } from "@/lib/engine/tutor";
import {
  LocalStorageLearnerRepository,
} from "@/lib/persistence/localStorage";
import { LocalStorageCurriculumRepository } from "@/lib/persistence/curriculumStore";
import type {
  ConceptStatus,
  Curriculum,
  LearnerState,
} from "@/lib/domain/types";

interface LearnerContextValue {
  /** Curriculum with approval-status overrides applied. */
  curriculum: Curriculum;
  learner: LearnerState;
  /** False until localStorage has been read on the client. */
  ready: boolean;
  setLearner: (next: LearnerState) => void;
  updateConceptStatus: (conceptId: string, status: ConceptStatus) => void;
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

  const updateConceptStatus = useCallback(
    (conceptId: string, status: ConceptStatus) => {
      setOverrides((current) => {
        const next = setConceptStatus(current, conceptId, status);
        curriculumRepo.current.save(next);
        return next;
      });
    },
    [],
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
    () => ({ curriculum, learner, ready, setLearner, updateConceptStatus, resetAll }),
    [curriculum, learner, ready, setLearner, updateConceptStatus, resetAll],
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
