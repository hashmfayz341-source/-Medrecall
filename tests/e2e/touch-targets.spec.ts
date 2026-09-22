import { expect, test } from "@playwright/test";

/**
 * iPad-first means every interactive element must be comfortably tappable.
 * The audit flagged header links and "Save and exit" as below the 44px
 * minimum; this measures the rendered boxes rather than reading the CSS.
 */
const MIN = 44;

const pages = ["/", "/ingest", "/concepts"];

for (const path of pages) {
  test(`interactive targets on ${path} are at least ${MIN}px tall`, async ({ page }) => {
    await page.goto(path);
    await page.evaluate(() => window.localStorage.clear());
    await page.reload();

    const targets = page.locator("a, button, select, summary");
    const count = await targets.count();
    expect(count).toBeGreaterThan(0);

    const tooSmall: string[] = [];
    for (let i = 0; i < count; i++) {
      const el = targets.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox();
      if (!box) continue;
      if (box.height < MIN) {
        tooSmall.push(`${(await el.innerText().catch(() => "?")).slice(0, 40)} → ${Math.round(box.height)}px`);
      }
    }
    expect(tooSmall, `targets under ${MIN}px on ${path}`).toEqual([]);
  });
}

test("the learning session's controls are tappable", async ({ page }) => {
  await page.goto("/learn/lecture-cell-injury");
  await expect(page.getByTestId("step-teach")).toBeVisible();

  for (const testId of ["teach-continue"]) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box!.height, testId).toBeGreaterThanOrEqual(MIN);
  }

  await page.getByTestId("teach-continue").click();
  await expect(page.getByTestId("step-retrieve")).toBeVisible();

  const save = page.getByRole("link", { name: "Save and exit" });
  expect((await save.boundingBox())!.height).toBeGreaterThanOrEqual(MIN);
  expect((await page.getByTestId("submit-answer").boundingBox())!.height).toBeGreaterThanOrEqual(MIN);
});
