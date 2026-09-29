import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Concept, Page } from "@/lib/domain/types";
import { renderPhrase } from "@/lib/generation/arabic";
import { generateCards, type GeneratedCards } from "@/lib/generation/generate";
import { hasArabic } from "@/lib/generation/language";
import { extractPdfPages } from "@/lib/ingestion/pdf";
import {
  analyzeOperatorList,
  annotateFigures,
  averageHash,
  figureAssetId,
  hashDistance,
  sameImage,
  selectFigures,
  type FigureCandidate,
  type OpsTable,
  type PageVisualAnalysis,
  type PageVisuals,
  type PositionedText,
} from "@/lib/visuals/analyze";
import { IMAGES, SLIDES, UNSEEN_FILE, buildUnseenPdf, syntheticImage } from "../../scripts/make-unseen-fixture.mjs";

/**
 * Merge-gate regression on an UNSEEN lecture (scripts/make-unseen-fixture.mjs):
 * hepatic pathology, written independently of the Cell Injury / Inflammation
 * fixtures the generator was developed on. Nothing in production code knows
 * these sentences; every expectation is a general rule.
 *
 * 1. Arabic: cards whose English sentence structure could not be translated
 *    are reported partial (never "Arabic"); context-dependent words keep
 *    their meaning ("most specific", "by two weeks", "within twelve hours",
 *    "within canaliculi").
 * 2. Repeated images: the same picture re-rendered at another size matches
 *    (a few bits apart); a picture with contradictory captions gets no
 *    question; agreeing copies get exactly one.
 * 3. Image-to-card relatedness: a generic shared word ("necrosis") never
 *    attaches an image; the card naming the figure's subject does get it.
 */

const FILE = `tests/fixtures/${UNSEEN_FILE}`;
const COURSE = "course-unseen";
const LECTURE = "lecture-unseen";

/* ------------------------------------------------------------------ */
/* Rendering simulation: the browser draws each figure crop at its size */
/* ------------------------------------------------------------------ */

/** Bilinear resample of an RGB bitmap to an RGBA canvas-like buffer of the given size (what drawing it at that size does). */
function resample(rgb: Uint8Array | Buffer, w: number, h: number, W: number, H: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(h - 1, Math.max(0, ((y + 0.5) * h) / H - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.max(0, ((x + 0.5) * w) / W - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), fx = sx - x0;
      for (let c = 0; c < 3; c++) {
        const p = (yy: number, xx: number) => rgb[(yy * w + xx) * 3 + c]!;
        const top = p(y0, x0) * (1 - fx) + p(y0, x1) * fx;
        const bottom = p(y1, x0) * (1 - fx) + p(y1, x1) * fx;
        out[(y * W + x) * 4 + c] = top * (1 - fy) + bottom * fy;
      }
      out[(y * W + x) * 4 + 3] = 255;
    }
  }
  return out;
}

/** Nearest-neighbour resample (a renderer with smoothing off). */
function nearest(rgb: Uint8Array | Buffer, w: number, h: number, W: number, H: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / W)), sy = Math.min(h - 1, Math.floor((y * h) / H));
      for (let c = 0; c < 3; c++) out[(y * W + x) * 4 + c] = rgb[(sy * w + sx) * 3 + c]!;
      out[(y * W + x) * 4 + 3] = 255;
    }
  }
  return out;
}

/** The hash a figure gets when the page is rendered at `scale` px per pt. */
function renderedHash(image: string, widthPt: number, heightPt: number, scale = 2): string {
  const [w, h, seed, tint] = IMAGES[image]!;
  const W = Math.round(widthPt * scale), H = Math.round(heightPt * scale);
  return averageHash(resample(syntheticImage(w, h, seed, tint), w, h, W, H), W, H)!;
}

/* ------------------------------------------------------------------ */
/* The unseen PDF, read as the app reads it                              */
/* ------------------------------------------------------------------ */

