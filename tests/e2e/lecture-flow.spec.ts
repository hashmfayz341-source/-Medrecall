import { expect, test, type Page } from "@playwright/test";

/**
 * The primary MedRecall flow, end to end, on the real fixtures:
 *
 *   upload Cell Injury.pdf → title "Cell Injury" → Arabic + English medical
 *   terms → 40 cards → generated, grounded, some visual → approve → Study →
 *   Show Answer → Again/Hard/Good/Easy → source page → refresh → persists;
 *   then Inflammation.pdf, with Cell Injury cards due → they appear inside
 *   the Inflammation session, rate in their own history, stay Cell Injury's.
 */

const CELL_INJURY = "tests/fixtures/Cell Injury.pdf";
const INFLAMMATION = "tests/fixtures/Inflammation.pdf";
const CARDS_KEY = "medrecall.study-cards.v1";

type Sidecar = { cards: Record<string, { conceptId: string; reviews: number; lastRating: string; schedule: { due: string; state: number } }> };
const sidecar = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), CARDS_KEY) as Promise<Sidecar | null>;

async function uploadLecture(page: Page, file: string, options: { language: "en" | "ar" | "ar-en"; count: string; custom?: string }) {
  await page.goto("/upload");
  await page.getByTestId("upload-file").setInputFiles(file);
  await page.getByTestId(`lang-${options.language}`).check();
  await page.getByTestId(`count-${options.count}`).check();
  if (options.custom) await page.getByTestId("count-custom-value").fill(options.custom);
  await page.getByTestId("generate-button").click();
  const done = page.getByTestId("generation-done");
  await expect(done).toBeVisible({ timeout: 60_000 });
  return {
    lectureId: (await done.getAttribute("data-lecture-id"))!,
    produced: Number(await done.getAttribute("data-produced")),
    shortfall: Number(await done.getAttribute("data-shortfall")),
    figures: Number(await done.getAttribute("data-figures")),
  };
}

/** Rate every card of the current session with `rating` until the session is done. */
async function studyAll(page: Page, rating: "again" | "hard" | "good" | "easy", max = 60) {
  for (let i = 0; i < max; i++) {
    if (await page.getByTestId("study-done").isVisible().catch(() => false)) return;
    await expect(page.getByTestId("study-card")).toBeVisible();
    await page.getByTestId("show-answer").click();
    await page.getByTestId(`rate-${rating}`).click();
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    localStorage.clear();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase("medrecall.assets.v1");
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  });
  await page.reload();
});

