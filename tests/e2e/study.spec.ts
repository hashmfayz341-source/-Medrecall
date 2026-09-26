import { expect, test, type Page } from "@playwright/test";
import { makePdf } from "../fixtures/make-pdf";

/**
 * Anki-style study: front → Show Answer → back → Again/Hard/Good/Easy → next.
 */

const L1 = "lecture-cell-injury";
const LK = "medrecall.learner.v1";

type Stored = {
  progress: Record<string, { totalAttempts: number; mastery: string }>;
  cards?: Record<string, { reviews: number; lastRating: string; conceptId: string }>;
};
const stored = async (page: Page) =>
  JSON.parse((await page.evaluate((k) => localStorage.getItem(k), LK)) ?? "null") as Stored | null;
const rawStored = (page: Page) => page.evaluate((k) => localStorage.getItem(k), LK);
const count = async (page: Page, kind: "new" | "learning" | "review") =>
  Number(await page.getByTestId(`count-${kind}`).textContent());

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("dashboard → Study: front only, Show Answer, back + four ratings, rate, next card, persists", async ({ page }) => {
  await page.getByTestId(`study-${L1}`).click();
  await expect(page).toHaveURL(new RegExp(`/study/${L1}$`));

  const card = page.getByTestId("study-card");
  await expect(card).toBeVisible();
  const firstItem = (await card.getAttribute("data-item-id"))!;
  const newBefore = await count(page, "new");
  expect(newBefore).toBeGreaterThan(1);

  // Front only: no answer, no source, no ratings.
  await expect(page.getByTestId("card-front")).toBeVisible();
  await expect(page.getByTestId("card-back")).toHaveCount(0);
  await expect(page.getByTestId("card-source")).toHaveCount(0);
  await expect(page.getByTestId("rating-buttons")).toHaveCount(0);
  await expect(page.getByTestId("show-answer")).toBeVisible();

  // Show Answer mutates nothing.
  const beforeReveal = await rawStored(page);
  await page.getByTestId("show-answer").click();
  expect(await rawStored(page)).toBe(beforeReveal);

  await expect(page.getByTestId("card-back")).toBeVisible();
  await expect(page.getByTestId("card-source")).toContainText("page");
  for (const r of ["again", "hard", "good", "easy"]) {
    await expect(page.getByTestId(`rate-${r}`)).toBeVisible();
  }
  await expect(page.getByTestId("show-answer")).toHaveCount(0);
  // The excerpt is behind "View source".
  await expect(page.getByTestId("source-excerpt")).toBeHidden();
  await page.getByTestId("view-source").click();
  await expect(page.getByTestId("source-excerpt")).toBeVisible();

  await page.getByTestId("rate-good").click();

  // Next card, answer hidden again.
  await expect(card).not.toHaveAttribute("data-item-id", firstItem);
  await expect(page.getByTestId("card-back")).toHaveCount(0);
  expect(await count(page, "new")).toBe(newBefore - 1);
  const s = (await stored(page))!;
  expect(s.cards?.[firstItem]?.reviews).toBe(1);
  expect(s.cards?.[firstItem]?.lastRating).toBe("GOOD");

  // Persists across reload.
  await page.reload();
  await expect(page.getByTestId("study-card")).toBeVisible();
  expect((await stored(page))!.cards?.[firstItem]?.reviews).toBe(1);
  expect(await count(page, "new")).toBe(newBefore - 1);
  await expect(page.getByTestId("study-card")).not.toHaveAttribute("data-item-id", firstItem);
});

test("Again puts the card into Learning and marks the concept WEAK", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  const card = page.getByTestId("study-card");
  const item = (await card.getAttribute("data-item-id"))!;
  const concept = (await card.getAttribute("data-concept-id"))!;
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-again").click();
  await expect(page.getByTestId("count-learning")).toHaveText("1");
  const s = (await stored(page))!;
  expect(s.cards?.[item]?.lastRating).toBe("AGAIN");
  expect(s.progress[concept]?.mastery).toBe("WEAK");
});

test("keyboard: Space reveals, 4 rates Easy", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  const item = (await page.getByTestId("study-card").getAttribute("data-item-id"))!;
  await page.keyboard.press("Space");
  await expect(page.getByTestId("card-back")).toBeVisible();
  await page.keyboard.press("4");
  await expect(page.getByTestId("study-card")).not.toHaveAttribute("data-item-id", item);
  expect((await stored(page))!.cards?.[item]?.lastRating).toBe("EASY");
});

test("a double tap on a rating records exactly one review (the buttons are gone after the first)", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  const item = (await page.getByTestId("study-card").getAttribute("data-item-id"))!;
  await page.getByTestId("show-answer").click();
  await page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>('[data-testid="rate-good"]')!;
    b.click();
    b.click();
  });
  await expect(page.getByTestId("study-card")).not.toHaveAttribute("data-item-id", item);
  const s = (await stored(page))!;
  expect(s.cards?.[item]?.reviews).toBe(1);
  expect(Object.values(s.cards ?? {}).reduce((n, c) => n + c.reviews, 0)).toBe(1);
});

