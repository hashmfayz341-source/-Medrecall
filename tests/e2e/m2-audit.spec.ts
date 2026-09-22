import { expect, test, type Page } from "@playwright/test";
import { makePdf } from "../fixtures/make-pdf";
import { pathologyCurriculum } from "../../src/lib/content/pathology";
import { createLearnerState, markChunkTaught, recordAttempt } from "../../src/lib/engine/tutor";
import { ANSWERS } from "../answers";

const L1 = "lecture-cell-injury";
const CK = "medrecall.curriculum.v1";
const LK = "medrecall.learner.v1";
const fixture = Buffer.from(makePdf([["Audit concepts", "Hypoxia is the approved audit statement.", "Necrosis is the unapproved secret statement.", "Apoptosis is the discarded secret statement."]]));

async function upload(page: Page, lecture = L1, name = "audit.pdf", buffer = fixture) {
  await page.goto("/ingest");
  await page.getByTestId("lecture-select").selectOption(lecture);
  await page.getByTestId("pdf-input").setInputFiles({ name, mimeType: "application/pdf", buffer });
  await page.getByTestId("extract-button").click();
  await expect(page.getByTestId("ingest-result")).toBeVisible();
  const documentId = (await page.getByTestId("ingest-result").getAttribute("data-document-id"))!;
  await page.getByTestId("go-review").click();
  return documentId;
}

async function completeAuthoredMaterial(page: Page) {
  let learner = createLearnerState();
  const lecture = pathologyCurriculum.course.lectures.find(l => l.id === L1)!;
  for (const chunk of lecture.chunks) learner = markChunkTaught(pathologyCurriculum, learner, chunk.id);
  for (const concept of pathologyCurriculum.concepts.filter(c => c.lectureId === L1 && c.status === "ACTIVE")) {
    learner = recordAttempt(pathologyCurriculum, learner, { conceptId: concept.id, itemId: concept.retrievalItems[0]!.id, answer: ANSWERS[concept.id]!, context: "INITIAL", now: new Date() }).learner;
  }
  await page.evaluate(({ key, learner }) => localStorage.setItem(key, JSON.stringify(learner)), { key: LK, learner });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("partial approval hides unapproved prose in the entire teaching screen", async ({ page }) => {
  const doc = await upload(page);
  await page.getByTestId(`approve-${doc}-p1-c0`).click();
  await page.getByTestId(`discard-${doc}-p1-c2`).click();
  await completeAuthoredMaterial(page);
  await page.goto(`/learn/${L1}`);
  const teaching = page.getByTestId("step-teach");
  await expect(teaching).toContainText("approved audit statement");
  await expect(teaching).not.toContainText("unapproved secret statement");
  await expect(teaching).not.toContainText("discarded secret statement");
  await page.reload();
  await expect(teaching).not.toContainText("unapproved secret statement");
});

test("single-field edits retain other text and cannot approve unsaved changes", async ({ page }) => {
  const doc = await upload(page);
  const id = `${doc}-p1-c0`;
  const original = await page.getByTestId(`summary-input-${id}`).inputValue();
  await page.getByTestId(`title-input-${id}`).fill("Oxygen deficiency");
  await expect(page.getByTestId(`summary-input-${id}`)).toHaveValue(original);
  await expect(page.getByTestId(`approve-${id}`)).toBeDisabled();
  await expect(page.getByTestId("bulk-approve")).toBeDisabled();
  await page.getByTestId(`summary-input-${id}`).fill("Oxygen deficiency is the corrected audit statement.");
  await page.getByTestId(`save-${id}`).click();
  await expect(page.getByTestId(`concept-${id}`)).toHaveAttribute("data-status", "DRAFT");
  await page.getByTestId(`approve-${id}`).click();
  await completeAuthoredMaterial(page);
  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-teach")).toContainText("corrected audit statement");
  await page.getByTestId("teach-continue").click();
  await page.getByTestId("answer-input").fill("Oxygen deficiency");
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("feedback-correct")).toBeVisible();
  await expect(page.getByTestId("feedback")).toContainText("corrected audit statement");
});

test("the same file can belong to two lectures without moving or inheriting approval", async ({ page }) => {
  const first = await upload(page);
  await page.getByTestId(`approve-${first}-p1-c0`).click();
  const second = await upload(page, "lecture-inflammation");
  expect(second).not.toBe(first);
  await expect(page.getByTestId(`concept-${second}-p1-c0`)).toHaveAttribute("data-status", "DRAFT");
  await page.reload();
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), CK);
  expect(stored.ingested).toHaveLength(2);
  expect(stored.statusById[`${first}-p1-c0`]).toBe("ACTIVE");
  expect(stored.statusById[`${second}-p1-c0`]).toBeUndefined();
});

test("switching status clears a page filter that would hide the next result", async ({ page }) => {
  const doc = await upload(page, L1, "two-pages.pdf", Buffer.from(makePdf([["Hypoxia is the first page statement."], ["Necrosis is the second page statement."]])));
  await page.getByTestId("page-filter").selectOption("2");
  await page.getByTestId(`discard-${doc}-p2-c0`).click();
  await page.getByTestId("filter-ACTIVE").click();
  await expect(page.getByTestId("page-filter")).toHaveValue("");
  await page.getByTestId("filter-DRAFT").click();
  await expect(page.getByTestId(`concept-${doc}-p1-c0`)).toBeVisible();
});

test("quota failure is visible, and a missing lecture does not crash the page", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new DOMException("Full", "QuotaExceededError"); };
  });
  await upload(page);
  await expect(page.getByTestId("storage-error")).toBeVisible();
  await page.goto("/learn/missing-audit-lecture");
  await expect(page.getByRole("heading", { name: "Lecture not found" })).toBeVisible();
});

test("another tab returning a concept to draft removes it from teaching", async ({ page, context }) => {
  const doc = await upload(page);
  const id = `${doc}-p1-c0`;
  await page.getByTestId(`approve-${id}`).click();
  await completeAuthoredMaterial(page);
  await page.goto(`/learn/${L1}`);
  await expect(page.getByTestId("step-teach")).toBeVisible();
  const review = await context.newPage();
  await review.goto(`/concepts?document=${doc}`);
  await review.getByTestId("filter-ACTIVE").click();
  await review.getByTestId(`draft-${id}`).click();
  await expect(page.getByTestId("step-awaiting-approval")).toBeVisible();
  await expect(page.getByTestId("step-teach")).toHaveCount(0);
  await review.close();
});

test("iPad portrait review keeps source, filters and touch controls reachable", async ({ page }) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  const doc = await upload(page);
  const id = `${doc}-p1-c0`;
  await page.getByTestId(`source-${id}`).locator("summary").click();
  await expect(page.getByTestId(`excerpt-${id}`)).toContainText("approved audit statement");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const target of ["bulk-approve", `approve-${id}`, `discard-${id}`, "document-filter", "page-filter"]) {
    const box = await page.getByTestId(target).boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});
