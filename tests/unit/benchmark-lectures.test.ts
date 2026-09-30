import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { generateCards, type GeneratedCards } from "@/lib/generation/generate";
import { excerptOnPage } from "@/lib/generation/targets";
import { extractPdfPages, type ExtractedDocument } from "@/lib/ingestion/pdf";
import { analyzeOperatorList, annotateFigures, selectFigures, type OpsTable, type PageVisualAnalysis, type PageVisuals, type PositionedText } from "@/lib/visuals/analyze";

/**
 * The trusted-cards benchmark, as a regression test: five lecture PDFs from
 * three different producers (PowerPoint decks exported by LibreOffice, HTML
 * slides printed by Chromium, a two-column reportlab handout; see
 * tests/fixtures/README.md), through the real extraction, figure analysis and
 * generation. On every card of a 60-card request:
 *
 * - the excerpt is verbatim text of one block of its page, never a merge;
 * - a question is about one drug at most, and every drug on a card is named
 *   in the card's own excerpt (no cross-drug attribution);
 * - no card comes from a lecturer question or a caption line;
 * - a picture never goes on a card about the opposite subtype (wet/dry,
 *   papillary/follicular, type 1/type 2, left/right, …);
 * - 20 ⊂ 40 ⊂ 60, and the first 20 cards already reach every section.
 *
 * Plus a few exact cards per lecture, and a floor on the number of cards, so
 * a regression in coverage shows.
 */

const DIR = "tests/fixtures/benchmark";

async function visualsOf(file: string): Promise<PageVisuals[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(file)), useWorkerFetch: false, useSystemFonts: false, disableFontFace: true });
  const doc = await task.promise;
  const analyses: PageVisualAnalysis[] = [];
  const texts = new Map<number, PositionedText[]>();
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      analyses.push(analyzeOperatorList(await page.getOperatorList(), pdfjs.OPS as unknown as OpsTable, { pageNumber: n, width: viewport.width, height: viewport.height }));
      texts.set(n, ((await page.getTextContent()).items as unknown as PositionedText[]).filter((i) => typeof i.str === "string"));
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }
  return selectFigures(analyses).map((v) => ({ ...v, figures: annotateFigures(v.figures, texts.get(v.pageNumber) ?? [], analyses[v.pageNumber - 1]!) }));
}

interface Lecture {
  file: string;
  drugs: string[];
  minimum: number;
  golden: [question: string, answer: string][];
}

const LECTURES: Lecture[] = [
  {
    file: "cell-injury.pdf",
    drugs: [],
    minimum: 50,
    golden: [
      ["What is the most common cause of cell injury?", "Oxygen deprivation (hypoxia)"],
      ["What are the two patterns of cell death?", "Necrosis and apoptosis"],
      ["What is the key feature of caseous necrosis?", "Friable, cheese-like white material"],
      ["What does the extrinsic pathway activate?", "Caspase-8"],
      ["Compare the plasma membrane in necrosis and apoptosis.", "Necrosis: Disrupted; Apoptosis: Intact"],
    ],
  },
  {
    file: "autonomic-pharmacology.pdf",
    drugs: ["bethanechol", "pilocarpine", "neostigmine", "physostigmine", "pralidoxime", "atropine", "ipratropium", "scopolamine", "epinephrine", "norepinephrine", "dobutamine", "phenylephrine", "albuterol", "clonidine", "amphetamine", "cocaine", "prazosin", "phenoxybenzamine", "propranolol", "metoprolol", "timolol"],
    minimum: 60,
    golden: [
      ["What is the G protein of M2?", "Gi"],
      ["What is pilocarpine used to treat?", "Glaucoma"],
      ["What does atropine cause?", "Mydriasis"],
      ["What does clonidine decrease?", "Sympathetic outflow from the brainstem"],
      ["What is the main adverse effect of prazosin?", "First-dose orthostatic hypotension"],
      ["List: Muscarinic signs of organophosphate poisoning", "Diarrhea; Urination; Miosis; Bronchospasm; Bradycardia; Lacrimation; Salivation"],
    ],
  },
  {
    file: "pathology-images.pdf",
    drugs: [],
    minimum: 25,
    golden: [
      ["What most often causes right-sided heart failure?", "Left-sided heart failure"],
      ["What is chronic inflammation characterized by?", "Lymphocytes, plasma cells and macrophages"],
    ],
  },
  {
    file: "heldout-hemodynamics-diuretics.pdf",
    drugs: ["furosemide", "hydrochlorothiazide", "spironolactone", "amiloride", "acetazolamide", "mannitol"],
    minimum: 35,
    golden: [
      ["What is the mechanism of septic shock?", "Peripheral vasodilation and pooling of blood"],
      ["What does hydrochlorothiazide decrease?", "Urinary calcium excretion"],
    ],
  },
  {
    file: "heldout2-neoplasia-anticoagulants.pdf",
    drugs: ["heparin", "warfarin", "enoxaparin", "rivaroxaban", "aspirin", "clopidogrel", "abciximab", "alteplase", "dabigatran"],
    minimum: 38,
    golden: [
      ["What does warfarin inhibit?", "Vitamin K epoxide reductase"],
      ["What is the antidote of dabigatran?", "Idarucizumab"],
      ["What do sarcomas typically spread through?", "The blood"],
    ],
  },
];

