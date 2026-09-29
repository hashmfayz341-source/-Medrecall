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
  // Image QUESTIONS only where a caption establishes what the picture shows
  // (the histology images on pages 5 and 6), answered by that caption. The
  // labelled flowchart on page 4 would show its own answer, so it only
  // illustrates the back of the mechanism cards.
  const imageQuestions = page.locator('[data-testid^="card-"][data-kind="IMAGE"]');
  await expect(imageQuestions).toHaveCount(2);
  expect(await imageQuestions.evaluateAll((els) => els.map((el) => el.getAttribute("data-page")))).toEqual(["5", "6"]);
  const hydropicId = (await imageQuestions.first().getAttribute("data-testid"))!.replace("card-", "");
  await expect(page.getByTestId(`card-front-${hydropicId}`)).toHaveText("ماذا تُظهر هذه الصورة؟");
  await expect(page.getByTestId(`card-back-${hydropicId}`)).toContainText("Hydropic change of renal tubular cells");
  await expect(page.locator('[data-testid^="card-"][data-kind="MECHANISM"][data-page="4"][data-has-image="true"]')).not.toHaveCount(0);
  // Mixed mode: Arabic sentences — question AND answer — with English medical terms, right-to-left.
  const hypoxia = page.locator('[data-testid^="card-front-"]').filter({ hasText: "السبب الأكثر شيوعًا لـ cell injury" });
  await expect(hypoxia).toHaveCount(1);
  const hypoxiaId = (await hypoxia.getAttribute("data-testid"))!.replace("card-front-", "");
  await expect(page.getByTestId(`card-back-${hypoxiaId}`)).toHaveText("Hypoxia هو السبب الأكثر شيوعًا لـ cell injury.");
  expect(await hypoxia.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
  const front = page.getByTestId(`card-front-${(await drafts.first().getAttribute("data-testid"))!.replace("card-", "")}`);
  await expect(front).toContainText(/[؀-ۿ]/);

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
      // The answer is what the image's caption says, and the source is the image's own page.
      await page.getByTestId("show-answer").click();
      await expect(page.getByTestId("card-back")).toContainText(/Hydropic change|Steatosis/);
      const imagePage = await page.getByTestId("card-image-front").getAttribute("data-page");
      await expect(page.getByTestId("card-source")).toContainText(`page ${imagePage}`);
      await page.getByTestId("rate-easy").click();
      continue;
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
  await page.getByTestId("cards-filter-ALL").click();
  await expect(page.locator('[data-testid^="card-"][data-status]')).toHaveCount(6 + added + remaining);
  // No question twice (an image question is told apart by the image it shows).
  const questions = await page.locator('[data-testid^="card-"][data-status]').evaluateAll((els) =>
    els.map((el) => `${el.querySelector('[data-testid^="card-front-"]')?.textContent}|${el.getAttribute("data-kind") === "IMAGE" ? el.getAttribute("data-page") : ""}`),
  );
  expect(new Set(questions).size).toBe(questions.length);
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
  const reviewedIds: string[] = [];
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
      reviewedIds.push((await card.getAttribute("data-item-id"))!);
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
  // One old review after every four current cards; a card rated Hard never comes back in the same session.
  expect(new Set(reviewedIds).size).toBe(reviewedIds.length);
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

test("Arabic mode writes Arabic answers with Arabic medical terms; the UI discloses what stayed English", async ({ page }) => {
  await page.goto("/upload");
  await page.getByTestId("upload-file").setInputFiles(CELL_INJURY);
  await page.getByTestId("lang-ar").check();
  await expect(page.getByTestId("lang-language-note")).toContainText("written in Arabic");
  await page.getByTestId("count-custom").check();
  await page.getByTestId("count-custom-value").fill("12");
  await page.getByTestId("generate-button").click();
  const done = page.getByTestId("generation-done");
  await expect(done).toBeVisible({ timeout: 60_000 });
  const lectureId = (await done.getAttribute("data-lecture-id"))!;
  const arabic = Number(await done.getAttribute("data-arabic"));
  const partial = Number(await done.getAttribute("data-partial"));
  expect(arabic + partial).toBe(12);
  await expect(page.getByTestId("coverage-note")).toContainText(`Fully Arabic: ${arabic} card`);
  if (partial > 0) await expect(page.getByTestId("coverage-note")).toContainText(`Partly English: ${partial} card`);
  await expect(page.getByTestId("coverage-note")).not.toContainText("written as Arabic sentences");
  await page.goto(`/lectures/${lectureId}`);
  const hypoxia = page.locator('[data-testid^="card-front-"]').filter({ hasText: "إصابة الخلية (cell injury)" }).first();
  const id = (await hypoxia.getAttribute("data-testid"))!.replace("card-front-", "");
  await expect(hypoxia).toHaveText("ما هو السبب الأكثر شيوعًا لـ إصابة الخلية (cell injury)؟");
  await expect(page.getByTestId(`card-back-${id}`)).toHaveText("نقص الأكسجة (Hypoxia) هو السبب الأكثر شيوعًا لـ إصابة الخلية (cell injury).");
  // Every question in Arabic mode is Arabic; no "ما هو <English sentence>؟".
  for (const text of await page.locator('[data-testid^="card-front-"]').allTextContents()) {
    expect(text).toMatch(/[؀-ۿ]/);
    const wrapped = /^ما هو (.+)؟$/.exec(text)?.[1] ?? "";
    expect(wrapped.replace(/\([^)]*\)/g, "").split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).length).toBeLessThanOrEqual(4);
  }
  // View source still shows the lecture's own English sentence.
  await page.getByTestId(`view-source-${id}`).locator("summary").click();
  await expect(page.getByTestId(`source-excerpt-${id}`)).toHaveText("Hypoxia is the most common cause of cell injury.");
});

