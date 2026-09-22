import { expect, test, type Page } from "@playwright/test";

/**
 * A stale second tab must not be able to re-inject learner state recorded
 * against an untrusted legacy document identity.
 */

const CURRICULUM_KEY = "medrecall.curriculum.v1";
const LEARNER_KEY = "medrecall.learner.v1";
const LEGACY_DOC = "doc-lecture-811c9dc5";
const LEGACY_LECTURE = "lecture-legacy";
const LEGACY_CONCEPT = "legacy-c0";

function legacyCurriculum() {
  const sentence = "Hypoxia is the most common cause of cell injury.";
  const concept = {
    id: LEGACY_CONCEPT,
    courseId: "course-pathology",
    lectureId: LEGACY_LECTURE,
    title: "Hypoxia",
    summary: sentence,
    importance: "SUPPORTING",
    status: "DRAFT",
    prerequisiteIds: [],
    source: {
      courseId: "course-pathology",
      lectureId: LEGACY_LECTURE,
      documentId: LEGACY_DOC,
      pageNumber: 1,
      excerpt: sentence,
    },
    retrievalItems: [
      {
        id: `${LEGACY_CONCEPT}-r1`,
        conceptId: LEGACY_CONCEPT,
        kind: "CLOZE",
        prompt: `___ ${sentence}`,
        requiredKeywords: [["hypoxia"]],
        acceptableAnswers: ["Hypoxia"],
        explanation: sentence,
      },
    ],
  };
  const chunk = {
    id: `${LEGACY_DOC}-chunk-1`,
    lectureId: LEGACY_LECTURE,
    order: 1,
    title: "Part 1",
    documentId: LEGACY_DOC,
    pageNumbers: [1],
    conceptIds: [LEGACY_CONCEPT],
    explanation: "From Lecture, page 1.",
  };
  return {
    version: 2,
    statusById: { [LEGACY_CONCEPT]: "ACTIVE" },
    edits: {},
    lectures: [
      {
        id: LEGACY_LECTURE,
        courseId: "course-pathology",
        title: "Legacy lecture",
        order: 0,
        documents: [],
        chunks: [],
      },
    ],
    ingested: [
      {
        lectureId: LEGACY_LECTURE,
        document: {
          id: LEGACY_DOC,
          lectureId: LEGACY_LECTURE,
          title: "Lecture",
          pages: [{ number: 1, title: "Nuclear change", text: sentence }],
        },
        chunks: [chunk],
        ingestedAt: "2026-09-20T10:00:00.000Z",
      },
    ],
    concepts: [concept],
  };
}

/** Learner state as a stale tab would still hold it. */
function legacyLearnerState() {
  const schedule = {
    due: "2026-09-25T10:00:00.000Z",
    stability: 5,
    difficulty: 5,
    elapsed_days: 1,
    scheduled_days: 3,
    learning_steps: 0,
    reps: 6,
    lapses: 0,
    state: 2,
  };
  return {
    version: 1,
    progress: {
      [LEGACY_CONCEPT]: {
        conceptId: LEGACY_CONCEPT,
        mastery: "STRONG",
        consecutiveSpacedSuccesses: 3,
        totalAttempts: 6,
        totalCorrect: 6,
        everWrong: false,
        immediateRemediationPassed: false,
        lastAttemptAt: "2026-09-22T10:00:00.000Z",
        schedule,
      },
    },
    taughtChunkIds: [`${LEGACY_DOC}-chunk-1`],
    completedChunkIds: [`${LEGACY_DOC}-chunk-1`],
    completedLectureIds: [LEGACY_LECTURE],
    injectedByChunk: { [`${LEGACY_DOC}-chunk-1`]: [LEGACY_CONCEPT] },
  };
}

async function storedLearner(page: Page) {
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), LEARNER_KEY);
  return raw ? JSON.parse(raw) : null;
}

test("hydration quarantines legacy learner state", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(
    ([curriculumKey, learnerKey, curriculum, learner]) => {
      window.localStorage.clear();
      window.localStorage.setItem(curriculumKey as string, curriculum as string);
      window.localStorage.setItem(learnerKey as string, learner as string);
    },
    [
      CURRICULUM_KEY,
      LEARNER_KEY,
      JSON.stringify(legacyCurriculum()),
      JSON.stringify(legacyLearnerState()),
    ],
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pathology" })).toBeVisible();

  const after = await storedLearner(page);
  expect(after.progress[LEGACY_CONCEPT]).toBeUndefined();
  expect(after.completedLectureIds).not.toContain(LEGACY_LECTURE);
});

