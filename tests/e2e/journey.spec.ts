import { expect, test, type Page } from "@playwright/test";
import { ANSWERS, CORRECT_ATP, WRONG } from "../answers";

const ATP = "c-atp-depletion";
const L1 = "lecture-cell-injury";
const L2 = "lecture-inflammation";

/** Which step the session is currently showing. */
async function currentStep(page: Page) {
  for (const kind of [
    "step-teach",
    "step-retrieve",
    "step-remediate",
    "step-interleave",
    "step-complete",
  ] as const) {
    if (await page.getByTestId(kind).isVisible().catch(() => false)) return kind;
  }
  if (await page.getByTestId("feedback").isVisible().catch(() => false)) {
    return "feedback" as const;
  }
  return null;
}

async function conceptUnderTest(page: Page, testId: string) {
  return page.getByTestId(testId).getAttribute("data-concept-id");
}

interface DriveOptions {
  /** Answer this concept incorrectly the first time it is asked unaided. */
  failOnce?: string;
  maxSteps?: number;
}

/**
 * Drive the real UI the way a student would: read the step, act, repeat.
 * Returns a transcript of what happened for assertions.
 */
async function drive(page: Page, opts: DriveOptions = {}) {
  const transcript: string[] = [];
  const failed = new Set<string>();
  const max = opts.maxSteps ?? 40;

  for (let i = 0; i < max; i++) {
    const step = await currentStep(page);

    if (step === "step-complete") {
      transcript.push("COMPLETE");
      return transcript;
    }

    if (step === "feedback") {
      transcript.push("FEEDBACK");
      await page.getByTestId("continue-button").click();
      continue;
    }

    if (step === "step-teach") {
      transcript.push("TEACH");
      await page.getByTestId("teach-continue").click();
      continue;
    }

    if (step === "step-retrieve" || step === "step-remediate" || step === "step-interleave") {
      const conceptId = (await conceptUnderTest(page, step))!;
      const shouldFail =
        step === "step-retrieve" &&
        opts.failOnce === conceptId &&
        !failed.has(conceptId);

      if (shouldFail) failed.add(conceptId);

      const answer = shouldFail ? WRONG : (ANSWERS[conceptId] ?? WRONG);
      transcript.push(`${step}:${conceptId}:${shouldFail ? "wrong" : "right"}`);

      await page.getByTestId("answer-input").fill(answer);
      await page.getByTestId("submit-answer").click();
      await expect(page.getByTestId("feedback")).toBeVisible();
      continue;
    }

    throw new Error(`Unrecognised step at iteration ${i}`);
  }

  throw new Error(`drive() exceeded ${max} steps: ${transcript.join(" | ")}`);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
});

test("dashboard shows the Pathology course with Lecture 2 locked", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Pathology" })).toBeVisible();
  await expect(page.getByTestId(`start-${L1}`)).toBeVisible();
  await expect(page.getByTestId(`locked-${L2}`)).toBeVisible();
});

test("draft concepts are visible for review but never taught", async ({ page }) => {
  await page.getByTestId("review-drafts-link").click();
  await expect(page.getByTestId("concept-c-draft-lysosomal")).toBeVisible();

  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-teach")).toBeVisible();
  const taught = await page.getByTestId("teach-concept").allTextContents();
  expect(taught.join(" ")).not.toContain("Lysosomal");
});

test("the full demo journey: fail, remediate, stay weak, interleave, recover", async ({
  page,
}) => {
  /* ---- Lecture 1, failing ATP depletion once ---- */
  await page.getByTestId(`start-${L1}`).click();
  await expect(page.getByTestId("step-teach")).toBeVisible();

  const transcript = await drive(page, { failOnce: ATP });

  // The wrong answer was recorded and re-taught.
  expect(transcript).toContain(`step-retrieve:${ATP}:wrong`);
  expect(transcript.some((t) => t.startsWith(`step-remediate:${ATP}`))).toBe(true);
  expect(transcript).toContain("COMPLETE");

  /* ---- Back on the dashboard, ATP is WEAK and Lecture 2 is unlocked ---- */
  await page.goto("/");
  await expect(page.getByTestId(`complete-${L1}`)).toBeVisible();
  await expect(page.getByTestId(`weak-${ATP}`)).toBeVisible();
  await expect(page.getByTestId(`start-${L2}`)).toBeVisible();
  await expect(page.getByTestId(`locked-${L2}`)).toHaveCount(0);

  /* ---- Reload: progress is retained ---- */
  await page.reload();
  await expect(page.getByTestId(`complete-${L1}`)).toBeVisible();
  await expect(page.getByTestId(`weak-${ATP}`)).toBeVisible();

  /* ---- Lecture 2 opens by interleaving the weak Lecture 1 concept ---- */
  await page.getByTestId(`start-${L2}`).click();
  await expect(page.getByTestId("step-interleave")).toBeVisible();
  await expect(page.getByTestId("interleave-banner")).toContainText("Cell Injury");
  expect(await conceptUnderTest(page, "step-interleave")).toBe(ATP);

  /* ---- Answering it correctly now finally improves mastery ---- */
  await page.getByTestId("answer-input").fill(CORRECT_ATP);
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("feedback-correct")).toBeVisible();
  await expect(page.getByTestId("feedback")).toHaveAttribute("data-mastery", "LEARNING");
  await expect(page.getByTestId("weakness-note")).toHaveCount(0);

  await page.getByTestId("continue-button").click();
  await expect(page.getByTestId("step-teach")).toBeVisible();

  /* ---- Reload again: the recovery is retained ---- */
  await page.goto("/");
  await page.reload();
  await expect(page.getByTestId(`weak-${ATP}`)).toHaveCount(0);
  await expect(page.getByTestId(`complete-${L1}`)).toBeVisible();
});