test("the reviews-per-day limit caps old reviews mixed into a new lecture", async ({ page }) => {
  const cell = await uploadLecture(page, CELL_INJURY, { language: "en", count: "custom", custom: "8" });
  await page.goto(`/lectures/${cell.lectureId}`);
  await page.getByTestId("approve-all").click();
  await page.goto(`/study/${cell.lectureId}`);
  await studyAll(page, "easy");
  await page.evaluate((key) => {
    const stored = JSON.parse(localStorage.getItem(key)!);
    for (const card of Object.values(stored.cards) as { schedule: { due: string } }[]) card.schedule.due = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
    // A new day: yesterday's tally no longer counts.
    delete stored.studyDay;
    localStorage.setItem(key, JSON.stringify(stored));
  }, CARDS_KEY);
  const inflammation = await uploadLecture(page, INFLAMMATION, { language: "en", count: "custom", custom: "8" });
  await page.goto(`/lectures/${inflammation.lectureId}`);
  await page.getByTestId("approve-all").click();

  // Reviews per day: 1 (the existing Study option).
  await page.goto("/study");
  await page.getByTestId("limit-reviews").fill("1");
  await page.getByTestId("save-limits").click();
  await page.goto(`/study/${inflammation.lectureId}`);
  await expect(page.getByTestId("review-note")).toContainText("1 review from earlier lectures");
  let reviews = 0;
  for (let i = 0; i < 20; i++) {
    if (await page.getByTestId("study-done").isVisible().catch(() => false)) break;
    await expect(page.getByTestId("study-card")).toBeVisible();
    if ((await page.getByTestId("study-card").getAttribute("data-origin")) === "review") reviews++;
    await page.getByTestId("show-answer").click();
    await page.getByTestId("rate-easy").click();
  }
  expect(reviews).toBe(1);

  // Limit 0: none.
  await page.goto("/study");
  await page.getByTestId("limit-reviews").fill("0");
  await page.getByTestId("save-limits").click();
  await page.goto(`/study/${inflammation.lectureId}`);
  await expect(page.getByTestId("study-card").or(page.getByTestId("study-done")).first()).toBeVisible();
  await expect(page.getByTestId("review-note")).toHaveCount(0);
});

