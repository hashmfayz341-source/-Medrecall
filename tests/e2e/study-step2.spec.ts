import { expect, test, type Page } from "@playwright/test";

/**
 * Step 2: the Study browser (decks), the card browser, suspend/bury, card
 * editing, custom study and daily limits — on top of the Step 1 session.
 */

const L1 = "lecture-cell-injury";
const L2 = "lecture-inflammation";
const LK = "medrecall.learner.v1";
const SK = "medrecall.study-cards.v1";
const SETTINGS = "medrecall.study-settings.v1";
const H1 = "c-hypoxia-1";

const raw = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
const sidecar = async (page: Page) =>
  JSON.parse((await raw(page, SK)) ?? "null") as {
    cards: Record<string, { reviews: number; lastRating: string }>;
    flags?: Record<string, { conceptId: string; suspended?: boolean; buriedUntil?: string }>;
    studyDay?: { day: string; newIntroduced: number; reviews: number };
  } | null;

async function rateCurrent(page: Page, rating: "again" | "hard" | "good" | "easy") {
  const item = (await page.getByTestId("study-card").getAttribute("data-item-id"))!;
  await page.getByTestId("show-answer").click();
  await page.getByTestId(`rate-${rating}`).click();
  await expect(page.getByTestId("study-card")).not.toHaveAttribute("data-item-id", item);
  return item;
}