test("a stale tab cannot re-inject legacy progress through a storage event", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(
    ([curriculumKey, learnerKey, curriculum]) => {
      window.localStorage.clear();
      window.localStorage.setItem(curriculumKey as string, curriculum as string);
      window.localStorage.removeItem(learnerKey as string);
    },
    [CURRICULUM_KEY, LEARNER_KEY, JSON.stringify(legacyCurriculum())],
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pathology" })).toBeVisible();

  // The stale tab writes its pre-quarantine state and notifies this one.
  await page.evaluate(
    ([learnerKey, learner]) => {
      window.localStorage.setItem(learnerKey as string, learner as string);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: learnerKey as string,
          newValue: learner as string,
        }),
      );
    },
    [LEARNER_KEY, JSON.stringify(legacyLearnerState())],
  );

  await expect
    .poll(async () => (await storedLearner(page))?.progress?.[LEGACY_CONCEPT])
    .toBeUndefined();

  const after = await storedLearner(page);
  expect(after.taughtChunkIds).not.toContain(`${LEGACY_DOC}-chunk-1`);
  expect(after.completedChunkIds).not.toContain(`${LEGACY_DOC}-chunk-1`);
  expect(after.completedLectureIds).not.toContain(LEGACY_LECTURE);
  expect(after.injectedByChunk[`${LEGACY_DOC}-chunk-1`]).toBeUndefined();
});

test("normal multi-tab sync still works for authored material", async ({ page }) => {
  await page.goto("/");
  await page.evaluate((key) => window.localStorage.clear() ?? key, LEARNER_KEY);
  await page.reload();

  // Approve an authored draft in "another tab", then notify this one.
  await page.evaluate(
    ([curriculumKey]) => {
      const payload = {
        version: 2,
        statusById: { "c-draft-lysosomal": "ACTIVE" },
        edits: {},
        lectures: [],
        ingested: [],
        concepts: [],
      };
      const raw = JSON.stringify(payload);
      window.localStorage.setItem(curriculumKey as string, raw);
      window.dispatchEvent(
        new StorageEvent("storage", { key: curriculumKey as string, newValue: raw }),
      );
    },
    [CURRICULUM_KEY],
  );

  await page.goto("/concepts");
  await page.getByTestId("filter-ACTIVE").click();
  await expect(page.getByTestId("concept-c-draft-lysosomal")).toBeVisible();
});

/** Legacy bookkeeping with NO progress record — the case that was not persisted. */
function legacyStateWithoutProgress() {
  return {
    version: 1,
    progress: {},
    taughtChunkIds: [`${LEGACY_DOC}-chunk-1`],
    completedChunkIds: [`${LEGACY_DOC}-chunk-1`],
    completedLectureIds: [LEGACY_LECTURE],
    injectedByChunk: { [`${LEGACY_DOC}-chunk-1`]: [LEGACY_CONCEPT] },
  };
}

test("legacy chunk/lecture state with no progress is cleaned AND persisted", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(
    ([curriculumKey, learnerKey, curriculum, learner]) => {
      window.localStorage.clear();
      window.localStorage.setItem(curriculumKey as string, curriculum as string);
      window.localStorage.setItem(learnerKey as string, learner as string);
    },
    [
      CURRICULUM_KEY,
      LEARNER_KEY,
      JSON.stringify(legacyCurriculum()),
      JSON.stringify(legacyStateWithoutProgress()),
    ],
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pathology" })).toBeVisible();

  // Cleaned in storage, not merely in memory.
  const after = await storedLearner(page);
  expect(after.taughtChunkIds).not.toContain(`${LEGACY_DOC}-chunk-1`);
  expect(after.completedChunkIds).not.toContain(`${LEGACY_DOC}-chunk-1`);
  expect(after.completedLectureIds).not.toContain(LEGACY_LECTURE);
  expect(after.injectedByChunk[`${LEGACY_DOC}-chunk-1`]).toBeUndefined();

  // A second reload reads the already-clean state and leaves it alone.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pathology" })).toBeVisible();
  expect(await storedLearner(page)).toEqual(after);
});

test("an older curriculum payload is rewritten as the current version", async ({
  page,
}) => {
  await page.goto("/");
  await page.evaluate(
    ([curriculumKey, learnerKey, curriculum]) => {
      window.localStorage.clear();
      // A v2 payload carrying an edit and an approval on a colliding identity.
      const payload = JSON.parse(curriculum as string);
      payload.edits = { "legacy-c0": { title: "EDIT FROM PDF A" } };
      window.localStorage.setItem(curriculumKey as string, JSON.stringify(payload));
      window.localStorage.removeItem(learnerKey as string);
    },
    [CURRICULUM_KEY, LEARNER_KEY, JSON.stringify(legacyCurriculum())],
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pathology" })).toBeVisible();

  const raw = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    CURRICULUM_KEY,
  );
  expect(raw).not.toBeNull();
  const onDisk = JSON.parse(raw!);
  expect(onDisk.version).toBe(4);
  expect(onDisk.statusById[LEGACY_CONCEPT]).toBe("DRAFT");
  expect(onDisk.edits[LEGACY_CONCEPT]).toBeUndefined();
  expect(raw).not.toContain("EDIT FROM PDF A");
});

/** Curriculum with no ingested material at all — nothing is untrusted yet. */
function cleanCurriculum() {
  return {
    version: 4,
    statusById: {},
    edits: {},
    lectures: [],
    ingested: [],
    concepts: [],
  };
}

