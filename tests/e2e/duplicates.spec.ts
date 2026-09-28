import { expect, test, type Page } from "@playwright/test";
import { makePdf } from "../fixtures/make-pdf";

/**
 * Duplicate candidates across documents: suggested in Review drafts, merged
 * or kept apart by the reviewer, undoable, persisted; a merged duplicate has
 * no Study cards and its source becomes extra provenance on the canonical.
 */

const L1 = "lecture-cell-injury";
const L2 = "lecture-inflammation";
const SENTENCE = "Karyolysis is the fading of nuclear basophilia.";

async function upload(page: Page, lecture: string, name: string, pages: string[][]) {
  await page.goto("/ingest");
  await page.getByTestId("lecture-select").selectOption(lecture);
  await page.getByTestId("pdf-input").setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.from(makePdf(pages)) });
  await page.getByTestId("extract-button").click();
  await expect(page.getByTestId("ingest-result")).toBeVisible({ timeout: 30_000 });
  return (await page.getByTestId("ingest-result").getAttribute("data-document-id"))!;
}

const deckTotal = async (page: Page, lecture: string) =>
  Number((await page.getByTestId(`deck-total-${lecture}`).textContent())!.match(/\d+/)![0]);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("a candidate repeated in a second document is suggested as a duplicate; merging discards it, keeps its provenance, and is undoable", async ({ page }) => {
  const docA = await upload(page, L1, "recap-a.pdf", [["Recap A", SENTENCE, "Pyknosis is the condensation of nuclear chromatin."]]);
  const docB = await upload(page, L2, "recap-b.pdf", [["Recap B", SENTENCE]]);
  const canonical = `${docA}-p1-c0`;
  const duplicate = `${docB}-p1-c0`;

  await page.goto("/concepts");
  await expect(page.getByTestId(`concept-${duplicate}`)).toHaveAttribute("data-status", "DRAFT");
  const suggestion = page.getByTestId(`duplicate-${duplicate}`);
  await expect(suggestion).toBeVisible();
  await expect(suggestion).toHaveAttribute("data-canonical", canonical);
  await expect(suggestion).toContainText("same title");
  // The earlier one is the suggested survivor, so it carries no suggestion itself.
  await expect(page.getByTestId(`duplicate-${canonical}`)).toHaveCount(0);
  await expect(page.getByTestId(`duplicate-${docA}-p1-c1`)).toHaveCount(0);

  await page.getByTestId(`merge-${duplicate}`).click();
  // Out of DRAFT, into DISCARDED as "merged"; the canonical is still a draft.
  await expect(page.getByTestId(`concept-${duplicate}`)).toHaveCount(0);
  await expect(page.getByTestId(`concept-${canonical}`)).toHaveAttribute("data-status", "DRAFT");
  await page.getByTestId(`source-${canonical}`).locator("summary").click();
  await expect(page.getByTestId(`also-source-${canonical}`)).toContainText("page 1");
  await expect(page.getByTestId(`also-source-${canonical}`)).toContainText(SENTENCE);

  await page.getByTestId("filter-DISCARDED").click();
  await expect(page.getByTestId(`concept-${duplicate}`)).toHaveAttribute("data-status", "DISCARDED");
  await expect(page.getByTestId(`merged-into-${duplicate}`)).toHaveText("Karyolysis");

  // Persisted.
  await page.reload();
  await page.getByTestId("filter-DISCARDED").click();
  await expect(page.getByTestId(`merged-${duplicate}`)).toBeVisible();

  // Approving the canonical gives Lecture 1 its cards; Lecture 2 gets none from the duplicate.
  await page.goto("/study");
  const l1Before = await deckTotal(page, L1);
  const l2Before = await deckTotal(page, L2);
  await page.goto("/concepts");
  await page.getByTestId(`approve-${canonical}`).click();
  await page.goto("/study");
  expect(await deckTotal(page, L1)).toBe(l1Before + 2);
  expect(await deckTotal(page, L2)).toBe(l2Before);
  await page.goto("/study/browse");
  await expect(page.getByTestId(`card-row-${canonical}-r1`)).toBeVisible();
  await expect(page.getByTestId(`card-row-${duplicate}-r1`)).toHaveCount(0);
  // The Study card carries the extra provenance.
  await page.goto(`/study/${L1}`);
  for (let i = 0; i < 40; i++) {
    const card = page.getByTestId("study-card");
    await expect(card).toBeVisible();
    if ((await card.getAttribute("data-concept-id")) === canonical) break;
    await page.getByTestId("show-answer").click();
    await page.getByTestId("rate-easy").click();
  }
  await page.getByTestId("show-answer").click();
  await expect(page.getByTestId("card-also-sources")).toContainText("page 1");

  // Undo: back to DRAFT, never straight to ACTIVE; the suggestion returns.
  await page.goto("/concepts");
  await page.getByTestId("filter-DISCARDED").click();
  await page.getByTestId(`unmerge-${duplicate}`).click();
  await page.getByTestId("filter-DRAFT").click();
  await expect(page.getByTestId(`concept-${duplicate}`)).toHaveAttribute("data-status", "DRAFT");
  await expect(page.getByTestId(`duplicate-${duplicate}`)).toBeVisible();
  await expect(page.getByTestId(`duplicate-${duplicate}`)).toContainText("ACTIVE"); // the canonical is approved now

  // Keep both: the suggestion is gone and stays gone.
  await page.getByTestId(`keep-apart-${duplicate}`).click();
  await expect(page.getByTestId(`duplicate-${duplicate}`)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId(`concept-${duplicate}`)).toBeVisible();
  await expect(page.getByTestId(`duplicate-${duplicate}`)).toHaveCount(0);
});

