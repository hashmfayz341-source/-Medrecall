import { expect, test, type Page } from "@playwright/test";

/**
 * Merge-gate regression, in the browser, on an UNSEEN lecture
 * (scripts/make-unseen-fixture.mjs — hepatic pathology, written
 * independently of the fixtures the generator was developed on):
 *
 * 1. Arabic mode discloses what stayed English: partial cards are counted
 *    and never called "Arabic"; context-dependent words keep their meaning.
 * 2. Repeated pictures are matched by the browser's own rendering hash: the
 *    picture drawn twice with contradictory captions gets no question, the
 *    picture drawn twice with the same caption gets one.
 * 3. An image illustrates only the card it is about ("centrilobular
 *    necrosis"), never one sharing a generic word ("bridging necrosis").
 * 4. An old card rated Again / Hard / Good / Easy is not re-inserted after a
 *    refresh before FSRS makes it due; Again comes back when its step is due.
 * 5. The lecture header keeps the title readable at the iPad viewport, with
 *    long titles and all actions present: no overlap, no horizontal overflow.
 */

const UNSEEN = "tests/fixtures/Hepatic Injury, Repair and Fibrosis in Alcoholic, Viral and Drug-Induced Liver Disease.pdf";
const CELL_INJURY = "tests/fixtures/Cell Injury.pdf";
const INFLAMMATION = "tests/fixtures/Inflammation.pdf";
const CARDS_KEY = "medrecall.study-cards.v1";

async function uploadLecture(page: Page, file: string, options: { language: "en" | "ar" | "ar-en"; count: string; custom?: string }) {
  await page.goto("/upload");
  await page.getByTestId("upload-file").setInputFiles(file);
  await page.getByTestId(`lang-${options.language}`).check();
  await page.getByTestId(`count-${options.count}`).check();
  if (options.custom) await page.getByTestId("count-custom-value").fill(options.custom);
  await page.getByTestId("generate-button").click();
  const done = page.getByTestId("generation-done");
  await expect(done).toBeVisible({ timeout: 60_000 });
  return { lectureId: (await done.getAttribute("data-lecture-id"))!, produced: Number(await done.getAttribute("data-produced")) };
}

async function studyAll(page: Page, rating: "again" | "hard" | "good" | "easy", max = 60) {
  for (let i = 0; i < max; i++) {
    if (await page.getByTestId("study-done").isVisible().catch(() => false)) return;
    await expect(page.getByTestId("study-card")).toBeVisible();
    await page.getByTestId("show-answer").click();
    await page.getByTestId(`rate-${rating}`).click();
  }
}

