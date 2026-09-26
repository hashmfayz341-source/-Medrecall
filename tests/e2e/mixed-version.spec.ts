import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { ANSWERS } from "../answers";
import { openOldMainTab, type OldLearnerState } from "../base-main/oldMain";

/**
 * Mixed versions in a real browser: this build's tab, plus a tab still running
 * main@482824c that writes the same origin's localStorage.
 *
 * Both builds cannot be served from one origin, so the old tab's write is
 * produced by main's REAL code (tests/base-main, taken from git): it loads the
 * current `medrecall.learner.v1` with main's own repository, makes a Tutor
 * move with main's own engine, and saves with main's own serializer. That
 * exact string is then written from a second page of the same origin (a
 * static document, so no app runs there), which fires a real `storage` event
 * in this build's tab — exactly what an old-main tab's save does.
 */

const L1 = "lecture-cell-injury";
const LK = "medrecall.learner.v1";
const SK = "medrecall.study-cards.v1";
const HYPOXIA = "c-hypoxia";
const REV = "c-reversible-irreversible";

type Card = { reviews: number; lastRating: string; lastReviewedAt: string; schedule: Record<string, unknown> };

const raw = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);
/** Card progress wherever this build keeps it (the sidecar; envelope `cards` in earlier builds). */
const storedCards = async (page: Page) => {
  const side = JSON.parse((await raw(page, SK)) ?? "null") as { cards: Record<string, Card> } | null;
  if (side) return side.cards;
  return (JSON.parse((await raw(page, LK)) ?? "null") as { cards?: Record<string, Card> } | null)?.cards ?? {};
};
const count = async (page: Page, kind: "new" | "learning" | "review") =>
  Number(await page.getByTestId(`count-${kind}`).textContent());

/** main's real code turns the stored envelope into the envelope it would save. */
async function oldMainWrite(envelope: string, action: (s: OldLearnerState, tab: Awaited<ReturnType<typeof openOldMainTab>>) => OldLearnerState) {
  const storage = new Map<string, string>([[LK, envelope]]);
  const g = globalThis as { window?: unknown };
  g.window = {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  };
  try {
    const tab = await openOldMainTab();
    const loaded = tab.load();
    expect(loaded, "main loads this build's envelope").not.toBeNull();
    expect(tab.save(action(loaded!, tab))).toBe(true);
    return storage.get(LK)!;
  } finally {
    delete g.window;
  }
}

/** A second tab of the same origin that runs no app code: it only writes. */
async function writerTab(context: BrowserContext) {
  const page = await context.newPage();
  await page.goto("/icon.svg");
  return {
    set: (key: string, value: string) => page.evaluate(([k, v]) => localStorage.setItem(k!, v!), [key, value]),
  };
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
});

test("Card FSRS survives a stale main tab's write (live storage event and reload); the next rating continues it", async ({ page, context }) => {
  await page.goto(`/study/${L1}`);
  const card = page.getByTestId("study-card");
  await expect(card).toHaveAttribute("data-item-id", "c-hypoxia-1");
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-again").click();
  await expect(card).toHaveAttribute("data-item-id", "c-rev-1");
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-easy").click();
  await expect(page.getByTestId("count-learning")).toHaveText("1");
  const cardsBefore = await storedCards(page);
  expect(Object.keys(cardsBefore).sort()).toEqual(["c-hypoxia-1", "c-rev-1"]);
  const newBefore = await count(page, "new");

  // The stale main tab answers an unrelated Tutor question and saves.
  const written = await oldMainWrite((await raw(page, LK))!, (s, tab) =>
    tab.answer(tab.markChunkTaught(s, "chunk-ci-1"), {
      conceptId: REV, itemId: "c-rev-1", answer: ANSWERS[REV]!, context: "INITIAL", chunkId: "chunk-ci-1", now: new Date(),
    }),
  );
  expect(JSON.parse(written).cards).toBeUndefined();
  await (await writerTab(context)).set(LK, written);

  // This tab saw the event and kept its cards: counts are unchanged, and its
  // next save carries main's change AND the untouched card schedules.
  await expect(page.getByTestId("count-learning")).toHaveText("1");
  expect(await count(page, "new")).toBe(newBefore);
  const next = (await card.getAttribute("data-item-id"))!;
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-good").click();
  await expect(card).not.toHaveAttribute("data-item-id", next);
  const after = await storedCards(page);
  expect(after["c-hypoxia-1"]).toEqual(cardsBefore["c-hypoxia-1"]);
  expect(after["c-rev-1"]).toEqual(cardsBefore["c-rev-1"]);
  expect(JSON.parse((await raw(page, LK))!).progress[REV].schedule.reps).toBe(1); // main's Tutor attempt kept
  expect(JSON.parse((await raw(page, LK))!).cards).toBeUndefined(); // cards live in the sidecar

  // After a reload the Again card is still in Learning (with the card just
  // rated Good), and rating it continues its schedule — a second review, not
  // a fresh New card.
  await page.reload();
  await expect(page.getByTestId("count-learning")).toHaveText("2");
  for (let i = 0; i < 20 && (await card.getAttribute("data-item-id")) !== "c-hypoxia-1"; i++) {
    await page.getByTestId("show-answer").click();
    await page.getByTestId("rate-easy").click();
  }
  await expect(card).toHaveAttribute("data-item-id", "c-hypoxia-1");
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-good").click();
  await expect(card).not.toHaveAttribute("data-item-id", "c-hypoxia-1");
  const continued = (await storedCards(page))["c-hypoxia-1"]!;
  expect(continued.reviews).toBe(2);
  expect(continued.lastRating).toBe("GOOD");
});