test("a stale tab cannot undo a merge: its unrelated edit lands, its Keep both is ignored, the duplicate stays merged", async ({ page, context }) => {
  const docA = await upload(page, L1, "recap-a.pdf", [["Recap A", SENTENCE, "Pyknosis is the condensation of nuclear chromatin."]]);
  const docB = await upload(page, L2, "recap-b.pdf", [["Recap B", SENTENCE]]);
  const canonical = `${docA}-p1-c0`;
  const duplicate = `${docB}-p1-c0`;
  const unrelated = `${docA}-p1-c1`;

  // Both were approved before anyone noticed the duplicate, as in the report;
  // the earlier lecture's concept is the suggested survivor.
  await page.goto("/concepts");
  await page.getByTestId(`approve-${canonical}`).click();
  await page.getByTestId(`approve-${duplicate}`).click();
  await page.getByTestId("filter-ACTIVE").click();
  await expect(page.getByTestId(`duplicate-${duplicate}`)).toHaveAttribute("data-canonical", canonical);

  // Two more tabs open the review page now, then miss tab A's storage event
  // (a throttled background tab, or a write racing the event) and keep the
  // pre-merge snapshot.
  const openStale = async () => {
    const tab = await context.newPage();
    await tab.goto("/concepts");
    await tab.getByTestId("filter-ACTIVE").click();
    await expect(tab.getByTestId(`duplicate-${duplicate}`)).toBeVisible();
    // Make every storage event look unrelated to this tab, so it never syncs.
    await tab.evaluate(() => Object.defineProperty(StorageEvent.prototype, "key", { get: () => "e2e-missed-event" }));
    return tab;
  };
  const editor = await openStale();
  const rejecter = await openStale();

  // Tab A merges.
  await page.getByTestId(`merge-${duplicate}`).click();
  await expect(page.getByTestId(`concept-${duplicate}`)).toHaveCount(0);

  // The stale tabs still show the duplicate as ACTIVE with its suggestion…
  await expect(editor.getByTestId(`concept-${duplicate}`)).toHaveAttribute("data-status", "ACTIVE");
  await expect(rejecter.getByTestId(`duplicate-${duplicate}`)).toBeVisible();
  // …one edits an unrelated draft, the other rejects the (already merged) suggestion.
  await editor.getByTestId("filter-DRAFT").click();
  await editor.getByTestId(`title-input-${unrelated}`).fill("Pyknosis (edited in a stale tab)");
  await editor.getByTestId(`save-${unrelated}`).click();
  await rejecter.getByTestId(`keep-apart-${duplicate}`).click();
  // Their own write brings each stale tab up to date: the duplicate is merged there too.
  await expect(rejecter.getByTestId(`concept-${duplicate}`)).toHaveCount(0);
  await editor.getByTestId("filter-DISCARDED").click();
  await expect(editor.getByTestId(`merged-${duplicate}`)).toBeVisible();
  await editor.close();
  await rejecter.close();

  // Reload: the merge stands, the unrelated edit survived.
  await page.reload();
  await page.getByTestId("filter-DISCARDED").click();
  await expect(page.getByTestId(`concept-${duplicate}`)).toHaveAttribute("data-status", "DISCARDED");
  await expect(page.getByTestId(`merged-${duplicate}`)).toBeVisible();
  await page.getByTestId("filter-DRAFT").click();
  await expect(page.getByTestId(`title-input-${unrelated}`)).toHaveValue("Pyknosis (edited in a stale tab)");
  await page.getByTestId("filter-ACTIVE").click();
  await expect(page.getByTestId(`concept-${duplicate}`)).toHaveCount(0);

  // The stale Keep both was not recorded: undoing the merge brings the suggestion back.
  await page.getByTestId("filter-DISCARDED").click();
  await page.getByTestId(`unmerge-${duplicate}`).click();
  await page.getByTestId("filter-DRAFT").click();
  await expect(page.getByTestId(`concept-${duplicate}`)).toHaveAttribute("data-status", "DRAFT");
  await expect(page.getByTestId(`duplicate-${duplicate}`)).toBeVisible();
});

