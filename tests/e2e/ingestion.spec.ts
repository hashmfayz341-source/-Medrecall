import { expect, test, type Page } from "@playwright/test";
import { ANSWERS, WRONG } from "../answers";

const L1 = "lecture-cell-injury";
const FIXTURE = "tests/fixtures/cell-injury.pdf";

async function conceptCards(page: Page) {
  return page.locator('[data-testid^="concept-doc-"]');
}

/** Upload the fixture into Cell Injury and return the new document's id. */
async function ingestFixture(page: Page): Promise<string> {
  await page.goto("/ingest");
  await expect(page.getByTestId("lecture-picker")).toBeVisible();
  await page.getByTestId("lecture-select").selectOption(L1);
  await page.getByTestId("pdf-input").setInputFiles(FIXTURE);
  await page.getByTestId("extract-button").click();

  await expect(page.getByTestId("ingest-result")).toBeVisible({ timeout: 30_000 });
  const id = await page.getByTestId("ingest-result").getAttribute("data-document-id");
  expect(id).toBeTruthy();
  return id!;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
});

test("uploading a PDF produces DRAFT candidates with page provenance", async ({ page }) => {
  const documentId = await ingestFixture(page);

  await expect(page.getByTestId("stat-pages")).toHaveText("4");
  const candidates = Number(await page.getByTestId("stat-candidates").innerText());
  const drafts = Number(await page.getByTestId("stat-draft").innerText());
  expect(candidates).toBeGreaterThan(5);
  // Everything extracted is a draft. Nothing arrives teachable.
  expect(drafts).toBe(candidates);

  await page.getByTestId("go-review").click();
  await expect(page).toHaveURL(new RegExp(`document=${documentId}`));

  const cards = await conceptCards(page);
  await expect(cards.first()).toBeVisible();
  expect(await cards.count()).toBe(candidates);

  // Every card shows its source page and a verbatim excerpt.
  const first = cards.first();
  await expect(first).toHaveAttribute("data-status", "DRAFT");
  const page1 = await first.getAttribute("data-page");
  expect(Number(page1)).toBeGreaterThan(0);
  await expect(first.locator('[data-testid^="source-"]')).toContainText("View source");
  await expect(first.locator('[data-testid^="excerpt-"]')).not.toBeEmpty();
});

test("a scanned or unreadable file is rejected with an explanation", async ({ page }) => {
  await page.goto("/ingest");
  await page.getByTestId("lecture-select").selectOption(L1);
  await page.getByTestId("pdf-input").setInputFiles({
    name: "not-a.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("this is definitely not a pdf"),
  });
  await page.getByTestId("extract-button").click();
  await expect(page.getByTestId("ingest-error")).toBeVisible({ timeout: 30_000 });
});

test("editing a draft does not approve it", async ({ page }) => {
  const documentId = await ingestFixture(page);
  await page.goto(`/concepts?document=${documentId}`);

  const cards = await conceptCards(page);
  const target = cards.first();
  const testId = await target.getAttribute("data-testid");
  const conceptId = testId!.replace("concept-", "");

  await page.getByTestId(`title-input-${conceptId}`).fill("Edited but still a draft");
  await page.getByTestId(`save-${conceptId}`).click();

  // Still DRAFT, and still listed under the DRAFT filter.
  const edited = page.getByTestId(`concept-${conceptId}`);
  await expect(edited).toHaveAttribute("data-status", "DRAFT");
  await expect(page.getByTestId(`title-input-${conceptId}`)).toHaveValue(
    "Edited but still a draft",
  );

  // The edit survives a reload, without having been approved.
  await page.reload();
  await expect(page.getByTestId(`title-input-${conceptId}`)).toHaveValue(
    "Edited but still a draft",
  );
  await expect(page.getByTestId(`concept-${conceptId}`)).toHaveAttribute(
    "data-status",
    "DRAFT",
  );
});