test("cross-tab: a card revealed here but rated in another tab first is not recorded twice", async ({ page, context }) => {
  await page.goto(`/study/${L1}`);
  const item = (await page.getByTestId("study-card").getAttribute("data-item-id"))!;
  await page.getByTestId("show-answer").click();

  // Another tab rates the same card while this one is showing its answer.
  const other = await context.newPage();
  await other.goto(`/study/${L1}`);
  await expect(other.getByTestId("study-card")).toHaveAttribute("data-item-id", item);
  await other.getByTestId("show-answer").click();
  await other.getByTestId("rate-hard").click();
  await expect(other.getByTestId("study-card")).not.toHaveAttribute("data-item-id", item);
  const afterOther = await rawStored(page);

  // This tab's rating is refused, not stacked on top.
  await page.getByTestId("rate-easy").click();
  await expect(page.getByTestId("study-notice")).toContainText("already reviewed");
  expect(await rawStored(page)).toBe(afterOther);
  const s = (await stored(page))!;
  expect(s.cards?.[item]?.reviews).toBe(1);
  expect(s.cards?.[item]?.lastRating).toBe("HARD");
  await other.close();
});

test("authored DRAFT concepts never appear in Study", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    if (await page.getByTestId("study-done").isVisible().catch(() => false)) break;
    const card = page.getByTestId("study-card");
    await expect(card).toBeVisible();
    seen.add((await card.getAttribute("data-concept-id"))!);
    await page.getByTestId("show-answer").click();
    await page.getByTestId("rate-easy").click();
  }
  await expect(page.getByTestId("study-done")).toBeVisible();
  expect(seen.size).toBeGreaterThan(0);
  expect([...seen].some((id) => id.startsWith("c-draft"))).toBe(false);
  expect(await page.getByText("DRAFT").count()).toBe(0);
});

test("uploaded DRAFT candidates are not studyable until approved", async ({ page }) => {
  const pdf = Buffer.from(makePdf([["Study gate", "Hypoxia is the approved study statement.", "Necrosis is the unapproved study statement."]]));
  await page.goto("/ingest");
  await page.getByTestId("lecture-select").selectOption(L1);
  await page.getByTestId("pdf-input").setInputFiles({ name: "study-gate.pdf", mimeType: "application/pdf", buffer: pdf });
  await page.getByTestId("extract-button").click();
  await expect(page.getByTestId("ingest-result")).toBeVisible();
  const doc = (await page.getByTestId("ingest-result").getAttribute("data-document-id"))!;

  // Nothing approved yet: walk the whole queue; no card from this document.
  await page.goto(`/study/${L1}`);
  for (let i = 0; i < 60; i++) {
    if (await page.getByTestId("study-done").isVisible().catch(() => false)) break;
    expect(await page.getByTestId("study-card").getAttribute("data-concept-id")).not.toContain(doc);
    await page.getByTestId("show-answer").click();
    await page.getByTestId("rate-easy").click();
  }
  await expect(page.getByTestId("study-done")).toBeVisible();

  // Approve one candidate: exactly its cards become new cards.
  const id = `${doc}-p1-c0`;
  await page.goto(`/concepts?document=${doc}`);
  await page.getByTestId(`approve-${id}`).click();
  await page.goto(`/study/${L1}`);
  const card = page.getByTestId("study-card");
  await expect(card).toHaveAttribute("data-concept-id", id);
  await expect(page.getByTestId("card-front")).not.toContainText("unapproved");
});

test("H1: studying a new card (Good) does not put its concept into the tutor's Due recall", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  const concept = (await page.getByTestId("study-card").getAttribute("data-concept-id"))!;
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-good").click();
  await expect(page.getByTestId("study-card")).toBeVisible();
  expect((await stored(page))!.progress[concept]?.totalAttempts).toBe(1);

  await page.goto("/");
  await expect(page.getByTestId("due-recall")).toContainText("Nothing due");
});

async function uploadAndApprove(page: Page, name: string) {
  const pdf = Buffer.from(makePdf([["Edit race", "Hypoxia is the reviewed race statement."]]));
  await page.goto("/ingest");
  await page.getByTestId("lecture-select").selectOption(L1);
  await page.getByTestId("pdf-input").setInputFiles({ name, mimeType: "application/pdf", buffer: pdf });
  await page.getByTestId("extract-button").click();
  await expect(page.getByTestId("ingest-result")).toBeVisible();
  const doc = (await page.getByTestId("ingest-result").getAttribute("data-document-id"))!;
  const id = `${doc}-p1-c0`;
  await page.goto(`/concepts?document=${doc}`);
  await page.getByTestId(`approve-${id}`).click();
  return { doc, id };
}

