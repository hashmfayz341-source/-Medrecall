import { expect, test, type Page } from "@playwright/test";
import { pathologyCurriculum } from "../../src/lib/content/pathology";
import { CORRECT_ATP, WRONG, ANSWERS } from "../answers";

/**
 * The grading boundary, end to end in the real app.
 *
 *   answer → POST /api/grade (server provider) → feedback → persisted state
 *
 * and the failure path: when grading fails, the learner sees a retryable
 * error and NOTHING about their progress changes.
 */

const L1 = "lecture-cell-injury";
const LK = "medrecall.learner.v1";
const HYPOXIA = pathologyCurriculum.concepts.find((c) => c.id === "c-hypoxia")!;

async function storedLearner(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LK);
}

async function attemptsFor(page: Page, conceptId: string): Promise<number> {
  const raw = await storedLearner(page);
  if (!raw) return 0;
  const learner = JSON.parse(raw) as { progress: Record<string, { totalAttempts: number }> };
  return learner.progress[conceptId]?.totalAttempts ?? 0;
}

/** Open Lecture 1 and read the first chunk, arriving at the first question. */
async function toFirstQuestion(page: Page) {
  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-teach")).toBeVisible();
  await page.getByTestId("teach-continue").click();
  const question = page.getByTestId("step-retrieve");
  await expect(question).toBeVisible();
  const conceptId = (await question.getAttribute("data-concept-id"))!;
  return { conceptId, answer: ANSWERS[conceptId]! };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("answer → server grade → feedback → persisted learner transition", async ({ page }) => {
  const { conceptId, answer } = await toFirstQuestion(page);
  expect(conceptId).toBe(HYPOXIA.id);
  expect(await attemptsFor(page, conceptId)).toBe(0);

  await page.getByTestId("answer-input").fill(answer);
  const graded = page.waitForResponse(
    (r) => r.url().endsWith("/api/grade") && r.request().method() === "POST",
  );
  await page.getByTestId("submit-answer").click();
  const response = await graded;

  // The server graded it, with the server-side provider.
  expect(response.status()).toBe(200);
  const body = (await response.json()) as Record<string, unknown>;
  expect(body.provider).toBe("deterministic");
  expect(body.conceptId).toBe(conceptId);
  expect(body.grade).toMatchObject({ outcome: "CORRECT", correct: true });
  expect(body.remediation).toBeNull();

  // What was sent is the narrow grading payload, nothing more.
  const sent = JSON.parse(response.request().postData()!) as Record<string, unknown>;
  expect(Object.keys(sent).sort()).toEqual(["answer", "concept", "item"]);

  await expect(page.getByTestId("feedback-correct")).toBeVisible();
  expect(await attemptsFor(page, conceptId)).toBe(1);

  // Persisted: it survives a reload, and the session has moved on.
  await page.reload();
  expect(await attemptsFor(page, conceptId)).toBe(1);
  await expect(page.getByTestId("step-retrieve")).toBeVisible();
  await expect(page.getByTestId("step-retrieve")).not.toHaveAttribute("data-concept-id", conceptId);
});

test("a wrong answer gets source-grounded remediation from the server", async ({ page }) => {
  const { conceptId } = await toFirstQuestion(page);
  await page.getByTestId("answer-input").fill(WRONG);
  const graded = page.waitForResponse((r) => r.url().endsWith("/api/grade"));
  await page.getByTestId("submit-answer").click();
  expect((await graded).status()).toBe(200);

  await expect(page.getByTestId("feedback-incorrect")).toBeVisible();
  await expect(page.getByTestId("remediation")).toContainText(HYPOXIA.source.excerpt);
  await expect(page.getByTestId("feedback")).toHaveAttribute("data-mastery", "WEAK");
  expect(await attemptsFor(page, conceptId)).toBe(1);

  // The immediate re-teach follows, as before.
  await page.getByTestId("continue-button").click();
  await expect(page.getByTestId("step-remediate")).toBeVisible();
});

test("grading endpoint failure → retry UI → no learner progress mutation", async ({ page }) => {
  const { conceptId, answer } = await toFirstQuestion(page);
  const before = await storedLearner(page);

  let calls = 0;
  await page.route("**/api/grade", async (route) => {
    calls++;
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ code: "GRADING_UNAVAILABLE", error: "x", retryable: true }),
    });
  });

  await page.getByTestId("answer-input").fill(answer);
  await page.getByTestId("submit-answer").click();

  await expect(page.getByTestId("grade-error")).toBeVisible();
  await expect(page.getByTestId("grade-error")).toContainText("progress has not changed");
  await expect(page.getByTestId("grade-retry")).toBeVisible();
  await expect(page.getByTestId("feedback")).toHaveCount(0);
  expect(calls).toBe(1);

  // Not a failed attempt: nothing recorded, nothing persisted, same question.
  expect(await storedLearner(page)).toBe(before);
  expect(await attemptsFor(page, conceptId)).toBe(0);
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", conceptId);
  await expect(page.getByTestId("answer-input")).toHaveValue(answer);

  // A network drop behaves the same.
  await page.unroute("**/api/grade");
  await page.route("**/api/grade", (route) => route.abort("connectionreset"));
  await page.getByTestId("grade-retry").click();
  await expect(page.getByTestId("grade-error")).toBeVisible();
  expect(await storedLearner(page)).toBe(before);

  // The server recovers: retry records exactly one attempt.
  await page.unroute("**/api/grade");
  await page.getByTestId("grade-retry").click();
  await expect(page.getByTestId("feedback-correct")).toBeVisible();
  await expect(page.getByTestId("grade-error")).toHaveCount(0);
  expect(await attemptsFor(page, conceptId)).toBe(1);
});