test("Cell Injury.pdf → 40 mixed Arabic/English cards with original figures → review → study → source → refresh", async ({ page }) => {
  await expect(page.getByTestId("library-empty")).toBeVisible();
  await page.getByTestId("upload-lecture").click();
  await expect(page).toHaveURL(/\/upload$/);

  // The file name names the lecture; the title can be edited.
  await page.getByTestId("upload-file").setInputFiles(CELL_INJURY);
  await expect(page.getByTestId("lecture-title")).toHaveValue("Cell Injury");
  await page.getByTestId("lang-ar-en").check();
  await page.getByTestId("count-40").check();
  await page.getByTestId("generate-button").click();
  await expect(page.getByTestId("progress")).toBeVisible();
  const done = page.getByTestId("generation-done");
  await expect(done).toBeVisible({ timeout: 60_000 });
  const lectureId = (await done.getAttribute("data-lecture-id"))!;
  const produced = Number(await done.getAttribute("data-produced"));
  const figures = Number(await done.getAttribute("data-figures"));
  expect(produced).toBeGreaterThanOrEqual(12);
  expect(produced).toBeLessThanOrEqual(40);
  expect(figures).toBeGreaterThanOrEqual(3); // the histology images and the flowchart
  // Fewer than 40: the lecture does not support more, and it says so.
  await expect(page.getByTestId("shortfall-note")).toBeVisible();

  // Review: every card is a draft, grounded in a page, with mixed-language prompts.
  await page.getByTestId("review-cards-link").click();
  await expect(page).toHaveURL(new RegExp(`/lectures/${lectureId}`));
  await expect(page.getByTestId("lecture-heading")).toHaveText("Cell Injury");
  const drafts = page.locator('[data-testid^="card-"][data-status="DRAFT"]');
  expect(await drafts.count()).toBe(produced);
  const withImage = page.locator('[data-testid^="card-"][data-has-image="true"]');
  expect(await withImage.count()).toBeGreaterThanOrEqual(3);
  const imageCard = withImage.first();
  const imageCardId = (await imageCard.getAttribute("data-testid"))!.replace("card-", "");
  const img = page.getByTestId(`card-image-${imageCardId}`);
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(50);
  await expect(img).toHaveAttribute("data-page", /^[456]$/);
  // Arabic scaffolding around English terms, laid out right-to-left.
  const front = page.getByTestId(`card-front-${(await drafts.first().getAttribute("data-testid"))!.replace("card-", "")}`);
  await expect(front).toContainText(/[؀-ۿ]/);
  expect(await front.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");

  // Edit one card's back, then approve everything.
  const firstId = (await drafts.first().getAttribute("data-testid"))!.replace("card-", "");
  await page.getByTestId(`edit-card-${firstId}`).click();
  await page.getByTestId(`edit-back-${firstId}`).fill("Edited answer — still the lecture's fact.");
  await page.getByTestId(`save-card-${firstId}`).click();
  await expect(page.getByTestId(`card-back-${firstId}`)).toHaveText("Edited answer — still the lecture's fact.");
  await expect(page.getByTestId(`card-${firstId}`)).toHaveAttribute("data-status", "DRAFT");
  await page.getByTestId("approve-all").click();
  await expect(page.locator('[data-testid^="card-"][data-status="ACTIVE"]')).toHaveCount(produced);

  // The library shows the real lecture, not the demo.
  await page.goto("/");
  await expect(page.getByTestId(`library-title-${lectureId}`)).toHaveText("Cell Injury");
  await expect(page.getByTestId(`library-counts-${lectureId}`)).toContainText(`${produced} cards`);

  // Study: front → Show Answer → back with source → rate.
  await page.getByTestId(`study-${lectureId}`).click();
  await expect(page.getByTestId("study-card")).toBeVisible();
  await expect(page.getByTestId("card-back")).toHaveCount(0);
  await page.getByTestId("show-answer").click();
  await expect(page.getByTestId("card-back")).toBeVisible();
  await expect(page.getByTestId("card-source")).toContainText(/Cell Injury · page [2-9]/);
  await page.getByTestId("view-source").click();
  await expect(page.getByTestId("source-excerpt")).not.toBeEmpty();
  await expect(page.getByTestId("source-page-image")).toBeVisible();
  const cardPage = Number((await page.getByTestId("card-source").textContent())!.match(/page (\d+)/)![1]);
  await expect(page.getByTestId("source-page-image")).toHaveAttribute("data-page", String(cardPage));
  for (const r of ["again", "hard", "good", "easy"]) await expect(page.getByTestId(`rate-${r}`)).toBeVisible();
  const firstItem = (await page.getByTestId("study-card").getAttribute("data-item-id"))!;
  await page.getByTestId("rate-good").click();
  let stored = await sidecar(page);
  expect(stored!.cards[firstItem]!.reviews).toBe(1);
  expect(stored!.cards[firstItem]!.lastRating).toBe("GOOD");

  // Keep going until a visual card comes up; its figure is shown on the front.
  let sawImage = false;
  for (let i = 0; i < 40 && !sawImage; i++) {
    if (await page.getByTestId("study-done").isVisible().catch(() => false)) break;
    const card = page.getByTestId("study-card");
    await expect(card).toBeVisible();
    if ((await card.getAttribute("data-queue")) === "NEW" && (await page.getByTestId("card-image-front").count()) > 0) {
      sawImage = true;
      expect(await page.getByTestId("card-image-front").evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(50);
    }
    await page.getByTestId("show-answer").click();
    await page.getByTestId(sawImage ? "rate-easy" : "rate-good").click();
  }
  expect(sawImage).toBe(true);

  // Refresh: progress and cards persist.
  await page.reload();
  await expect(page.getByTestId("study-card").or(page.getByTestId("study-done")).first()).toBeVisible();
  stored = await sidecar(page);
  expect(Object.keys(stored!.cards).length).toBeGreaterThanOrEqual(2);
  expect(stored!.cards[firstItem]!.reviews).toBe(1);
});

test("English and Arabic modes, custom and auto counts, rename, generate more", async ({ page }) => {
  const en = await uploadLecture(page, CELL_INJURY, { language: "en", count: "custom", custom: "6" });
  expect(en.produced).toBe(6);
  expect(en.shortfall).toBe(0);
  await page.goto(`/lectures/${en.lectureId}`);
  const first = page.locator('[data-testid^="card-"][data-status]').first();
  const firstId = (await first.getAttribute("data-testid"))!.replace("card-", "");
  const front = page.getByTestId(`card-front-${firstId}`);
  await expect(front).not.toContainText(/[؀-ۿ]/);
  expect(await front.evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");

  // Rename the lecture.
  await page.getByTestId("rename-lecture").click();
  await page.getByTestId("lecture-title-input").fill("Cell Injury — week 3");
  await page.getByTestId("save-title").click();
  await expect(page.getByTestId("lecture-heading")).toHaveText("Cell Injury — week 3");
  await page.reload();
  await expect(page.getByTestId("lecture-heading")).toHaveText("Cell Injury — week 3");

  // Generate more (Arabic this time): only new facts, existing cards untouched.
  await page.getByTestId("generate-more-open").click();
  await page.getByTestId("gm-lang-ar").check();
  await page.getByTestId("gm-count-auto").check();
  await page.getByTestId("generate-more-button").click();
  const result = page.getByTestId("generate-more-result");
  await expect(result).toBeVisible({ timeout: 30_000 });
  const added = Number(await result.getAttribute("data-produced"));
  expect(added).toBeGreaterThan(0);
  await page.getByTestId("cards-filter-ALL").click();
  await expect(page.locator('[data-testid^="card-"][data-status]')).toHaveCount(6 + added);
  await expect(page.getByTestId(`card-front-${firstId}`)).toHaveText(await front.textContent() ?? "");
  // The new drafts are Arabic-scaffolded, the persisted language changed.
  const arabicFronts = page.locator('[data-testid^="card-front-"]').filter({ hasText: /[؀-ۿ]/ });
  expect(await arabicFronts.count()).toBe(added);
  // A large request then takes whatever lower-scoring facts remain (never a
  // repeat), and once the lecture is exhausted a further run reports zero.
  await page.getByTestId("gm-count-100").check();
  await page.getByTestId("generate-more-button").click();
  await expect(page.getByTestId("generate-more-result")).toBeVisible({ timeout: 30_000 });
  const remaining = Number(await page.getByTestId("generate-more-result").getAttribute("data-produced"));
  await expect(page.locator('[data-testid^="card-"][data-status]')).toHaveCount(6 + added + remaining);
  const fronts = await page.locator('[data-testid^="card-front-"]').allTextContents();
  expect(new Set(fronts).size).toBe(fronts.length);
  await page.getByTestId("generate-more-button").click();
  await expect(page.getByTestId("generate-more-result")).toHaveAttribute("data-produced", "0", { timeout: 30_000 });

  // AUTO on a fresh upload of the same PDF makes its own lecture with the important material once.
  const auto = await uploadLecture(page, INFLAMMATION, { language: "ar-en", count: "auto" });
  expect(auto.shortfall).toBe(0);
  expect(auto.produced).toBeGreaterThanOrEqual(5);
  await page.goto("/");
  await expect(page.getByTestId(`library-title-${auto.lectureId}`)).toHaveText("Inflammation");
});

test("old Cell Injury cards that are due come back inside the Inflammation session, in their own history", async ({ page }) => {
  // Day 1: Cell Injury studied, every card rated Easy (graduates to a Review interval of days).
  const cell = await uploadLecture(page, CELL_INJURY, { language: "en", count: "custom", custom: "8" });
  await page.goto(`/lectures/${cell.lectureId}`);
  await page.getByTestId("approve-all").click();
  await page.goto(`/study/${cell.lectureId}`);
  await studyAll(page, "easy");
  await expect(page.getByTestId("study-done")).toBeVisible();
  const before = (await sidecar(page))!;
  const cellItems = Object.keys(before.cards);
  expect(cellItems).toHaveLength(8);

  // Days later: the Cell Injury cards are due (their stored due times are moved into the past —
  // that is what time passing does; nothing about their FSRS state is changed).
  await page.evaluate((key) => {
    const stored = JSON.parse(localStorage.getItem(key)!);
    for (const card of Object.values(stored.cards) as { schedule: { due: string } }[]) {
      card.schedule.due = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
    }
    localStorage.setItem(key, JSON.stringify(stored));
  }, CARDS_KEY);

  const inflammation = await uploadLecture(page, INFLAMMATION, { language: "en", count: "custom", custom: "8" });
  await page.goto(`/lectures/${inflammation.lectureId}`);
  await page.getByTestId("approve-all").click();
  await page.goto("/");
  await expect(page.getByTestId(`library-due-${cell.lectureId}`)).toContainText("8 due");

  // Study Inflammation: after four Inflammation cards, a Cell Injury review is mixed in.
  await page.goto(`/study/${inflammation.lectureId}`);
  await expect(page.getByTestId("review-note")).toContainText("8 reviews from earlier lectures");
  const origins: string[] = [];
  let ratedOld = 0;
  let checkedOldProvenance = false;
  for (let i = 0; i < 24; i++) {
    if (await page.getByTestId("study-done").isVisible().catch(() => false)) break;
    const card = page.getByTestId("study-card");
    await expect(card).toBeVisible();
    const origin = (await card.getAttribute("data-origin"))!;
    origins.push(origin);
    if (origin === "review") {
      // Before the answer: a neutral Review chip, no lecture title that could give it away.
      await expect(page.getByTestId("card-review-chip")).toBeVisible();
      await expect(page.getByTestId("card-origin")).toHaveCount(0);
      await expect(card).toHaveAttribute("data-lecture-id", cell.lectureId);
      expect(cellItems).toContain(await card.getAttribute("data-item-id"));
    } else {
      await expect(card).toHaveAttribute("data-lecture-id", inflammation.lectureId);
    }
    await page.getByTestId("show-answer").click();
    if (origin === "review") {
      await expect(page.getByTestId("card-origin")).toContainText("From Cell Injury");
      await expect(page.getByTestId("card-source")).toContainText("Cell Injury · page");
      checkedOldProvenance = true;
      await page.getByTestId("rate-hard").click();
      ratedOld++;
    } else {
      await page.getByTestId("rate-good").click();
    }
  }
  // One old review after every four current cards.
  expect(origins.slice(0, 5)).toEqual(["current", "current", "current", "current", "review"]);
  expect(origins.slice(5, 10)).toEqual(["current", "current", "current", "current", "review"]);
  expect(checkedOldProvenance).toBe(true);
  expect(ratedOld).toBeGreaterThanOrEqual(2);

  // The rated old cards advanced their OWN history and still belong to Cell Injury.
  const after = (await sidecar(page))!;
  const advanced = cellItems.filter((id) => after.cards[id]!.reviews === before.cards[id]!.reviews + 1);
  expect(advanced.length).toBe(ratedOld);
  for (const id of advanced) {
    expect(after.cards[id]!.lastRating).toBe("HARD");
    expect(after.cards[id]!.conceptId).toBe(before.cards[id]!.conceptId);
  }
  await page.goto(`/lectures/${cell.lectureId}`);
  await expect(page.getByTestId("lecture-stats")).toContainText("8 cards");
  await page.goto(`/lectures/${inflammation.lectureId}`);
  await expect(page.getByTestId("lecture-stats")).toContainText("8 cards");

  // Refresh mid-session: the composition and progress survive.
  await page.goto(`/study/${inflammation.lectureId}`);
  await page.reload();
  await expect(page.getByTestId("study-card").or(page.getByTestId("study-done")).first()).toBeVisible();
  expect(Object.keys((await sidecar(page))!.cards).length).toBe(Object.keys(after.cards).length);
});

test("Reset removes lectures, cards and page images together", async ({ page }) => {
  const cell = await uploadLecture(page, CELL_INJURY, { language: "en", count: "20" });
  await page.goto("/");
  await expect(page.getByTestId(`library-title-${cell.lectureId}`)).toBeVisible();
  await page.getByTestId("reset-demo").click();
  await expect(page.getByTestId("library-empty")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("library-empty")).toBeVisible();
  const assets = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const request = indexedDB.open("medrecall.assets.v1", 1);
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("assets")) return resolve(0);
          const count = db.transaction("assets").objectStore("assets").count();
          count.onsuccess = () => resolve(count.result);
          count.onerror = () => resolve(-1);
        };
        request.onerror = () => resolve(-1);
      }),
  );
  expect(assets).toBe(0);
});