/** Rate other cards Easy until the given card is showing (learning cards come after new ones). */
async function studyUntil(page: Page, itemId: string) {
  for (let i = 0; i < 40; i++) {
    const card = page.getByTestId("study-card");
    await expect(card).toBeVisible();
    if ((await card.getAttribute("data-item-id")) === itemId) return;
    await page.getByTestId("show-answer").click();
    await page.getByTestId("rate-easy").click();
  }
  throw new Error(`never reached ${itemId}`);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("dashboard → Study decks: one deck per lecture with real FSRS counts; studying updates them; a refresh keeps them", async ({ page }) => {
  await page.getByTestId("study-browser-link").click();
  await expect(page).toHaveURL(/\/study$/);
  await expect(page.getByTestId(`deck-${L1}`)).toBeVisible();
  await expect(page.getByTestId(`deck-${L2}`)).toBeVisible();
  const totalText = (await page.getByTestId(`deck-total-${L1}`).textContent())!;
  const total = Number(totalText.match(/\d+/)![0]);
  expect(total).toBeGreaterThan(1);
  await expect(page.getByTestId(`deck-counts-${L1}`)).toContainText(`${total} new`);
  await expect(page.getByTestId(`deck-counts-${L1}`)).toContainText("0 learning");
  await expect(page.getByTestId("course-counts")).toBeVisible();

  await page.getByTestId(`study-${L1}`).click();
  await expect(page).toHaveURL(new RegExp(`/study/${L1}$`));
  await rateCurrent(page, "again");

  await page.goto("/study");
  await expect(page.getByTestId(`deck-counts-${L1}`)).toContainText(`${total - 1} new`);
  await expect(page.getByTestId(`deck-counts-${L1}`)).toContainText("1 learning");
  await expect(page.getByTestId("course-counts")).toContainText("1 learning");
  await expect(page.getByTestId("study-due-course")).toBeVisible();

  await page.reload();
  await expect(page.getByTestId(`deck-counts-${L1}`)).toContainText("1 learning");
});

test("card browser: every approved card with concept, lecture, provenance and status; filters; open the source", async ({ page }) => {
  await page.goto("/study");
  const total = Number((await page.getByTestId(`deck-total-${L1}`).textContent())!.match(/\d+/)![0]);
  await page.getByTestId(`browse-${L1}`).click();
  await expect(page).toHaveURL(/\/study\/browse\?lecture=/);
  await expect(page.getByTestId("filter-lecture")).toHaveValue(L1);
  await expect(page.getByTestId("browser-count")).toHaveText(String(total));

  const row = page.getByTestId(`card-row-${H1}`);
  await expect(row).toHaveAttribute("data-status", "NEW");
  await expect(page.getByTestId(`card-concept-${H1}`)).toContainText("Hypoxia");
  await expect(page.getByTestId(`card-lecture-${H1}`)).toContainText("Cell");
  await expect(page.getByTestId(`card-status-${H1}`)).toHaveText("New");
  await expect(page.getByTestId(`card-excerpt-${H1}`)).toBeHidden();
  await page.getByTestId(`card-source-${H1}`).click();
  await expect(page.getByTestId(`card-excerpt-${H1}`)).toBeVisible();
  await expect(page.getByTestId(`card-source-${H1}`)).toContainText("page");

  // Filters use existing metadata: type, status, text.
  await page.getByTestId("filter-kind").selectOption("CLOZE");
  const clozeCount = Number(await page.getByTestId("browser-count").textContent());
  expect(clozeCount).toBeGreaterThan(0);
  expect(clozeCount).toBeLessThan(total);
  await page.getByTestId("filter-kind").selectOption("");
  await page.getByTestId("filter-text").fill("hypoxia");
  await expect(page.getByTestId(`card-row-${H1}`)).toBeVisible();
  expect(Number(await page.getByTestId("browser-count").textContent())).toBeLessThan(total);
  await page.getByTestId("filter-text").fill("zzz-no-such-card");
  await expect(page.getByTestId("browser-empty")).toBeVisible();
  await page.getByTestId("filter-text").fill("");
  await page.getByTestId("filter-status").selectOption("LEARNING");
  await expect(page.getByTestId("browser-empty")).toBeVisible();
  await page.getByTestId("filter-status").selectOption("");

  // No DRAFT card is ever listed, in any lecture.
  await page.getByTestId("filter-lecture").selectOption("");
  await expect(page.getByTestId("card-row-c-draft-lyso-1")).toHaveCount(0);
  await expect(page.getByTestId("card-row-c-draft-chronic-1")).toHaveCount(0);

  await page.getByTestId(`card-source-${H1}`).click();
  await page.getByTestId(`card-open-source-${H1}`).click();
  await expect(page).toHaveURL(/\/concepts\?document=/);
});

test("suspend keeps a card out of Study (counted, FSRS kept); resume brings it back; flags persist", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("study-card")).toHaveAttribute("data-item-id", H1);
  await rateCurrent(page, "good");
  expect((await sidecar(page))!.cards[H1]!.reviews).toBe(1);

  await page.goto(`/study/browse?lecture=${L1}`);
  await page.getByTestId(`suspend-card-${H1}`).click();
  await expect(page.getByTestId(`card-row-${H1}`)).toHaveAttribute("data-status", "SUSPENDED");
  await expect(page.getByTestId(`resume-card-${H1}`)).toBeVisible();
  expect((await sidecar(page))!.flags?.[H1]?.suspended).toBe(true);
  expect((await sidecar(page))!.cards[H1]!.reviews).toBe(1); // history kept

  await page.goto("/study");
  await expect(page.getByTestId(`deck-counts-${L1}-suspended`)).toHaveText("1 suspended");
  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("count-learning")).toHaveText("0"); // the Learning card is suspended
  await expect(page.getByTestId("study-card")).not.toHaveAttribute("data-item-id", H1);

  await page.reload();
  await expect(page.getByTestId("count-learning")).toHaveText("0");

  await page.goto(`/study/browse?lecture=${L1}`);
  await page.getByTestId(`resume-card-${H1}`).click();
  await expect(page.getByTestId(`card-row-${H1}`)).toHaveAttribute("data-status", "LEARNING");
  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("count-learning")).toHaveText("1");
  await studyUntil(page, H1); // back in the queue, continuing from its schedule
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-good").click();
  await expect.poll(async () => (await sidecar(page))!.cards[H1]!.reviews).toBe(2);
});

