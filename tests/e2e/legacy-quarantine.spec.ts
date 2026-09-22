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