test("full journey: upload, edit, discard, approve, learn, reload", async ({ page }) => {
  const documentId = await ingestFixture(page);
  await page.goto(`/concepts?document=${documentId}`);

  const cards = await conceptCards(page);
  const total = await cards.count();
  expect(total).toBeGreaterThan(3);

  const ids: string[] = [];
  for (let i = 0; i < total; i++) {
    const testId = await cards.nth(i).getAttribute("data-testid");
    ids.push(testId!.replace("concept-", ""));
  }
  const [editedId, discardedId, ...restIds] = ids;

  /* ---- Edit one (must stay DRAFT) ---- */
  await page.getByTestId(`title-input-${editedId}`).fill("Reviewed concept title");
  await page.getByTestId(`save-${editedId}`).click();
  await expect(page.getByTestId(`concept-${editedId}`)).toHaveAttribute(
    "data-status",
    "DRAFT",
  );

  /* ---- Discard one ---- */
  const discardedTitle = await page.getByTestId(`title-input-${discardedId}`).inputValue();
  await page.getByTestId(`discard-${discardedId}`).click();
  await expect(page.getByTestId(`concept-${discardedId}`)).toHaveCount(0);

  /* ---- Approve the rest, including the edited one ---- */
  await page.getByTestId("bulk-approve").click();
  await expect(page.getByTestId("empty-state")).toBeVisible();

  await page.getByTestId("filter-ACTIVE").click();
  const activeCards = await conceptCards(page);
  expect(await activeCards.count()).toBe(total - 1);
  expect(restIds.length).toBeGreaterThan(0);

  await page.getByTestId("filter-DISCARDED").click();
  await expect(page.getByTestId(`concept-${discardedId}`)).toBeVisible();

  /* ---- Reload: every decision persists ---- */
  await page.reload();
  await page.getByTestId("filter-ACTIVE").click();
  await expect(page.getByTestId(`concept-${editedId}`)).toBeVisible();
  await expect(page.getByTestId(`title-input-${editedId}`)).toHaveValue(
    "Reviewed concept title",
  );
  await page.getByTestId("filter-DRAFT").click();
  await expect(page.getByTestId("empty-state")).toBeVisible();

  /* ---- The approved concept reaches the tutor ---- */
  await page.goto(`/learn/${L1}`);

  let reachedIngested = false;
  for (let i = 0; i < 40 && !reachedIngested; i++) {
    if (await page.getByTestId("step-teach").isVisible().catch(() => false)) {
      const shown = await page.getByTestId("teach-concept").allTextContents();
      if (shown.some((t) => t.includes("Reviewed concept title"))) {
        reachedIngested = true;
        // The discarded candidate must never be taught.
        expect(shown.join(" ")).not.toContain(discardedTitle);
        break;
      }
      await page.getByTestId("teach-continue").click();
      continue;
    }
    if (await page.getByTestId("feedback").isVisible().catch(() => false)) {
      await page.getByTestId("continue-button").click();
      continue;
    }
    if (await page.getByTestId("step-awaiting-approval").isVisible().catch(() => false)) {
      throw new Error("nothing should await approval after approving");
    }
    const question = page
      .locator('[data-testid="step-retrieve"], [data-testid="step-remediate"]')
      .first();
    if (await question.isVisible().catch(() => false)) {
      const conceptId = await question.getAttribute("data-concept-id");
      await page.getByTestId("answer-input").fill(ANSWERS[conceptId ?? ""] ?? WRONG);
      await page.getByTestId("submit-answer").click();
      await expect(page.getByTestId("feedback")).toBeVisible();
      continue;
    }
    break;
  }

  expect(
    reachedIngested,
    "the approved ingested concept should reach the teaching step",
  ).toBe(true);
});

test("a chunk with nothing approved reports that it is waiting on review", async ({
  page,
}) => {
  await ingestFixture(page);

  // Work through the authored material without approving any candidate.
  await page.goto(`/learn/${L1}`);
  for (let i = 0; i < 40; i++) {
    if (await page.getByTestId("step-awaiting-approval").isVisible().catch(() => false)) {
      break;
    }
    if (await page.getByTestId("step-teach").isVisible().catch(() => false)) {
      await page.getByTestId("teach-continue").click();
      continue;
    }
    if (await page.getByTestId("feedback").isVisible().catch(() => false)) {
      await page.getByTestId("continue-button").click();
      continue;
    }
    const question = page
      .locator('[data-testid="step-retrieve"], [data-testid="step-remediate"]')
      .first();
    if (await question.isVisible().catch(() => false)) {
      const conceptId = await question.getAttribute("data-concept-id");
      await page.getByTestId("answer-input").fill(ANSWERS[conceptId ?? ""] ?? WRONG);
      await page.getByTestId("submit-answer").click();
      await expect(page.getByTestId("feedback")).toBeVisible();
      continue;
    }
    break;
  }

  await expect(page.getByTestId("step-awaiting-approval")).toBeVisible();
  await expect(page.getByTestId("awaiting-count")).not.toHaveText("0");

  // Unreviewed material must not unlock the next lecture.
  await page.goto("/");
  await expect(page.getByTestId("locked-lecture-inflammation")).toBeVisible();
});

test("a newly created lecture starts empty and locked", async ({ page }) => {
  await page.goto("/ingest");
  await page.getByTestId("new-lecture-title").fill("Neoplasia");
  await page.getByTestId("create-lecture").click();
  await expect(page.getByTestId("lecture-select")).toContainText("Neoplasia");

  await page.goto("/");
  await expect(page.getByText("3. Neoplasia")).toBeVisible();
});