test("bury takes a card out until tomorrow, distinct from suspend; unbury restores it", async ({ page }) => {
  await page.goto(`/study/browse?lecture=${L1}`);
  await page.getByTestId(`bury-card-${H1}`).click();
  await expect(page.getByTestId(`card-row-${H1}`)).toHaveAttribute("data-status", "BURIED");
  await expect(page.getByTestId(`card-status-${H1}`)).toContainText("Buried until");
  const flags = (await sidecar(page))!.flags!;
  expect(new Date(flags[H1]!.buriedUntil!).getTime()).toBeGreaterThan(Date.now());
  expect(flags[H1]!.suspended).toBeUndefined();

  await page.goto("/study");
  await expect(page.getByTestId(`deck-counts-${L1}-buried`)).toHaveText("1 buried");
  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("study-card")).not.toHaveAttribute("data-item-id", H1);

  await page.goto(`/study/browse?lecture=${L1}`);
  await page.getByTestId(`unbury-card-${H1}`).click();
  await expect(page.getByTestId(`card-row-${H1}`)).toHaveAttribute("data-status", "NEW");
  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("study-card")).toHaveAttribute("data-item-id", H1);
});

test("editing a card changes its wording, keeps its id and FSRS history, and never reaches a DRAFT", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  await rateCurrent(page, "good"); // H1 → reviews 1

  await page.goto(`/study/browse?lecture=${L1}`);
  await page.getByTestId(`edit-card-${H1}`).click();
  await page.getByTestId(`edit-prompt-${H1}`).fill("EDITED: what is the commonest cause of cell injury?");
  await page.getByTestId(`edit-explanation-${H1}`).fill("EDITED: hypoxia, most often from ischaemia.");
  await page.getByTestId(`save-card-${H1}`).click();
  await expect(page.getByTestId(`card-front-${H1}`)).toHaveText("EDITED: what is the commonest cause of cell injury?");
  await expect(page.getByTestId(`card-row-${H1}`)).toHaveAttribute("data-status", "LEARNING"); // same card, same schedule
  expect((await sidecar(page))!.cards[H1]!.reviews).toBe(1);

  await page.reload();
  await expect(page.getByTestId(`card-front-${H1}`)).toHaveText("EDITED: what is the commonest cause of cell injury?");

  // The session shows the new wording and continues the schedule.
  await page.goto(`/study/${L1}`);
  await studyUntil(page, H1);
  await expect(page.getByTestId("card-front")).toHaveText("EDITED: what is the commonest cause of cell injury?");
  await page.getByTestId("show-answer").click();
  await expect(page.getByTestId("card-back")).toContainText("EDITED: hypoxia");
  await page.getByTestId("rate-good").click();
  expect((await sidecar(page))!.cards[H1]!.reviews).toBe(2);

  // DRAFT cards cannot be reached by the editor at all.
  await page.goto("/study/browse");
  await expect(page.getByTestId("edit-card-c-draft-lyso-1")).toHaveCount(0);
});

test("a card edited in another tab after Show Answer cannot be rated with the old wording (stale-tab protection)", async ({ page, context }) => {
  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("study-card")).toHaveAttribute("data-item-id", H1);
  await page.getByTestId("show-answer").click();

  const other = await context.newPage();
  await other.goto(`/study/browse?lecture=${L1}`);
  await other.getByTestId(`edit-card-${H1}`).click();
  await other.getByTestId(`edit-prompt-${H1}`).fill("Changed elsewhere?");
  await other.getByTestId(`save-card-${H1}`).click();
  await expect(other.getByTestId(`card-front-${H1}`)).toHaveText("Changed elsewhere?");

  await page.getByTestId("rate-good").click();
  await expect(page.getByTestId("study-notice")).toContainText("changed while you were studying");
  expect((await sidecar(page))?.cards?.[H1]).toBeUndefined();
});

test("custom study: all due cards across the course, with normal FSRS; the URL keeps the session across a refresh", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  await rateCurrent(page, "again");
  await page.goto(`/study/${L2}`);
  await rateCurrent(page, "again");
  const newInL1 = Number((await page.goto("/study"), await page.getByTestId(`deck-counts-${L1}`).textContent())!.match(/(\d+) new/)![1]);
  expect(newInL1).toBeGreaterThan(0);

  await page.getByTestId("open-custom-study").click();
  await expect(page).toHaveURL(/\/study\/custom$/);
  await page.getByTestId("scope-due").check();
  await expect(page.getByTestId("custom-preview")).toContainText("2 of");
  await expect(page.getByTestId("custom-preview")).toContainText("0 new");
  await page.getByTestId("start-custom").click();
  await expect(page).toHaveURL(/scope=due/);
  await expect(page).toHaveURL(/start=1/);
  await expect(page.getByTestId("count-new")).toHaveText("0");
  await expect(page.getByTestId("count-learning")).toHaveText("2");
  await expect(page.getByTestId("study-card")).toHaveAttribute("data-queue", "LEARNING");

  await page.reload();
  await expect(page.getByTestId("count-learning")).toHaveText("2");
  const item = await rateCurrent(page, "easy"); // graduates it to Review
  expect((await sidecar(page))!.cards[item]!.reviews).toBe(2); // the same engine and schedule
  await expect(page.getByTestId("count-learning")).toHaveText("1");
});