async function readUnseen() {
  const data = new Uint8Array(readFileSync(FILE));
  const document = await extractPdfPages(data, UNSEEN_FILE, { courseId: COURSE, lectureId: LECTURE });
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(readFileSync(FILE)), useWorkerFetch: false, useSystemFonts: false, disableFontFace: true });
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
  // Figures and captions exactly as the browser pipeline selects them; the
  // content hash as the browser computes it from the figure drawn at its size.
  const visuals: PageVisuals[] = selectFigures(analyses).map((v) => ({
    ...v,
    figures: annotateFigures(v.figures, texts.get(v.pageNumber) ?? [], analyses[v.pageNumber - 1]!).map((figure, i) => {
      const placed = SLIDES[v.pageNumber - 1]?.figures?.[i];
      return placed ? { ...figure, contentHash: renderedHash(placed.image, placed.w, placed.h) } : figure;
    }),
  }));
  return { document, visuals };
}

let unseen: Awaited<ReturnType<typeof readUnseen>>;
beforeAll(async () => {
  unseen = await readUnseen();
});

function generate(language: "en" | "ar" | "ar-en", visuals: PageVisuals[] = unseen.visuals): GeneratedCards {
  const { document } = unseen;
  return generateCards({ courseId: COURSE, lectureId: LECTURE, documents: [{ id: document.id, title: document.title, pages: document.pages, visuals }], language, count: 100, existing: [] });
}

const bySource = (out: GeneratedCards, sentence: string): Concept => {
  const found = out.concepts.find((c) => c.source.excerpt === sentence && c.retrievalItems[0]!.kind !== "IMAGE");
  if (!found) throw new Error(`no card from "${sentence}"`);
  return found;
};
const item = (c: Concept) => c.retrievalItems[0]!;
const imageQuestions = (out: GeneratedCards) => out.concepts.filter((c) => item(c).kind === "IMAGE");