test("a stale main tab changing another concept does not turn a Study-origin WEAK into a Tutor remediation", async ({ page, context }) => {
  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("study-card")).toHaveAttribute("data-concept-id", HYPOXIA);
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-again").click();
  await expect(page.getByTestId("count-learning")).toHaveText("1");

  await page.goto(`/learn/${L1}`);
  await page.getByTestId("teach-continue").click();
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", HYPOXIA);
  await page.getByTestId("answer-input").fill(ANSWERS[HYPOXIA]!);
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("feedback-correct")).toBeVisible();
  await page.getByTestId("continue-button").click();
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", REV);

  // The stale main tab answers REV (its question was already on screen there).
  const written = await oldMainWrite((await raw(page, LK))!, (s, tab) =>
    tab.answer(s, { conceptId: REV, itemId: "c-rev-1", answer: ANSWERS[REV]!, context: "INITIAL", chunkId: "chunk-ci-1", now: new Date() }),
  );
  await (await writerTab(context)).set(LK, written);

  await page.reload();
  await expect(page.getByTestId("step-teach")).toBeVisible();
  await expect(page.getByTestId("step-remediate")).toHaveCount(0);
});

test("a remediation the stale main tab completed is not resurrected", async ({ page, context }) => {
  await page.goto(`/learn/${L1}`);
  await page.getByTestId("teach-continue").click();
  await page.getByTestId("answer-input").fill("I do not remember this at all");
  await page.getByTestId("submit-answer").click();
  await expect(page.getByTestId("feedback-incorrect")).toBeVisible();
  await page.getByTestId("continue-button").click();
  await expect(page.getByTestId("step-remediate")).toHaveAttribute("data-concept-id", HYPOXIA);

  const written = await oldMainWrite((await raw(page, LK))!, (s, tab) =>
    tab.answer(s, { conceptId: HYPOXIA, itemId: "c-hypoxia-2", answer: ANSWERS[HYPOXIA]!, context: "IMMEDIATE_REMEDIATION", chunkId: "chunk-ci-1", now: new Date() }),
  );
  await (await writerTab(context)).set(LK, written);

  await page.reload();
  await expect(page.getByTestId("step-retrieve")).toHaveAttribute("data-concept-id", REV);
  await expect(page.getByTestId("step-remediate")).toHaveCount(0);
});

test("a Study sidecar change made in another tab is visible here (sidecar-only storage event)", async ({ page, context }) => {
  await page.goto(`/study/${L1}`);
  const newAtStart = await count(page, "new");
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-again").click();
  await expect(page.getByTestId("count-learning")).toHaveText("1");
  expect(await count(page, "new")).toBe(newAtStart - 1);

  // Another tab writes ONLY the sidecar: no card progress at all.
  await (await writerTab(context)).set(SK, JSON.stringify({ version: 1, cards: {} }));
  await expect(page.getByTestId("count-learning")).toHaveText("0");
  expect(await count(page, "new")).toBe(newAtStart);
});

test("Reset clears the learner envelope AND the Study sidecar: no ghost card schedules", async ({ page }) => {
  await page.goto(`/study/${L1}`);
  await page.getByTestId("show-answer").click();
  await page.getByTestId("rate-again").click();
  await expect(page.getByTestId("count-learning")).toHaveText("1");

  await page.goto("/");
  await page.getByTestId("reset-demo").click();
  await expect.poll(() => raw(page, LK)).toBeNull();

  await page.goto(`/study/${L1}`);
  await expect(page.getByTestId("count-learning")).toHaveText("0");
  expect(await raw(page, SK)).toBeNull();
});