/** Rate other cards Easy until the given concept's card is showing. */
async function studyUntil(page: Page, conceptId: string) {
  await page.goto(`/study/${L1}`);
  for (let i = 0; i < 40; i++) {
    const card = page.getByTestId("study-card");
    await expect(card).toBeVisible();
    if ((await card.getAttribute("data-concept-id")) === conceptId) return;
    await page.getByTestId("show-answer").click();
    await page.getByTestId("rate-easy").click();
  }
  throw new Error(`never reached ${conceptId}`);
}

test("M1: a card edited in another tab after Show Answer cannot be rated with the old content", async ({ page, context }) => {
  const { doc, id } = await uploadAndApprove(page, "edit-race.pdf");
  await studyUntil(page, id);
  const item = (await page.getByTestId("study-card").getAttribute("data-item-id"))!;
  expect(item).toBe(`${id}-r1`);
  await page.getByTestId("show-answer").click();
  const before = await rawStored(page);

  // Another tab edits the concept; the card keeps its id (${conceptId}-r1).
  const review = await context.newPage();
  await review.goto(`/concepts?document=${doc}`);
  await review.getByTestId("filter-ACTIVE").click();
  await review.getByTestId(`title-input-${id}`).fill("Oxygen deficiency");
  await review.getByTestId(`summary-input-${id}`).fill("Oxygen deficiency is the corrected race statement.");
  await review.getByTestId(`save-${id}`).click();
  await review.close();

  await page.getByTestId("rate-good").click();
  await expect(page.getByTestId("study-notice")).toContainText("changed");
  expect(await rawStored(page)).toBe(before);
  const s = (await stored(page))!;
  expect(s.cards?.[item]).toBeUndefined();
  expect(s.progress[id]).toBeUndefined();
});

test("M1: a card returned to DRAFT in another tab after Show Answer cannot be rated", async ({ page, context }) => {
  const { doc, id } = await uploadAndApprove(page, "draft-race.pdf");
  await studyUntil(page, id);
  await page.getByTestId("show-answer").click();
  const before = await rawStored(page);

  const review = await context.newPage();
  await review.goto(`/concepts?document=${doc}`);
  await review.getByTestId("filter-ACTIVE").click();
  await review.getByTestId(`draft-${id}`).click();
  await review.close();

  // The draft card leaves the queue; if its buttons are still up, a tap records nothing.
  if (await page.getByTestId("rate-good").isVisible().catch(() => false)) {
    await page.getByTestId("rate-good").click();
  }
  await expect(page.getByTestId("study-card")).not.toHaveAttribute("data-concept-id", id);
  expect(await rawStored(page)).toBe(before);
});

test("M1 retry: after a stale rejection, the UPDATED card is rateable without reload (exactly one review)", async ({ page, context }) => {
  const { doc, id } = await uploadAndApprove(page, "retry-race.pdf");
  await studyUntil(page, id);
  const item = (await page.getByTestId("study-card").getAttribute("data-item-id"))!;
  await page.getByTestId("show-answer").click();
  const before = await rawStored(page);

  const review = await context.newPage();
  await review.goto(`/concepts?document=${doc}`);
  await review.getByTestId("filter-ACTIVE").click();
  await review.getByTestId(`title-input-${id}`).fill("Oxygen deficiency");
  await review.getByTestId(`summary-input-${id}`).fill("Oxygen deficiency is the corrected retry statement.");
  await review.getByTestId(`save-${id}`).click();
  await review.close();

  // Old content: refused, nothing recorded.
  await page.getByTestId("rate-good").click();
  await expect(page.getByTestId("study-notice")).toContainText("changed");
  expect(await rawStored(page)).toBe(before);

  // Updated content: same card id, shown again from the front — and rateable.
  const card = page.getByTestId("study-card");
  await expect(card).toHaveAttribute("data-item-id", item);
  await expect(page.getByTestId("card-back")).toHaveCount(0);
  await page.getByTestId("show-answer").click();
  await expect(page.getByTestId("card-back")).toContainText("corrected retry statement");
  await page.getByTestId("rate-good").click();
  await expect.poll(async () => (await stored(page))?.cards?.[item]?.reviews ?? 0).toBe(1);
  expect((await stored(page))!.cards?.[item]?.lastRating).toBe("GOOD");
});

test("L1: Enter on a focused link navigates natively and does not reveal the card", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("study-card")).toBeVisible();
  const link = page.getByRole("link", { name: "MedRecall" });
  await link.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  expect((await stored(page))?.cards ?? {}).toEqual({});
});

test("L1: shortcuts still work when nothing interactive is focused", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  const item = (await page.getByTestId("study-card").getAttribute("data-item-id"))!;
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("card-back")).toBeVisible();
  await page.keyboard.press("3");
  await expect(page.getByTestId("study-card")).not.toHaveAttribute("data-item-id", item);
  expect((await stored(page))!.cards?.[item]?.lastRating).toBe("GOOD");
});