test("custom study: a selection by lecture and type studies exactly those cards", async ({ page }) => {
  await page.goto("/study/custom");
  await page.getByTestId("scope-filter").check();
  await page.getByTestId("custom-lecture").selectOption(L1);
  await page.getByTestId("custom-kind").selectOption("CLOZE");
  await expect(page.getByTestId("custom-preview")).not.toContainText("0 of");
  await page.getByTestId("start-custom").click();
  await expect(page).toHaveURL(/kind=CLOZE/);
  const card = page.getByTestId("study-card");
  await expect(card).toHaveAttribute("data-concept-id", /^c-/);
  const conceptId = (await card.getAttribute("data-concept-id"))!;
  expect(["c-hypoxia", "c-reversible-irreversible", "c-atp-depletion", "c-na-k-atpase", "c-cellular-swelling"]).toContain(conceptId);
  await expect(card).toContainText("Cloze");
});

test("daily limits: new cards per day are enforced in a session, persist, and can be ignored by custom study", async ({ page }) => {
  await page.goto("/study");
  const total = Number((await page.getByTestId(`deck-total-${L1}`).textContent())!.match(/\d+/)![0]);
  await page.getByTestId("limit-new").fill("1");
  await page.getByTestId("save-limits").click();
  await expect(page.getByTestId("limits-error")).toHaveCount(0);
  expect(JSON.parse((await raw(page, SETTINGS))!)).toEqual({ version: 1, newPerDay: 1, reviewsPerDay: 200 });
  await expect(page.getByTestId(`deck-counts-${L1}`)).toContainText("1 new");

  await page.getByTestId(`study-${L1}`).click();
  await expect(page.getByTestId("count-new")).toHaveText("1");
  await expect(page.getByTestId("limit-note")).toContainText(`${total - 1} new cards held back`);
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-easy").click();
  await expect(page.getByTestId("study-done")).toBeVisible();
  await expect(page.getByTestId("count-new")).toHaveText("0");
  expect((await sidecar(page))!.studyDay?.newIntroduced).toBe(1);

  await page.reload();
  await expect(page.getByTestId("study-done")).toBeVisible();

  // Custom study can ignore the limits: the rest of the deck is available.
  await page.goto("/study/custom");
  await page.getByTestId("scope-filter").check();
  await page.getByTestId("custom-lecture").selectOption(L1);
  await expect(page.getByTestId("custom-preview")).toContainText("0 of");
  await page.getByTestId("ignore-limits").check();
  await expect(page.getByTestId("custom-preview")).toContainText(`${total - 1} of`);
  await page.getByTestId("start-custom").click();
  await expect(page.getByTestId("count-new")).toHaveText(String(total - 1));
  await expect(page.getByTestId("limit-note")).toHaveCount(0);

  // Invalid values are refused and nothing is saved.
  await page.goto("/study");
  await page.getByTestId("limit-reviews").fill("-5");
  await page.getByTestId("save-limits").click();
  await expect(page.getByTestId("limits-error")).toBeVisible();
  expect(JSON.parse((await raw(page, SETTINGS))!).reviewsPerDay).toBe(200);
});

test("Study flags and card edits never touch the Tutor's evidence: suspended cards do not complete a chunk", async ({ page }) => {
  await page.goto(`/study/browse?lecture=${L1}`);
  await page.getByTestId(`suspend-card-${H1}`).click();
  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-teach")).toBeVisible();
  await page.getByTestId("teach-continue").click();
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", "c-hypoxia");
  expect(JSON.parse((await raw(page, LK))!).completedChunkIds).toEqual([]);
});