test("a lecture with two PDFs: generate from the second, then from all material — provenance kept, first PDF's cards untouched", async ({ page }) => {
  const a = await uploadLecture(page, CELL_INJURY, { language: "en", count: "custom", custom: "6" });
  await page.goto(`/lectures/${a.lectureId}`);
  await page.getByTestId("approve-all").click();
  // Study one card of A.
  await page.goto(`/study/${a.lectureId}`);
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-good").click();
  const before = (await sidecar(page))!;
  const aDocument = (await page.evaluate(() => JSON.parse(localStorage.getItem("medrecall.curriculum.v1")!).ingested[0].document.id)) as string;

  // Add B to the same lecture.
  await page.goto(`/lectures/${a.lectureId}`);
  await page.getByTestId("add-pdf-open").click();
  await page.getByTestId("add-pdf-file").setInputFiles(INFLAMMATION);
  const added = page.getByTestId("add-pdf-done");
  await expect(added).toBeVisible({ timeout: 60_000 });
  const bDocument = (await added.getAttribute("data-document-id"))!;
  expect(bDocument).not.toBe(aDocument);

  // Generate from B only.
  await expect(page.getByTestId("gm-source")).toHaveValue(bDocument);
  await page.getByTestId("gm-count-custom").check();
  await page.getByTestId("gm-count-custom-value").fill("4");
  await page.getByTestId("generate-more-button").click();
  await expect(page.getByTestId("generate-more-result")).toHaveAttribute("data-produced", "4", { timeout: 30_000 });
  await page.getByTestId("cards-filter-ALL").click();
  await expect(page.locator(`[data-testid^="card-"][data-document="${bDocument}"]`)).toHaveCount(4);
  await expect(page.locator(`[data-testid^="card-"][data-document="${aDocument}"]`)).toHaveCount(6);
  await expect(page.locator(`[data-testid^="card-"][data-document="${aDocument}"][data-status="ACTIVE"]`)).toHaveCount(6);
  // B's cards cite B's pages.
  const bCard = page.locator(`[data-testid^="card-"][data-document="${bDocument}"]`).first();
  const bId = (await bCard.getAttribute("data-testid"))!.replace("card-", "");
  await page.getByTestId(`view-source-${bId}`).locator("summary").click();
  await expect(page.getByTestId(`view-source-${bId}`)).toContainText("Inflammation, page");
  // A's studied card kept its FSRS history.
  const mid = (await sidecar(page))!;
  expect(mid.cards).toEqual(before.cards);

  // All lecture material: new cards from both, no duplicates of anything existing.
  await page.getByTestId("gm-source").selectOption("all");
  await page.getByTestId("gm-count-auto").check();
  await page.getByTestId("generate-more-button").click();
  await expect(page.getByTestId("generate-more-result")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("cards-filter-ALL").click();
  const fronts = await page.locator('[data-testid^="card-front-"]').allTextContents();
  const backs = await page.locator('[data-testid^="card-back-"]').allTextContents();
  expect(new Set(backs).size).toBe(backs.length);
  expect(fronts.length).toBeGreaterThan(10);
  await expect(page.locator(`[data-testid^="card-"][data-document="${aDocument}"]`)).not.toHaveCount(6);

  // Refresh: both PDFs and every card are still there.
  const total = await page.locator('[data-testid^="card-"][data-status]').count();
  await page.reload();
  await page.getByTestId("cards-filter-ALL").click();
  await expect(page.locator('[data-testid^="card-"][data-status]')).toHaveCount(total);
  await page.getByTestId("source-toggle").click();
  await expect(page.getByTestId("source-pages")).toContainText("Cell Injury");
  await expect(page.getByTestId("source-pages")).toContainText("Inflammation");
  expect((await sidecar(page))!.cards).toEqual(before.cards);
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
