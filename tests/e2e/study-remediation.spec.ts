import { expect, test, type Page } from "@playwright/test";
import { ANSWERS } from "../answers";
import { MAIN_PENDING_REMEDIATION, MAIN_REMEDIATED } from "../fixtures/main-learner-state";

/**
 * Pending immediate Tutor remediation is explicit state, not a reading of
 * WEAK: a Study failure from before the Tutor covered a concept never turns
 * into a Tutor remediation, while real Tutor failures — including ones saved
 * by main before card study existed — still get one.
 */

const L1 = "lecture-cell-injury";
const LK = "medrecall.learner.v1";
const HYPOXIA = "c-hypoxia";
const REV = "c-reversible-irreversible";

type Stored = {
  tutorRemediationExplicit?: boolean;
  progress: Record<
    string,
    {
      mastery: string;
      immediateRemediationPassed: boolean;
      pendingTutorRemediation?: boolean;
      schedule: { reps: number };
    }
  >;
};
const stored = async (page: Page) =>
  JSON.parse((await page.evaluate((k) => localStorage.getItem(k), LK)) ?? "null") as Stored;

async function answerCorrectly(page: Page, testId: "step-retrieve" | "step-remediate", conceptId: string) {
  await expect(page.getByTestId(testId)).toHaveAttribute("data-concept-id", conceptId);
  await page.getByTestId("answer-input").fill(ANSWERS[conceptId]!);
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("feedback-correct")).toBeVisible();
  await page.getByTestId("continue-button").click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("Astra: Study Again before the Tutor, then a correct Tutor answer → the Tutor moves on, no remediation", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("study-card")).toHaveAttribute("data-concept-id", HYPOXIA);
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-again").click();
  await expect(page.getByTestId("count-learning")).toHaveText("1");
  let s = await stored(page);
  expect(s.progress[HYPOXIA]!.mastery).toBe("WEAK");
  expect(s.progress[HYPOXIA]!.schedule.reps).toBe(0);

  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-teach")).toBeVisible();
  await page.getByTestId("teach-continue").click();
  await answerCorrectly(page, "step-retrieve", HYPOXIA);

  // The normal next Tutor step, not a remediation of the Study failure.
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", REV);
  await expect(page.getByTestId("step-remediate")).toHaveCount(0);
  s = await stored(page);
  expect(s.progress[HYPOXIA]!.mastery).toBe("WEAK");
  expect(s.progress[HYPOXIA]!.schedule.reps).toBe(1);
  expect(s.progress[HYPOXIA]!.pendingTutorRemediation).toBe(false);
  expect(s.tutorRemediationExplicit).toBe(true);

  // Reloading does not reinterpret the stored state as a pending remediation.
  await page.reload();
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", REV);
  await expect(page.getByTestId("step-remediate")).toHaveCount(0);
});

test("Study Again after the Tutor has covered a concept → the Tutor remediates it next", async ({ page }) => {
  await page.goto(`/learn/${L1}`);
  await page.getByTestId("teach-continue").click();
  await answerCorrectly(page, "step-retrieve", HYPOXIA);
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", REV);

  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("study-card")).toHaveAttribute("data-concept-id", HYPOXIA);
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-again").click();
  await expect(page.getByTestId("count-learning")).toHaveText("1");
  expect((await stored(page)).progress[HYPOXIA]!.pendingTutorRemediation).toBe(true);

  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-remediate")).toHaveAttribute("data-item-id", "c-hypoxia-2");
  await answerCorrectly(page, "step-remediate", HYPOXIA);
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", REV);
  expect((await stored(page)).progress[HYPOXIA]!.pendingTutorRemediation).toBe(false);
});

test("legacy: a pending Tutor failure saved by main (no pendingTutorRemediation field) is still remediated", async ({ page }) => {
  expect("pendingTutorRemediation" in MAIN_PENDING_REMEDIATION.progress[HYPOXIA]).toBe(false);
  await page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [LK, JSON.stringify(MAIN_PENDING_REMEDIATION)]);
  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-remediate")).toHaveAttribute("data-concept-id", HYPOXIA);
  await expect(page.getByTestId("step-remediate")).toHaveAttribute("data-item-id", "c-hypoxia-2");
  await answerCorrectly(page, "step-remediate", HYPOXIA);
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", REV);
  const p = (await stored(page)).progress[HYPOXIA]!;
  expect(p.pendingTutorRemediation).toBe(false);
  expect(p.immediateRemediationPassed).toBe(true);
  expect(p.mastery).toBe("WEAK");
});

test("legacy: a remediation main already passed is not re-opened", async ({ page }) => {
  await page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [LK, JSON.stringify(MAIN_REMEDIATED)]);
  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", REV);
  await expect(page.getByTestId("step-remediate")).toHaveCount(0);
});

test("mixed versions: a Tutor failure saved by a tab still running main, over a stale flag, is still remediated", async ({ page }) => {
  // main keeps records as stored but drops envelope keys it does not know, so
  // its writes carry this build's old flag and never the explicit mark.
  const written = JSON.parse(JSON.stringify(MAIN_PENDING_REMEDIATION));
  written.progress[HYPOXIA].pendingTutorRemediation = false;
  await page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [LK, JSON.stringify(written)]);
  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-remediate")).toHaveAttribute("data-concept-id", HYPOXIA);
});