test("one malformed stored merge entry does not make the uploaded document disappear", async ({ page }) => {
  const docA = await upload(page, L1, "recap-a.pdf", [["Recap A", SENTENCE, "Pyknosis is the condensation of nuclear chromatin."]]);
  const docB = await upload(page, L2, "recap-b.pdf", [["Recap B", SENTENCE]]);
  const canonical = `${docA}-p1-c0`;
  const duplicate = `${docB}-p1-c0`;
  await page.goto("/concepts");
  await page.getByTestId(`merge-${duplicate}`).click();
  await expect(page.getByTestId(`concept-${duplicate}`)).toHaveCount(0);

  // Corrupt one merge entry and one derived field in storage, as a buggy or
  // older writer might.
  await page.evaluate(([dup]) => {
    const key = "medrecall.curriculum.v1";
    const stored = JSON.parse(localStorage.getItem(key)!);
    stored.merges.junk = 42;
    stored.concepts[0].additionalSources = [null, { documentId: 5 }];
    stored.concepts[0].mergedInto = 7;
    localStorage.setItem(key, JSON.stringify(stored));
    void dup;
  }, [duplicate]);
  await page.reload();

  // Everything valid is still there: both documents, the merge, the drafts.
  await expect(page.getByTestId(`concept-${canonical}`)).toHaveAttribute("data-status", "DRAFT");
  await page.getByTestId("filter-DISCARDED").click();
  await expect(page.getByTestId(`merged-${duplicate}`)).toBeVisible();
  const cleaned = await page.evaluate(() => JSON.parse(localStorage.getItem("medrecall.curriculum.v1")!));
  expect(cleaned.merges).toEqual({ [duplicate]: canonical });
  expect(cleaned.ingested).toHaveLength(2);
  expect(cleaned.concepts[0]).not.toHaveProperty("additionalSources");
  expect(cleaned.concepts[0]).not.toHaveProperty("mergedInto");
  // The Tutor still teaches the lecture whose document carried the bad fields.
  await page.getByTestId("filter-DRAFT").click();
  await page.getByTestId(`approve-${canonical}`).click();
  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-teach")).toBeVisible();
});

test("the authored course and a single upload produce no suggestions; nothing is ever merged automatically", async ({ page }) => {
  await upload(page, L1, "single.pdf", [["Single", "Apoptosis is programmed cell death.", "Necrosis is uncontrolled cell death."]]);
  await page.goto("/concepts");
  await expect(page.locator('[data-testid^="concept-"]').first()).toBeVisible();
  await expect(page.locator('[data-testid^="duplicate-"]')).toHaveCount(0);
  await expect(page.locator('[data-testid^="merged-"]')).toHaveCount(0);
});
