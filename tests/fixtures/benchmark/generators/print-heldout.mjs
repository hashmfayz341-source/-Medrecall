// Prints heldout.html (written by make_heldout1.py) to ../heldout-hemodynamics-diuretics.pdf with Chromium.
// Run from this folder: node print-heldout.mjs
import { chromium } from "playwright";
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage();
await page.goto(`file://${process.cwd()}/heldout.html`);
await page.pdf({ path: "../heldout-hemodynamics-diuretics.pdf", width: "13.333in", height: "7.5in", printBackground: true });
await browser.close();