test("immediate remediation success does NOT clear the weakness", async ({ page }) => {
  await page.goto(`/learn/${L1}`);

  // Walk to the ATP chunk, answering everything else correctly.
  for (let i = 0; i < 30; i++) {
    const step = await currentStep(page);
    if (step === "step-teach") {
      await page.getByTestId("teach-continue").click();
      continue;
    }
    if (step === "feedback") {
      await page.getByTestId("continue-button").click();
      continue;
    }
    if (step === "step-retrieve") {
      const conceptId = (await conceptUnderTest(page, "step-retrieve"))!;
      if (conceptId === ATP) break;
      await page.getByTestId("answer-input").fill(ANSWERS[conceptId] ?? WRONG);
      await page.getByTestId("submit-answer").click();
      await expect(page.getByTestId("feedback")).toBeVisible();
      continue;
    }
    throw new Error(`Unexpected step ${step} while walking to ATP`);
  }

  // Fail it deliberately.
  await expect(page.getByTestId("step-retrieve")).toBeVisible();
  expect(await conceptUnderTest(page, "step-retrieve")).toBe(ATP);
  await page.getByTestId("answer-input").fill(WRONG);
  await page.getByTestId("submit-answer").click();

  await expect(page.getByTestId("feedback-incorrect")).toBeVisible();
  await expect(page.getByTestId("remediation")).toBeVisible();
  await expect(page.getByTestId("feedback")).toHaveAttribute("data-mastery", "WEAK");
  await page.getByTestId("continue-button").click();

  // Re-teach, then answer correctly straight away.
  await expect(page.getByTestId("step-remediate")).toBeVisible();
  await expect(page.getByTestId("reteach-panel")).toBeVisible();
  await page.getByTestId("answer-input").fill(CORRECT_ATP);
  await page.getByTestId("submit-answer").click();

  // Correct — but explicitly still WEAK.
  await expect(page.getByTestId("feedback-correct")).toBeVisible();
  await expect(page.getByTestId("weakness-note")).toBeVisible();
  await expect(page.getByTestId("weakness-note")).toContainText("WEAK");
  await expect(page.getByTestId("feedback")).toHaveAttribute("data-mastery", "WEAK");

  // And still listed as weak on the dashboard.
  await page.goto("/");
  await expect(page.getByTestId(`weak-${ATP}`)).toBeVisible();
});

test("a locked lecture cannot be opened by URL", async ({ page }) => {
  await page.goto(`/learn/${L2}`);
  await expect(page.getByRole("heading", { name: "Lecture locked" })).toBeVisible();
});

test("approving a draft concept lets it into teaching", async ({ page }) => {
  await page.getByTestId("review-drafts-link").click();
  await page.getByTestId("approve-c-draft-lysosomal").click();

  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-teach")).toBeVisible();
  const taught = await page.getByTestId("teach-concept").allTextContents();
  expect(taught.join(" ")).toContain("Lysosomal");
});

test("api routes respond", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.ok()).toBe(true);
  expect((await health.json()).status).toBe("ok");

  const curriculum = await request.get("/api/curriculum");
  expect(curriculum.ok()).toBe(true);
  const body = await curriculum.json();
  expect(body.course.title).toBe("Pathology");
  expect(body.conceptCounts.draft).toBeGreaterThan(0);
});

test("no console errors during a teaching session", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.getByTestId(`start-${L1}`).click();
  await expect(page.getByTestId("step-teach")).toBeVisible();
  await page.getByTestId("teach-continue").click();
  await expect(page.getByTestId("step-retrieve")).toBeVisible();

  expect(errors).toEqual([]);
});
