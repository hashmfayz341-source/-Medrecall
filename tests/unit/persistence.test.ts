import { beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryLearnerRepository,
  LocalStorageLearnerRepository,
  STORAGE_KEY,
  loadOrCreate,
} from "@/lib/persistence/localStorage";
import {
  InMemoryCurriculumRepository,
  LocalStorageCurriculumRepository,
  loadOrCreateOverrides,
} from "@/lib/persistence/curriculumStore";
import { applyOverrides, setConceptStatus } from "@/lib/domain/curriculum";
import { DEMO_LECTURE_1, pathologyCurriculum } from "@/lib/content/pathology";
import { createLearnerState, getNextStep } from "@/lib/engine/tutor";
import { T0 } from "./helpers";
import { driveLecture } from "./driver";

/** Minimal localStorage stand-in, so the browser repo is genuinely exercised. */
function installFakeStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  (globalThis as { window?: unknown }).window = { localStorage };
  return store;
}

describe("learner state persistence", () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installFakeStorage();
  });

  it("round-trips learner state through storage", () => {
    const repo = new LocalStorageLearnerRepository();
    const { learner } = driveLecture(createLearnerState(), DEMO_LECTURE_1, T0);
    repo.save(learner);

    const reloaded = new LocalStorageLearnerRepository().load();
    expect(reloaded).toEqual(learner);
  });

  it("progress survives a simulated browser reload mid-lecture", () => {
    const repo = new LocalStorageLearnerRepository();
    const { learner } = driveLecture(createLearnerState(), DEMO_LECTURE_1, T0);
    repo.save(learner);

    // "Reload": brand new repository instance reading the same storage.
    const afterReload = loadOrCreate(new LocalStorageLearnerRepository());
    expect(afterReload.completedLectureIds).toContain(DEMO_LECTURE_1);
    expect(Object.keys(afterReload.progress).length).toBeGreaterThan(0);

    // The engine resumes at exactly the same point.
    const before = getNextStep(pathologyCurriculum, learner, DEMO_LECTURE_1, T0);
    const after = getNextStep(pathologyCurriculum, afterReload, DEMO_LECTURE_1, T0);
    expect(after.kind).toBe(before.kind);
  });

  it("FSRS schedule survives serialization as ISO strings", () => {
    const repo = new LocalStorageLearnerRepository();
    const { learner } = driveLecture(createLearnerState(), DEMO_LECTURE_1, T0);
    repo.save(learner);
    const reloaded = repo.load()!;
    const schedule = reloaded.progress["c-hypoxia"]!.schedule;
    expect(typeof schedule.due).toBe("string");
    expect(Number.isNaN(new Date(schedule.due).getTime())).toBe(false);
    expect(schedule.reps).toBeGreaterThan(0);
  });

  it("returns null for absent state rather than throwing", () => {
    expect(new LocalStorageLearnerRepository().load()).toBeNull();
    expect(loadOrCreate(new LocalStorageLearnerRepository()).progress).toEqual({});
  });

  it("rejects corrupt JSON instead of crashing the app", () => {
    store.set(STORAGE_KEY, "{not json");
    expect(new LocalStorageLearnerRepository().load()).toBeNull();
  });

  it("rejects structurally invalid state", () => {
    store.set(STORAGE_KEY, JSON.stringify({ version: 1, progress: "nope" }));
    expect(new LocalStorageLearnerRepository().load()).toBeNull();
  });

  it("rejects state written by a future version", () => {
    store.set(STORAGE_KEY, JSON.stringify({ ...createLearnerState(), version: 99 }));
    expect(new LocalStorageLearnerRepository().load()).toBeNull();
  });

  it("clear() wipes stored progress", () => {
    const repo = new LocalStorageLearnerRepository();
    repo.save(createLearnerState());
    repo.clear();
    expect(repo.load()).toBeNull();
  });

  it("the in-memory repository satisfies the same contract", () => {
    const repo = new InMemoryLearnerRepository();
    expect(repo.load()).toBeNull();
    const state = createLearnerState();
    repo.save(state);
    expect(repo.load()).toEqual(state);
    repo.clear();
    expect(repo.load()).toBeNull();
  });
});

describe("curriculum state is stored separately from learner state", () => {
  beforeEach(() => {
    installFakeStorage();
  });

  it("approving a concept persists independently of learner progress", () => {
    const learnerRepo = new LocalStorageLearnerRepository();
    const curriculumRepo = new LocalStorageCurriculumRepository();

    let overrides = loadOrCreateOverrides(curriculumRepo);
    overrides = setConceptStatus(overrides, "c-draft-lysosomal", "ACTIVE");
    curriculumRepo.save(overrides);

    const reloaded = new LocalStorageCurriculumRepository().load()!;
    const curriculum = applyOverrides(pathologyCurriculum, reloaded);
    expect(
      curriculum.concepts.find((c) => c.id === "c-draft-lysosomal")?.status,
    ).toBe("ACTIVE");

    // Clearing learner progress must not un-approve the concept.
    learnerRepo.clear();
    expect(new LocalStorageCurriculumRepository().load()).not.toBeNull();
  });

  it("the base curriculum is never mutated by overrides", () => {
    const overrides = setConceptStatus(
      loadOrCreateOverrides(new InMemoryCurriculumRepository()),
      "c-draft-lysosomal",
      "ACTIVE",
    );
    applyOverrides(pathologyCurriculum, overrides);
    expect(
      pathologyCurriculum.concepts.find((c) => c.id === "c-draft-lysosomal")?.status,
    ).toBe("DRAFT");
  });

  it("discarding a concept persists too", () => {
    const repo = new InMemoryCurriculumRepository();
    const overrides = setConceptStatus(
      loadOrCreateOverrides(repo),
      "c-chemotaxis",
      "DISCARDED",
    );
    repo.save(overrides);
    const curriculum = applyOverrides(pathologyCurriculum, repo.load());
    expect(curriculum.concepts.find((c) => c.id === "c-chemotaxis")?.status).toBe(
      "DISCARDED",
    );
  });
});