test("a malformed grading reply is refused with no mutation", async ({ page }) => {
  const { conceptId } = await toFirstQuestion(page);
  const itemId = (await page.getByTestId("step-retrieve").getAttribute("data-item-id"))!;
  const before = await storedLearner(page);

  // Otherwise well-formed and for the right item, but a PARTIAL that claims
  // to be correct: it must never be credited.
  await page.route("**/api/grade", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        provider: "deterministic",
        conceptId,
        itemId,
        grade: { outcome: "PARTIAL", correct: true, matched: [], missing: [], normalizedAnswer: "x" },
        remediation: null,
      }),
    }),
  );
  await page.getByTestId("answer-input").fill(CORRECT_ATP);
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("grade-error")).toBeVisible();
  await expect(page.getByTestId("feedback")).toHaveCount(0);
  expect(await storedLearner(page)).toBe(before);
});

test("a double submit records exactly one attempt", async ({ page }) => {
  const { conceptId, answer } = await toFirstQuestion(page);

  let calls = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/grade", async (route) => {
    calls++;
    await held;
    await route.continue();
  });

  await page.getByTestId("answer-input").fill(answer);
  const submit = page.getByTestId("submit-answer");
  // Two clicks in the same task, before React can re-render the button as
  // disabled — the case only the in-flight guard can stop.
  await page.evaluate(() => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="submit-answer"]')!;
    button.click();
    button.click();
  });
  await expect(submit).toBeDisabled();
  // And a later forced click while the first is still in flight.
  await submit.dispatchEvent("click");
  release();

  await expect(page.getByTestId("feedback-correct")).toBeVisible();
  expect(calls).toBe(1);
  expect(await attemptsFor(page, conceptId)).toBe(1);
});

test("cross-tab: a grade pending in one tab is not applied after another tab answered the same question", async ({
  page,
}) => {
  const { conceptId, answer } = await toFirstQuestion(page);
  const other = await page.context().newPage();
  await other.goto(`/learn/${L1}`);
  await expect(other.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", conceptId);

  // Tab A submits, and its grade is held in flight.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let heldRequests = 0;
  await page.route("**/api/grade", async (route) => {
    heldRequests++;
    await held;
    await route.continue();
  });
  await page.getByTestId("answer-input").fill(answer);
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("submit-answer")).toBeDisabled();

  // Tab B answers the same question and finishes first.
  await other.getByTestId("answer-input").fill(answer);
  await other.getByTestId("submit-answer").click();
  await expect(other.getByTestId("feedback-correct")).toBeVisible();
  expect(await attemptsFor(page, conceptId)).toBe(1);
  const afterB = await storedLearner(page);

  // Tab A's old grade arrives. It must not be applied a second time.
  release();
  await expect(page.getByTestId("grade-stale")).toBeVisible();
  await expect(page.getByTestId("feedback")).toHaveCount(0);
  expect(heldRequests).toBe(1);
  expect(await attemptsFor(page, conceptId)).toBe(1);
  expect(await storedLearner(page)).toBe(afterB);

  // Continuing takes tab A to the current question, not the answered one.
  await page.getByTestId("grade-stale-continue").click();
  await expect(page.getByTestId("grade-stale")).toHaveCount(0);
  await expect(page.getByTestId("step-retrieve")).not.toHaveAttribute("data-concept-id", conceptId);
  await other.close();
});