/** Opposite subtypes: a picture of one never illustrates a card about the other. */
const OPPOSITES: [RegExp, RegExp][] = [
  [/\bwet\b/i, /\bdry\b/i],
  [/\bpapillary\b/i, /\bfollicular\b/i],
  [/\btype 1\b/i, /\btype 2\b/i],
  [/\bleft-sided\b/i, /\bright-sided\b/i],
  [/\bnormal liver\b/i, /\bcirrho/i],
  [/\bacute\b/i, /\bchronic\b/i],
  [/\barterial\b/i, /\bvenous\b/i],
  [/\bwhite infarct/i, /\bred infarct/i],
  [/\badenoma\b/i, /\badenocarcinoma\b/i],
  [/\bleiomyoma\b/i, /\bleiomyosarcoma\b/i],
];

const loaded = new Map<string, { document: ExtractedDocument; visuals: PageVisuals[] }>();
beforeAll(async () => {
  for (const lecture of LECTURES) {
    const path = `${DIR}/${lecture.file}`;
    loaded.set(lecture.file, { document: await extractPdfPages(new Uint8Array(readFileSync(path)), lecture.file, { courseId: "c", lectureId: "l" }), visuals: await visualsOf(path) });
  }
}, 120_000);

function run(file: string, count: number): GeneratedCards {
  const { document, visuals } = loaded.get(file)!;
  return generateCards({ courseId: "c", lectureId: "l", documents: [{ id: document.id, title: document.title, pages: document.pages, visuals }], language: "en", count, existing: [] });
}

describe.each(LECTURES)("benchmark lecture $file", (lecture) => {
  it("every excerpt is verbatim text of one block; no card from a question or a caption", () => {
    const { document } = loaded.get(lecture.file)!;
    const out = run(lecture.file, 60);
    expect(out.concepts.length).toBeGreaterThanOrEqual(Math.min(60, lecture.minimum));
    for (const c of out.concepts) {
      const item = c.retrievalItems[0]!;
      const page = document.pages.find((p) => p.number === c.source.pageNumber)!;
      expect(page.layout).toBe("blocks");
      expect(excerptOnPage(c.source.excerpt, page), c.source.excerpt).toBe(true);
      expect(c.source.excerpt.trim().endsWith("?"), c.source.excerpt).toBe(false);
      if (item.kind !== "IMAGE") expect(/^\s*(fig(ure)?|table)\.?\s*\d/i.test(c.source.excerpt), c.source.excerpt).toBe(false);
    }
  });

  it("no cross-drug attribution: a card names at most one drug, and only one its excerpt names", () => {
    const out = run(lecture.file, 60);
    const named = (text: string) => lecture.drugs.filter((d) => new RegExp(`\\b${d}\\b`, "i").test(text));
    for (const c of out.concepts) {
      const item = c.retrievalItems[0]!;
      // The question is about one drug at most ("norepinephrine" may still be in an answer as a transmitter).
      expect(named(item.prompt).length, item.prompt).toBeLessThanOrEqual(1);
      for (const drug of named(`${item.prompt} ${item.explanation}`)) expect(named(c.source.excerpt), `${item.prompt} ← ${c.source.excerpt}`).toContain(drug);
    }
  });

  it("no picture on a card about the opposite subtype; no shared or table caption as an image answer", () => {
    const { visuals } = loaded.get(lecture.file)!;
    const out = run(lecture.file, 60);
    for (const c of out.concepts) {
      const item = c.retrievalItems[0]!;
      if (!item.image) continue;
      const index = Number(item.image.assetId.split("#f").pop());
      const caption = visuals.find((v) => v.pageNumber === item.image!.pageNumber)?.figures[index]?.caption ?? "";
      const card = `${item.prompt} ${item.explanation} ${item.image.placement === "back" ? c.source.excerpt : ""}`;
      for (const [a, b] of OPPOSITES) {
        if (a.test(caption) && !a.test(card)) expect(b.test(card), `${caption} on "${item.prompt}"`).toBe(false);
        if (b.test(caption) && !b.test(card)) expect(a.test(card), `${caption} on "${item.prompt}"`).toBe(false);
      }
      if (item.kind === "IMAGE") expect(/\((left|right)\)|^\s*table/i.test(caption), caption).toBe(false);
    }
  });

  it("20 ⊂ 40 ⊂ 60, and 20 cards already reach every page that has cards", () => {
    const ids = (n: number) => new Set(run(lecture.file, n).concepts.map((c) => c.id));
    const [twenty, forty, sixty] = [ids(20), ids(40), ids(60)];
    for (const id of twenty) expect(forty.has(id)).toBe(true);
    for (const id of forty) expect(sixty.has(id)).toBe(true);
    const pages = (n: number) => new Set(run(lecture.file, n).concepts.map((c) => c.source.pageNumber));
    expect(pages(20)).toEqual(pages(60));
  });

  it("Arabic modes: every card counted (Arabic or Partly English), and never 'ما هو <an English phrase>؟'", () => {
    const { document, visuals } = loaded.get(lecture.file)!;
    for (const language of ["ar", "ar-en"] as const) {
      const out = generateCards({ courseId: "c", lectureId: "l", documents: [{ id: document.id, title: document.title, pages: document.pages, visuals }], language, count: 60, existing: [] });
      expect(out.coverage.arabic + out.coverage.partial).toBe(out.concepts.length);
      for (const c of out.concepts) {
        const wrapped = /^ما هو (.+)؟$/.exec(c.retrievalItems[0]!.prompt)?.[1] ?? "";
        expect(wrapped.replace(/\([^)]*\)/g, " ").split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).length, c.retrievalItems[0]!.prompt).toBeLessThanOrEqual(4);
      }
    }
  });

  it("exact cards", () => {
    const out = run(lecture.file, 100);
    const cards = new Map(out.concepts.map((c) => [c.retrievalItems[0]!.prompt, c.retrievalItems[0]!.explanation]));
    for (const [question, answer] of lecture.golden) expect(cards.get(question), question).toBe(answer);
  });
});