/** Card rows of the lecture view, with what the reviewer sees. */
async function cardRows(page: Page) {
  await page.getByTestId("cards-filter-ALL").click();
  return page.locator('[data-testid^="card-"][data-status]').evaluateAll((rows) =>
    rows.map((row) => ({
      id: row.getAttribute("data-testid")!.replace(/^card-/, ""),
      page: Number(row.getAttribute("data-page")),
      kind: row.getAttribute("data-kind"),
      hasImage: row.getAttribute("data-has-image") === "true",
      front: (row.querySelector('[data-testid^="card-front-"]') as HTMLElement | null)?.innerText ?? "",
      back: (row.querySelector('[data-testid^="card-back-"]') as HTMLElement | null)?.innerText ?? "",
    })),
  );
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

test("unseen lecture, Arabic: partial cards disclosed, meanings kept, images grounded and deduplicated by the browser's hash", async ({ page }) => {
  const { lectureId, produced } = await uploadLecture(page, UNSEEN, { language: "ar", count: "100" });
  const done = page.getByTestId("generation-done");
  const arabic = Number(await done.getAttribute("data-arabic"));
  const partial = Number(await done.getAttribute("data-partial"));
  expect(arabic + partial).toBe(produced);
  // This lecture has at least seven sentences the built-in generator cannot translate: they are counted, never called Arabic.
  expect(partial).toBeGreaterThanOrEqual(7);
  const note = page.getByTestId("coverage-note");
  await expect(note).toContainText(`Fully Arabic: ${arabic} card`);
  await expect(note).toContainText(`Partly English: ${partial} card`);
  await expect(note).not.toContainText("written as Arabic sentences");

  await page.goto(`/lectures/${lectureId}`);
  await expect(page.getByTestId("lecture-heading")).toHaveText("Hepatic Injury, Repair and Fibrosis in Alcoholic, Viral and Drug Induced Liver Disease");
  const rows = await cardRows(page);
  expect(rows).toHaveLength(produced);
  const byBack = (fragment: string) => {
    const row = rows.find((r) => r.back.includes(fragment));
    expect(row, fragment).toBeTruthy();
    return row!;
  };

  // Meaning: "most specific" is not "معظم"; "by two weeks" is بحلول; "within twelve hours" is خلال; "within canaliculi" is داخل.
  const alt = byBack("Alanine aminotransferase");
  expect(`${alt.front} ${alt.back}`).not.toContain("معظم");
  expect(alt.back).toContain("most specific marker");
  expect(byBack("restores liver mass").back).toContain("بحلول أسبوعين");
  expect(byBack("restores liver mass").back).not.toContain("بواسطة");
  expect(byBack("aminotransferases rise").back).toContain("خلال 12 ساعة");
  expect(byBack("canaliculi").back).toContain("داخل canaliculi");
  // Every question is Arabic.
  for (const row of rows) expect(row.front).toMatch(/[؀-ۿ]/);

  // Images: one question for the captioned micrograph (page 3), one for the picture drawn twice with the
  // same caption (page 9 or 10), none for the picture drawn twice with contradictory captions (7 / 8),
  // none for the uncaptioned image (5). Hashes here are the browser's own rendering of each crop.
  const questions = rows.filter((r) => r.kind === "IMAGE").map((r) => r.page).sort((a, b) => a - b);
  expect(questions).toHaveLength(2);
  expect(questions[0]).toBe(3);
  expect([9, 10]).toContain(questions[1]);
  for (const row of rows) if (row.hasImage) expect([5, 7, 8]).not.toContain(row.page);

  // Relatedness: the centrilobular micrograph illustrates the centrilobular card, not the bridging-necrosis card.
  expect(byBack("Centrilobular necrosis").hasImage).toBe(true);
  expect(rows.find((r) => r.kind !== "IMAGE" && r.back.includes("Bridging necrosis"))!.hasImage).toBe(false);

  // The same lecture in Arabic + English terms: a card differs where the vocabulary has the term.
  const mixed = await uploadLecture(page, UNSEEN, { language: "ar-en", count: "100" });
  await page.goto(`/lectures/${mixed.lectureId}`);
  const mixedRows = await cardRows(page);
  expect(byBack("Chronic hepatitis B").back).toContain("خلايا الكبد (hepatocytes)");
  expect(mixedRows.find((r) => r.back.includes("Chronic hepatitis B"))!.back).toContain("يُظهر hepatocytes");
});

test("the lecture header keeps long titles readable at this viewport: actions wrap below, nothing overlaps or overflows", async ({ page }) => {
  const { lectureId } = await uploadLecture(page, UNSEEN, { language: "en", count: "custom", custom: "4" });
  await page.goto(`/lectures/${lectureId}`);
  const titles = [
    "Cell Injury",
    "Myocardial Infarction",
    "Acute and Chronic Inflammation",
    "Hepatic Injury, Repair and Fibrosis in Alcoholic, Viral and Drug Induced Liver Disease — Integrated Clinicopathological Correlation Session",
    "Pneumonoultramicroscopicsilicovolcanoconiosis",
  ];
  // Both header states: drafts to review (Rename, Source PDF, Add a PDF, Generate more — the reported
  // overlap), and after approval (the Study action too).
  for (const [state, minButtons] of [["drafts", 4], ["approved", 5]] as const) {
    if (state === "approved") {
      await page.getByTestId("approve-all").click();
      await expect(page.getByTestId("study-link")).toBeVisible();
    }
    for (const title of titles) {
      await page.getByTestId("rename-lecture").click();
      await page.getByTestId("lecture-title-input").fill(title);
      await page.getByTestId("save-title").click();
      await expect(page.getByTestId("lecture-heading")).toHaveText(title);
      const layout = await page.evaluate(() => {
        const heading = document.querySelector('[data-testid="lecture-heading"]') as HTMLElement;
        const actions = document.querySelector('[data-testid="lecture-actions"]') as HTMLElement;
        const range = document.createRange();
        range.selectNodeContents(heading);
        const lines = [...range.getClientRects()];
        const box = heading.getBoundingClientRect();
        const buttons = [...actions.querySelectorAll("a,button")].map((b) => b.getBoundingClientRect());
        const hits = (r: DOMRect, b: DOMRect) => r.right > b.left + 0.5 && r.left < b.right - 0.5 && r.bottom > b.top + 0.5 && r.top < b.bottom - 0.5;
        return {
          overlap: lines.some((line) => buttons.some((b) => hits(line, b))),
          textOutsideHeading: lines.some((line) => line.right > box.right + 1 || line.left < box.left - 1),
          headingWidth: box.width,
          pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          buttons: buttons.length,
        };
      });
      const label = `${state}: ${title}`;
      expect(layout.buttons, label).toBe(minButtons);
      expect(layout.overlap, label).toBe(false);
      expect(layout.textOutsideHeading, label).toBe(false);
      expect(layout.pageOverflow, label).toBe(false);
      expect(layout.headingWidth, label).toBeGreaterThanOrEqual(380); // a readable column, never squeezed
    }
  }
});

test("an old card rated Again / Hard / Good / Easy is not re-inserted after a refresh before FSRS makes it due", async ({ page }) => {
  // Day 1: Cell Injury studied (Easy: Review cards, days apart).
  const cell = await uploadLecture(page, CELL_INJURY, { language: "en", count: "custom", custom: "8" });
  await page.goto(`/lectures/${cell.lectureId}`);
  await page.getByTestId("approve-all").click();
  await page.goto(`/study/${cell.lectureId}`);
  await studyAll(page, "easy");
  // Days later: they are overdue (the stored due times move into the past, as time passing does).
  await page.evaluate((key) => {
    const stored = JSON.parse(localStorage.getItem(key)!);
    for (const card of Object.values(stored.cards) as { schedule: { due: string } }[]) card.schedule.due = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
    delete stored.studyDay;
    localStorage.setItem(key, JSON.stringify(stored));
  }, CARDS_KEY);
  const inflammation = await uploadLecture(page, INFLAMMATION, { language: "en", count: "custom", custom: "8" });
  await page.goto(`/lectures/${inflammation.lectureId}`);
  await page.getByTestId("approve-all").click();

  // Study Inflammation; the first four old reviews are rated Again, Hard, Good, Easy.
  await page.goto(`/study/${inflammation.lectureId}`);
  const plan = ["again", "hard", "good", "easy"] as const;
  const rated: Record<string, string> = {};
  for (let i = 0; i < 40 && Object.keys(rated).length < 4; i++) {
    const card = page.getByTestId("study-card");
    await expect(card).toBeVisible();
    const origin = await card.getAttribute("data-origin");
    const id = (await card.getAttribute("data-item-id"))!;
    await page.getByTestId("show-answer").click();
    if (origin === "review") {
      const rating = plan[Object.keys(rated).length]!;
      expect(rated[id], "an old card shown twice before it was due").toBeUndefined();
      rated[id] = rating;
      await page.getByTestId(`rate-${rating}`).click();
    } else {
      await page.getByTestId("rate-good").click();
    }
  }
  expect(Object.values(rated)).toEqual([...plan]);
  const againId = Object.keys(rated).find((id) => rated[id] === "again")!;
  const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), CARDS_KEY);
  // Again: a relearning step minutes away (not due yet). Hard / Good / Easy: days away.
  expect(new Date(stored.cards[againId].schedule.due).getTime() - Date.now()).toBeLessThan(15 * 60_000);
  for (const [id, rating] of Object.entries(rated)) if (rating !== "again") expect(new Date(stored.cards[id].schedule.due).getTime() - Date.now(), rating).toBeGreaterThan(24 * 3_600_000);

  // Refresh (no session memory survives): none of the four comes back before it is due.
  const seenAfterRefresh = async (steps: number) => {
    await page.reload();
    const card = page.getByTestId("study-card");
    await expect(card.or(page.getByTestId("study-done")).or(page.getByTestId("study-empty")).first()).toBeVisible();
    const seen: string[] = [];
    for (let i = 0; i < steps && (await card.isVisible()); i++) {
      if ((await card.getAttribute("data-origin")) === "review") seen.push((await card.getAttribute("data-item-id"))!);
      await page.getByTestId("show-answer").click();
      await page.getByTestId("rate-good").click();
      await expect(card.or(page.getByTestId("study-done")).first()).toBeVisible();
    }
    return seen;
  };
  const afterRefresh = await seenAfterRefresh(30);
  for (const id of Object.keys(rated)) expect(afterRefresh, `${rated[id]} came back after a refresh before it was due`).not.toContain(id);

  // Time passes to the Again card's relearning step (its stored due time moves into the past): it comes back.
  await page.evaluate(([key, id]) => {
    const s = JSON.parse(localStorage.getItem(key)!);
    s.cards[id].schedule.due = new Date(Date.now() - 60_000).toISOString();
    localStorage.setItem(key, JSON.stringify(s));
  }, [CARDS_KEY, againId] as const);
  const whenDue = await seenAfterRefresh(30);
  expect(whenDue).toContain(againId);
  for (const id of Object.keys(rated)) if (id !== againId) expect(whenDue).not.toContain(id);
});