/** Learner state mixing legacy material with authored Milestone 1 progress. */
function mixedLearnerState() {
  const schedule = {
    due: "2026-09-25T10:00:00.000Z",
    stability: 5,
    difficulty: 5,
    elapsed_days: 1,
    scheduled_days: 3,
    learning_steps: 0,
    reps: 6,
    lapses: 0,
    state: 2,
  };
  const record = (conceptId: string, mastery: string) => ({
    conceptId,
    mastery,
    consecutiveSpacedSuccesses: 3,
    totalAttempts: 6,
    totalCorrect: 6,
    everWrong: false,
    immediateRemediationPassed: false,
    lastAttemptAt: "2026-09-22T10:00:00.000Z",
    schedule,
  });
  return {
    version: 1,
    progress: {
      [LEGACY_CONCEPT]: record(LEGACY_CONCEPT, "STRONG"),
      "c-hypoxia": record("c-hypoxia", "STABLE"),
    },
    taughtChunkIds: [`${LEGACY_DOC}-chunk-1`, "chunk-ci-1"],
    completedChunkIds: [`${LEGACY_DOC}-chunk-1`, "chunk-ci-1"],
    completedLectureIds: [LEGACY_LECTURE],
    injectedByChunk: {
      [`${LEGACY_DOC}-chunk-1`]: [LEGACY_CONCEPT],
      "chunk-inf-1": ["c-hypoxia"],
    },
  };
}

/** Seed clean curriculum + unsafe learner state, then load the page. */
async function seedCleanCurriculumWithLegacyLearner(page: Page) {
  await page.goto("/");
  await page.evaluate(
    ([curriculumKey, learnerKey, curriculum, learner]) => {
      window.localStorage.clear();
      window.localStorage.setItem(curriculumKey as string, curriculum as string);
      window.localStorage.setItem(learnerKey as string, learner as string);
    },
    [
      CURRICULUM_KEY,
      LEARNER_KEY,
      JSON.stringify(cleanCurriculum()),
      JSON.stringify(mixedLearnerState()),
    ],
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pathology" })).toBeVisible();

  // Nothing is untrusted yet, so the legacy records legitimately survive.
  const before = await storedLearner(page);
  expect(before.progress[LEGACY_CONCEPT]).toBeDefined();
}

/** Write legacy curriculum from "another tab" and fire ONLY that event. */
async function dispatchCurriculumEvent(page: Page, payload: unknown) {
  await page.evaluate(
    ([curriculumKey, curriculum]) => {
      window.localStorage.setItem(curriculumKey as string, curriculum as string);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: curriculumKey as string,
          newValue: curriculum as string,
        }),
      );
    },
    [CURRICULUM_KEY, JSON.stringify(payload)],
  );
}

async function expectQuarantined(page: Page) {
  await expect
    .poll(async () => (await storedLearner(page))?.progress?.[LEGACY_CONCEPT])
    .toBeUndefined();

  const after = await storedLearner(page);
  expect(after.taughtChunkIds).not.toContain(`${LEGACY_DOC}-chunk-1`);
  expect(after.completedChunkIds).not.toContain(`${LEGACY_DOC}-chunk-1`);
  expect(after.completedLectureIds).not.toContain(LEGACY_LECTURE);
  expect(after.injectedByChunk[`${LEGACY_DOC}-chunk-1`]).toBeUndefined();

  // Authored Milestone 1 progress is untouched.
  expect(after.progress["c-hypoxia"]?.mastery).toBe("STABLE");
  expect(after.taughtChunkIds).toContain("chunk-ci-1");
  expect(after.completedChunkIds).toContain("chunk-ci-1");
  expect(after.injectedByChunk["chunk-inf-1"]).toEqual(["c-hypoxia"]);
  return after;
}

test("a curriculum-only event re-quarantines the loaded learner state", async ({
  page,
}) => {
  await seedCleanCurriculumWithLegacyLearner(page);

  // Only the curriculum changes. No learner storage event is fired, and the
  // page is never reloaded — the unsafe state must not stay live until then.
  await dispatchCurriculumEvent(page, legacyCurriculum());

  await expectQuarantined(page);
});

test("curriculum-event quarantine is idempotent", async ({ page }) => {
  await seedCleanCurriculumWithLegacyLearner(page);
  await dispatchCurriculumEvent(page, legacyCurriculum());
  const first = await expectQuarantined(page);

  await dispatchCurriculumEvent(page, legacyCurriculum());
  await page.waitForTimeout(150);
  expect(await storedLearner(page)).toEqual(first);
});

test("either event order ends in a safe state: learner first, curriculum second", async ({
  page,
}) => {
  await seedCleanCurriculumWithLegacyLearner(page);

  // The learner event arrives while the curriculum still looks clean, so it
  // cannot quarantine anything yet.
  await page.evaluate(
    ([learnerKey, learner]) => {
      window.localStorage.setItem(learnerKey as string, learner as string);
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: learnerKey as string,
          newValue: learner as string,
        }),
      );
    },
    [LEARNER_KEY, JSON.stringify(mixedLearnerState())],
  );
  await page.waitForTimeout(100);
  expect((await storedLearner(page)).progress[LEGACY_CONCEPT]).toBeDefined();

  // The curriculum event then reveals the identity as untrusted.
  await dispatchCurriculumEvent(page, legacyCurriculum());
  await expectQuarantined(page);
});