describe("the unseen fixture", () => {
  it("is the generator script's output (it cannot drift from what the tests describe)", () => {
    expect(Buffer.compare(readFileSync(FILE), buildUnseenPdf())).toBe(0);
  });

  it("is read as the app reads it: 11 pages, figures on the expected pages, the long title from the file name", () => {
    expect(unseen.document.pageCount).toBe(11);
    expect(unseen.document.title).toBe("Hepatic Injury, Repair and Fibrosis in Alcoholic, Viral and Drug Induced Liver Disease");
    const figurePages = unseen.visuals.filter((v) => v.figures.length > 0).map((v) => v.pageNumber);
    expect(figurePages).toEqual([3, 5, 7, 8, 9, 10]); // the repeated logo is rejected
    expect(unseen.visuals.find((v) => v.pageNumber === 5)!.figures[0]!.caption).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */

describe("Fix 1: Arabic partial detection and meaning on an unseen lecture", () => {
  // Sentences whose English structure (a verb, "of", ordinary words) the
  // deterministic generator cannot translate: always partial.
  const UNSUPPORTED = [
    "Alanine aminotransferase is the most specific marker of hepatocellular injury.",
    "Serum aminotransferases rise within twelve hours of the toxic insult.",
    "Hepatocyte replication restores liver mass by two weeks.",
    "Portal fibrosis follows repeated episodes of hepatocyte injury in many patients.",
    "Conjugated bilirubin accumulates within canaliculi during cholestasis.",
    "Prolonged cholestasis damages bile ductules through retained bile acids.",
    "Bridging necrosis is characterized by bands of necrosis linking portal tracts.",
  ];
  // Supported patterns whose remaining English is medical terms only: fully Arabic.
  const SUPPORTED = [
    "Acetaminophen overdose is the most common cause of acute liver failure.",
    "Glutathione depletion leads to accumulation of reactive metabolites.",
    "Increased NAPQI formation causes decreased mitochondrial respiration.",
    "Centrilobular necrosis is the first manifestation of acetaminophen toxicity.",
    "Chronic alcohol use results in macrovesicular steatosis.",
    "Alcoholic hepatitis is defined as hepatocyte ballooning with neutrophilic infiltration.",
  ];

  for (const language of ["ar", "ar-en"] as const) {
    it(`${language}: untranslated English structure is partial, supported patterns are fully Arabic, and the counts add up`, () => {
      const out = generate(language);
      const partial = new Set(out.partialIds);
      for (const sentence of UNSUPPORTED) expect(partial.has(bySource(out, sentence).id), sentence).toBe(true);
      for (const sentence of SUPPORTED) expect(partial.has(bySource(out, sentence).id), sentence).toBe(false);
      expect(out.coverage.partial).toBe(out.partialIds.length);
      expect(out.coverage.arabic + out.coverage.partial).toBe(out.concepts.length);
      expect(out.coverage.partial).toBeGreaterThanOrEqual(UNSUPPORTED.length);
      // Every card has an Arabic question.
      for (const c of out.concepts) expect(hasArabic(item(c).prompt)).toBe(true);
    });
  }

  it("keeps meaning: 'most specific' is never 'معظم'; 'by two weeks' is بحلول; 'within twelve hours' is خلال; 'within canaliculi' is داخل", () => {
    const out = generate("ar");
    const alt = item(bySource(out, "Alanine aminotransferase is the most specific marker of hepatocellular injury."));
    expect(alt.explanation).not.toContain("معظم");
    expect(alt.explanation).toContain("most specific marker");
    const mass = item(bySource(out, "Hepatocyte replication restores liver mass by two weeks."));
    expect(mass.explanation).toContain("بحلول أسبوعين");
    expect(mass.explanation).not.toContain("بواسطة");
    const rise = item(bySource(out, "Serum aminotransferases rise within twelve hours of the toxic insult."));
    expect(rise.explanation).toContain("خلال 12 ساعة");
    expect(rise.explanation).not.toContain("داخل");
    expect(item(bySource(out, "Conjugated bilirubin accumulates within canaliculi during cholestasis.")).explanation).toContain("داخل canaliculi");
  });

  it("supported patterns: most common cause, first manifestation, leads to, results in, caused by, defined as, characterized by, increased / decreased", () => {
    const out = generate("ar-en");
    const expectCard = (sentence: string, prompt: RegExp, explanation: RegExp) => {
      const card = item(bySource(out, sentence));
      expect(card.prompt, sentence).toMatch(prompt);
      expect(card.explanation, sentence).toMatch(explanation);
    };
    expectCard("Acetaminophen overdose is the most common cause of acute liver failure.", /^ما هو السبب الأكثر شيوعًا لـ acute liver failure؟$/, /^Acetaminophen overdose هو السبب الأكثر شيوعًا/);
    expectCard("Centrilobular necrosis is the first manifestation of acetaminophen toxicity.", /^ما هو المظهر الأول لـ acetaminophen toxicity؟$/, /^Centrilobular necrosis هو المظهر الأول/);
    expectCard("Glutathione depletion leads to accumulation of reactive metabolites.", /^إلامَ يؤدي Glutathione depletion؟$/, /يؤدي إلى تراكم reactive metabolites\.$/);
    expectCard("Chronic alcohol use results in macrovesicular steatosis.", /^ما الذي ينتج عن Chronic alcohol use؟$/, /^ينتج عن Chronic alcohol use macrovesicular steatosis\.$/);
    expectCard("Mallory bodies are caused by aggregation of damaged intermediate filaments.", /^ما سبب Mallory bodies؟$/, /يحدث بسبب/);
    expectCard("Alcoholic hepatitis is defined as hepatocyte ballooning with neutrophilic infiltration.", /^ما تعريف Alcoholic hepatitis؟$/, /^يُعرَّف Alcoholic hepatitis بأنه/);
    expectCard("Bridging necrosis is characterized by bands of necrosis linking portal tracts.", /^بماذا يتميز Bridging necrosis؟$/, /^يتميز Bridging necrosis بـ/);
    expectCard("Increased NAPQI formation causes decreased mitochondrial respiration.", /^إلامَ يؤدي زيادة NAPQI formation؟$/, /يؤدي إلى انخفاض mitochondrial respiration\.$/);
    // The arrow sequence: an Arabic cause-and-effect question on the first step.
    expectCard("Stellate cell activation -> collagen deposition -> septal fibrosis -> cirrhosis", /^إلامَ يؤدي Stellate cell activation؟$/, /يؤدي إلى collagen deposition -> septal fibrosis -> cirrhosis/);
  });

  it("Arabic and Mixed differ where the vocabulary has the term; Mixed keeps it English", () => {
    const sentence = "Chronic hepatitis B shows hepatocytes with finely granular cytoplasm.";
    const ar = item(bySource(generate("ar"), sentence)).explanation;
    const mixed = item(bySource(generate("ar-en"), sentence)).explanation;
    expect(ar).toContain("خلايا الكبد (hepatocytes)");
    expect(mixed).toContain("يُظهر hepatocytes");
    expect(ar).not.toBe(mixed);
  });
});

describe("Fix 1: the reviewer's failure classes, on new sentences", () => {
  const cardsOf = (heading: string, sentence: string, language: "ar" | "ar-en") => {
    const pages: Page[] = [{ number: 1, title: heading, text: `${heading}\n${sentence}` }];
    return generateCards({ courseId: "c", lectureId: "l", document: { id: "d", title: "t", pages }, visuals: [], language, count: 5, existing: [] });
  };
  const only = (out: GeneratedCards) => {
    expect(out.concepts).toHaveLength(1);
    return { card: item(out.concepts[0]!), partial: out.partialIds.length === 1 };
  };

  it("the reported cards: an English verb clause and an English adjective phrase are partial in both modes", () => {
    for (const language of ["ar", "ar-en"] as const) {
      expect(only(cardsOf("Healing", "Granulation tissue replaces necrotic myocardium after about one week.", language)).partial).toBe(true);
      expect(only(cardsOf("Morphology", "Contraction band necrosis is typical of reperfused myocardium.", language)).partial).toBe(true);
      expect(only(cardsOf("Healing", "Dense collagenous scar forms by six to eight weeks.", language)).partial).toBe(true);
    }
  });

  it("temporal 'by' / 'within' / 'after' / 'for' are rendered as time, never as an agent or a place", () => {
    expect(renderPhrase("scar forms by six to eight weeks", "ar-en").text).toContain("بحلول 6 إلى 8 أسابيع");
    expect(renderPhrase("scar forms by six to eight weeks", "ar-en").text).not.toContain("بواسطة");
    expect(renderPhrase("loss of contractility within one minute", "ar-en").text).toContain("خلال دقيقة واحدة");
    expect(renderPhrase("loss of contractility within one minute", "ar-en").text).not.toContain("داخل");
    expect(renderPhrase("replaced after about one week", "ar-en").text).toContain("بعد حوالي أسبوع واحد");
    expect(renderPhrase("fever for three days", "ar-en").text).toContain("لمدة 3 أيام");
    expect(renderPhrase("oliguria within 24 hours", "ar-en").text).toContain("خلال 24 ساعة");
    expect(renderPhrase("resolution in the first two weeks", "ar-en").text).toContain("خلال أول أسبوعين");
    expect(renderPhrase("resolution in the first three days", "ar-en").text).toContain("خلال أول 3 أيام");
    // A place stays a place.
    expect(renderPhrase("crystals within renal tubules", "ar-en").text).toBe("crystals داخل renal tubules");
    // "by" with no recognised verb or time: left in English, partial — never a guessed "بواسطة".
    const agent = renderPhrase("cleaved by pancreatic enzymes", "ar-en");
    expect(agent.text).not.toContain("بواسطة");
    expect(agent.partial).toBe(true);
    // A known passive construction keeps its correct translation.
    expect(renderPhrase("programmed cell death mediated by caspases", "ar-en").text).toContain("بوساطة caspases");
  });

  it("'most' is معظم only before a noun; 'most specific' / 'most sensitive' stay English and partial", () => {
    expect(renderPhrase("most patients", "ar-en").text).toBe("معظم المرضى");
    for (const phrase of ["the most specific marker of pancreatic injury", "the most sensitive test for early rejection"]) {
      const out = renderPhrase(phrase, "ar-en");
      expect(out.text).not.toContain("معظم");
      expect(out.partial).toBe(true);
    }
    const lipase = only(cardsOf("Pancreatitis", "Lipase is the most specific marker of acute pancreatitis.", "ar"));
    expect(lipase.card.explanation).not.toContain("معظم");
    expect(lipase.partial).toBe(true);
    // The superlative the templates DO support keeps its Arabic form.
    const common = only(cardsOf("Nephrotic syndrome", "Membranous nephropathy is the most common cause of nephrotic syndrome in adults.", "ar-en"));
    expect(common.card.prompt).toMatch(/^ما هو السبب الأكثر شيوعًا لـ nephrotic syndrome في adults؟$/);
    expect(common.partial).toBe(false);
  });

  it("caused by / defined as / characterized by / leads to / results in / increased / decreased on new sentences", () => {
    const check = (heading: string, sentence: string, prompt: RegExp, explanation: RegExp, partial = false) => {
      const out = only(cardsOf(heading, sentence, "ar-en"));
      expect(out.card.prompt, sentence).toMatch(prompt);
      expect(out.card.explanation, sentence).toMatch(explanation);
      expect(out.partial, sentence).toBe(partial);
    };
    check("Pneumothorax", "Tension pneumothorax is caused by a one-way valve leak.", /^ما سبب Tension pneumothorax؟$/, /^Tension pneumothorax يحدث بسبب/);
    check("Emphysema", "Emphysema is defined as permanent airspace enlargement.", /^ما تعريف Emphysema؟$/, /^يُعرَّف Emphysema بأنه permanent airspace enlargement\.$/);
    // English "of" between English words is English structure: partial.
    check("Emphysema", "Emphysema is defined as permanent enlargement of airspaces.", /^ما تعريف Emphysema؟$/, /^يُعرَّف Emphysema بأنه/, true);
    check("Sarcoidosis", "Sarcoidosis is characterized by noncaseating granulomas.", /^بماذا يتميز Sarcoidosis؟$/, /^يتميز Sarcoidosis بـ noncaseating granulomas\.$/);
    check("Obstruction", "Ureteric obstruction leads to progressive hydronephrosis.", /^إلامَ يؤدي Ureteric obstruction؟$/, /^Ureteric obstruction يؤدي إلى progressive hydronephrosis\.$/);
    check("Hypoperfusion", "Renal hypoperfusion results in prerenal azotemia.", /^ما الذي ينتج عن Renal hypoperfusion؟$/, /^ينتج عن Renal hypoperfusion prerenal azotemia\.$/);
    check("Aldosterone", "Increased aldosterone causes decreased serum potassium.", /^إلامَ يؤدي زيادة aldosterone؟$/, /يؤدي إلى انخفاض serum potassium\.$/);
  });

  it("a card with no Arabic in its answer sentence is never counted as Arabic", () => {
    const out = cardsOf("Sequence", "Plaque erosion -> platelet adhesion -> occlusive thrombus", "ar-en");
    // Whatever form it takes, if the answer carries no Arabic word it is partial.
    for (const c of out.concepts) {
      const noArabicAnswer = !/[؀-ۿ]/.test(item(c).explanation);
      if (noArabicAnswer) expect(out.partialIds).toContain(c.id);
    }
  });
});

/* ------------------------------------------------------------------ */

describe("Fix 2: repeated images match perceptually, not by exact fingerprint", () => {
  const pixels = (seed: number, W: number, H: number, mode: "bilinear" | "nearest" = "bilinear") => {
    const rgb = syntheticImage(160, 120, seed);
    return (mode === "bilinear" ? resample : nearest)(rgb, 160, 120, W, H);
  };
  const hashOf = (seed: number, W: number, H: number, mode: "bilinear" | "nearest" = "bilinear") => averageHash(pixels(seed, W, H, mode), W, H)!;

  it("the fingerprint is 64 bits and the threshold is 1 bit in 16 (4 of 64)", () => {
    const h = hashOf(7, 320, 240);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    const flip = (hash: string, bits: number) => {
      let out = hash;
      for (let b = 0; b < bits; b++) {
        const i = b % hash.length;
        out = out.slice(0, i) + ((parseInt(out[i]!, 16) ^ (1 << Math.floor(b / hash.length))) & 15).toString(16) + out.slice(i + 1);
      }
      return out;
    };
    expect(hashDistance(h, h)).toBe(0);
    expect(sameImage(h, h)).toBe(true); // exact
    expect(hashDistance(h, flip(h, 1))).toBe(1);
    expect(sameImage(h, flip(h, 1))).toBe(true); // one bit
    expect(sameImage(h, flip(h, 4))).toBe(true);
    expect(sameImage(h, flip(h, 5))).toBe(false);
    expect(hashDistance(h, "zz")).toBe(Infinity);
    expect(sameImage(h, undefined)).toBe(false);
  });

  it("the same picture at other sizes, aspect-preserving or not, bilinear or nearest: the same image", () => {
    const base = hashOf(101, 640, 480);
    for (const [W, H, mode] of [[320, 240, "bilinear"], [480, 360, "bilinear"], [224, 168, "bilinear"], [600, 450, "nearest"], [300, 240, "bilinear"], [160, 120, "nearest"]] as const) {
      expect(hashDistance(base, hashOf(101, W, H, mode)), `${W}x${H} ${mode}`).toBeLessThanOrEqual(4);
    }
  });

  it("clearly different pictures are never merged", () => {
    const seeds = [7, 11, 23, 29, 101, 202, 303, 404, 505, 606];
    const hashes = seeds.map((s) => hashOf(s, 320, 240));
    for (let i = 0; i < hashes.length; i++) {
      for (let j = i + 1; j < hashes.length; j++) expect(sameImage(hashes[i], hashes[j]), `${seeds[i]} vs ${seeds[j]}`).toBe(false);
    }
  });

  it("on the unseen lecture: the picture drawn twice with contradictory captions gets no question and illustrates no card; the one drawn twice with the same caption gets exactly one", () => {
    const hashOn = (page: number) => unseen.visuals.find((v) => v.pageNumber === page)!.figures[0]!.contentHash!;
    // The browser-equivalent hashes of the resized copies are equal or a few bits apart.
    expect(sameImage(hashOn(7), hashOn(8))).toBe(true);
    expect(sameImage(hashOn(9), hashOn(10))).toBe(true);
    expect(sameImage(hashOn(3), hashOn(7))).toBe(false);
    for (const language of ["en", "ar"] as const) {
      const out = generate(language);
      const pages = imageQuestions(out).map((c) => c.source.pageNumber).sort((a, b) => a - b);
      expect(pages).toEqual([3, 9]); // not 7 / 8 (contradictory), one of 9 / 10 (agreeing), not 5 (no caption)
      for (const c of out.concepts) {
        const image = item(c).image;
        if (image) expect([7, 8]).not.toContain(image.pageNumber);
      }
    }
  });

  it("with EXACT-equality matching the same picture WOULD get two contradictory questions (the reported failure)", () => {
    // The same hashes with one bit forced apart on every copy: only perceptual matching catches them.
    const visuals = unseen.visuals.map((v) => ({ ...v, figures: v.figures.map((f) => (f.contentHash ? { ...f, contentHash: `${f.contentHash.slice(0, 15)}${(parseInt(f.contentHash[15]!, 16) ^ (v.pageNumber % 2)).toString(16)}` } : f)) }));
    expect(visuals.find((v) => v.pageNumber === 7)!.figures[0]!.contentHash).not.toBe(visuals.find((v) => v.pageNumber === 8)!.figures[0]!.contentHash);
    const pages = imageQuestions(generate("en", visuals)).map((c) => c.source.pageNumber).sort((a, b) => a - b);
    expect(pages).toEqual([3, 9]);
  });
});

/* ------------------------------------------------------------------ */

describe("Fix 3: an image is attached to a card only on strong evidence", () => {
  it("unseen lecture: the centrilobular-necrosis micrograph illustrates the centrilobular card, never the bridging-necrosis card", () => {
    for (const language of ["en", "ar", "ar-en"] as const) {
      const out = generate(language);
      const centrilobular = item(bySource(out, "Centrilobular necrosis is the first manifestation of acetaminophen toxicity."));
      const bridging = item(bySource(out, "Bridging necrosis is characterized by bands of necrosis linking portal tracts."));
      expect(centrilobular.image).toMatchObject({ placement: "back", pageNumber: 3, assetId: figureAssetId(unseen.document.id, 3, 0) });
      expect(bridging.image).toBeUndefined();
    }
  });

  it("the reviewer's case: 'Coagulative necrosis of myocardial fibres' is not attached to a contraction-band card, only to the coagulative card", () => {
    const pages: Page[] = [{
      number: 4,
      title: "Morphology",
      text: ["Morphology", "Coagulative necrosis is characterized by preserved cell outlines with loss of nuclei.", "Contraction band necrosis is typical of reperfusion."].join("\n"),
    }];
    const figure: FigureCandidate = { kind: "raster", region: { x: 0.2, y: 0.5, w: 0.5, h: 0.3 }, caption: "Figure 4.1: coagulative necrosis of myocardial fibres" };
    const out = generateCards({ courseId: "c", lectureId: "l", document: { id: "d", title: "t", pages }, visuals: [{ pageNumber: 4, figures: [figure], textChars: 0 }], language: "en", count: 10, existing: [] });
    const coag = out.concepts.find((c) => c.source.excerpt.startsWith("Coagulative necrosis is"))!;
    const band = out.concepts.find((c) => c.source.excerpt.startsWith("Contraction band necrosis"))!;
    expect(item(coag).image).toMatchObject({ placement: "back", pageNumber: 4 });
    expect(item(band).image).toBeUndefined();
  });

  it("generic words alone never attach; two specific shared words or a named subject do", () => {
    const run = (caption: string, sentence: string, labels: string[] = []) => {
      const pages: Page[] = [{ number: 1, title: "Kidney", text: `Kidney\n${sentence}` }];
      const figure: FigureCandidate = { kind: "raster", region: { x: 0.2, y: 0.5, w: 0.5, h: 0.3 }, caption, labels };
      const out = generateCards({ courseId: "c", lectureId: "l", document: { id: "d", title: "t", pages }, visuals: [{ pageNumber: 1, figures: [figure], textChars: 0 }], language: "en", count: 10, existing: [] });
      return out.concepts.find((c) => item(c).kind !== "IMAGE" && item(c).image) !== undefined;
    };
    // Only generic words shared ("necrosis", "tissue", "injury", "acute", "cells").
    expect(run("Figure 1: papillary necrosis of renal tissue", "Acute tubular necrosis follows ischemic injury to tubular cells.")).toBe(false);
    expect(run("Figure 1: necrosis", "Fat necrosis is seen in acute pancreatitis.")).toBe(false);
    // One specific word only, not the figure's subject.
    expect(run("Figure 1: crescents in glomeruli", "Glomeruli filter plasma through fenestrated capillaries.")).toBe(false);
    // The figure's subject named by the card.
    expect(run("Figure 1: papillary necrosis in analgesic nephropathy", "Papillary necrosis is a complication of diabetes.")).toBe(true);
    // Two specific shared words.
    expect(run("Figure 1: crescents in rapidly progressive glomerulonephritis", "Rapidly progressive glomerulonephritis shows crescent formation.")).toBe(true);
    // A specific label.
    expect(run("Figure 1: renal biopsy", "Amyloid deposits stain with Congo red.", ["Amyloid deposits"])).toBe(true);
  });
});

describe("Fix 1: medical terms that contain everyday-looking words are not partial", () => {
  it("labels and terms: hepatitis A, type I, Down syndrome, common bile duct, prothrombin time", () => {
    for (const phrase of ["acute hepatitis A", "type I hypersensitivity", "Down syndrome", "common bile duct obstruction", "prolonged prothrombin time", "stage IV disease"]) {
      expect(renderPhrase(phrase, "ar-en").partial, phrase).toBe(false);
    }
  });

  it("a bracketed gloss after the subject is not mistaken for an untranslated verb", () => {
    const pages: Page[] = [{ number: 1, title: "Jaundice", text: "Jaundice\nHyperbilirubinemia (jaundice) occurs in hemolytic anemia." }];
    const out = generateCards({ courseId: "c", lectureId: "l", document: { id: "d", title: "t", pages }, visuals: [], language: "ar-en", count: 5, existing: [] });
    expect(out.concepts).toHaveLength(1);
    expect(out.partialIds).toEqual([]);
  });
});
