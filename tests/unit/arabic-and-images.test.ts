import { describe, expect, it } from "vitest";
import type { Page } from "@/lib/domain/types";
import { renderPhrase } from "@/lib/generation/arabic";
import { generateCards, type GeneratedCards } from "@/lib/generation/generate";
import { hasArabic } from "@/lib/generation/language";
import { annotateFigures, captionTarget, figureAssetId, type FigureCandidate, type PageVisuals, type PositionedText } from "@/lib/visuals/analyze";

/**
 * Review blockers 1 and 2 of PR #10.
 *
 * 1. Arabic mode must write Arabic cards — question AND answer — from real
 *    English medical sentences, keeping medical terms where that helps;
 *    mixed mode keeps the medical terms English; English stays English.
 *    Never "ما هو <an English sentence>؟".
 * 2. An image question needs a visual answer the image supports (its
 *    caption), never a sentence from elsewhere on the slide; otherwise the
 *    figure only illustrates a related text card's back, or nothing.
 */

const DOC = "doc-test-lecture";
const page = (number: number, title: string, lines: string[]): Page => ({ number, title, text: [title, ...lines].join("\n") });

function generate(pages: Page[], language: "en" | "ar" | "ar-en", visuals: PageVisuals[] = [], count: number | "auto" = 50): GeneratedCards {
  return generateCards({ courseId: "course", lectureId: "lecture", document: { id: DOC, title: "Test lecture", pages }, visuals, language, count, existing: [] });
}

const cardFor = (out: GeneratedCards, fromSentence: string) =>
  out.concepts.find((c) => c.source.excerpt === fromSentence)?.retrievalItems[0] ?? null;

/** English words (Latin-script tokens) in a text, not counting bracketed glosses ("نقص الأكسجة (Hypoxia)"). */
const latinWords = (text: string) => text.replace(/\([^)]*\)/g, " ").split(/[\s،,.؟?—:]+/).filter((w) => /^[A-Za-z]/.test(w));

describe("Fix 1: Arabic cards from real English medical sentences", () => {
  const SENTENCES: { sentence: string; heading: string; expect: { ar: [RegExp, RegExp]; mixed: [RegExp, RegExp] } }[] = [
    {
      heading: "Hypoxia",
      sentence: "Hypoxia is the most common cause of cell injury.",
      expect: {
        ar: [/^ما هو السبب الأكثر شيوعًا لـ إصابة الخلية \(cell injury\)؟$/, /^نقص الأكسجة \(Hypoxia\) هو السبب الأكثر شيوعًا/],
        mixed: [/^ما هو السبب الأكثر شيوعًا لـ cell injury؟$/, /^Hypoxia هو السبب الأكثر شيوعًا لـ cell injury\.$/],
      },
    },
    {
      heading: "Necrosis",
      sentence: "Necrosis is defined as the death of cells within living tissue.",
      expect: { ar: [/^ما تعريف النخر \(Necrosis\)؟$/, /^يُعرَّف النخر \(Necrosis\) بأنه/], mixed: [/^ما تعريف Necrosis؟$/, /^يُعرَّف Necrosis بأنه موت/] },
    },
    {
      heading: "Cellular swelling",
      sentence: "Cellular swelling is caused by failure of energy-dependent ion pumps.",
      expect: {
        ar: [/^ما سبب التورم الخلوي \(Cellular swelling\)؟$/, /^التورم الخلوي \(Cellular swelling\) يحدث بسبب فشل/],
        mixed: [/^ما سبب Cellular swelling؟$/, /^Cellular swelling يحدث بسبب فشل energy-dependent ion pumps\.$/],
      },
    },
    {
      heading: "Ischaemia",
      sentence: "Ischaemia leads to depletion of intracellular ATP.",
      expect: { ar: [/^إلامَ يؤدي نقص التروية \(Ischaemia\)؟$/, /يؤدي إلى نفاد/], mixed: [/^إلامَ يؤدي Ischaemia؟$/, /^Ischaemia يؤدي إلى نفاد/] },
    },
    {
      heading: "Vasodilation",
      sentence: "Vasodilation results in increased blood flow.",
      expect: { ar: [/^ما الذي ينتج عن توسع الأوعية \(Vasodilation\)؟$/, /زيادة تدفق الدم \(blood flow\)/], mixed: [/^ما الذي ينتج عن Vasodilation؟$/, /زيادة blood flow/] },
    },
    {
      heading: "Acute inflammation",
      sentence: "Acute inflammation is characterized by neutrophil infiltration.",
      expect: { ar: [/^بماذا يتميز الالتهاب الحاد \(Acute inflammation\)؟$/, /^يتميز الالتهاب الحاد/], mixed: [/^بماذا يتميز Acute inflammation؟$/, /^يتميز Acute inflammation بـ neutrophil infiltration\.$/] },
    },
    {
      heading: "Cellular swelling",
      sentence: "Cellular swelling is the first manifestation of almost all forms of injury to cells.",
      expect: {
        ar: [/^ما هو المظهر الأول لـ معظم أشكال إصابة الخلايا؟$/, /^التورم الخلوي \(Cellular swelling\) هو المظهر الأول/],
        mixed: [/^ما هو المظهر الأول لـ معظم أشكال إصابة الخلايا؟$/, /^Cellular swelling هو المظهر الأول لـ معظم أشكال إصابة الخلايا\.$/],
      },
    },
    {
      heading: "Vascular changes",
      sentence: "Increased vascular permeability leads to exudation of protein-rich fluid.",
      expect: { ar: [/^إلامَ يؤدي زيادة نفاذية الأوعية \(vascular permeability\)؟$/, /نضح/], mixed: [/^إلامَ يؤدي زيادة vascular permeability؟$/, /يؤدي إلى نضح/] },
    },
    {
      heading: "Glycolysis",
      sentence: "Decreased oxidative phosphorylation causes a switch to anaerobic glycolysis.",
      expect: { ar: [/^إلامَ يؤدي انخفاض الفسفرة التأكسدية \(oxidative phosphorylation\)؟$/, /التحلل السكري اللاهوائي/], mixed: [/^إلامَ يؤدي انخفاض oxidative phosphorylation؟$/, /التحول إلى anaerobic glycolysis/] },
    },
    {
      heading: "Mechanism",
      sentence: "ATP depletion → pump failure → cellular swelling.",
      expect: { ar: [/^إلامَ يؤدي نفاد ATP \(ATP depletion\)؟$/, /→/], mixed: [/^إلامَ يؤدي ATP depletion؟$/, /^ATP depletion يؤدي إلى pump failure → cellular swelling\.$/] },
    },
  ];

  for (const { sentence, heading, expect: want } of SENTENCES) {
    it(`"${sentence}"`, () => {
      const pages = [page(1, heading, [sentence])];
      const en = cardFor(generate(pages, "en"), sentence)!;
      const ar = cardFor(generate(pages, "ar"), sentence)!;
      const mixed = cardFor(generate(pages, "ar-en"), sentence)!;
      expect(en && ar && mixed).toBeTruthy();
      // English stays English.
      expect(hasArabic(en.prompt)).toBe(false);
      expect(hasArabic(en.explanation)).toBe(false);
      // Arabic: Arabic question, Arabic answer, the expected structure.
      expect(ar.prompt).toMatch(want.ar[0]);
      expect(ar.explanation).toMatch(want.ar[1]);
      expect(hasArabic(ar.explanation)).toBe(true);
      // Mixed: Arabic sentence, English medical terms.
      expect(mixed.prompt).toMatch(want.mixed[0]);
      expect(mixed.explanation).toMatch(want.mixed[1]);
      // Never "ما هو <a whole English sentence>؟".
      for (const card of [ar, mixed]) {
        const wrapped = /^ما هو (.+)؟$/.exec(card.prompt)?.[1];
        if (wrapped) expect(latinWords(wrapped).length).toBeLessThanOrEqual(4);
      }
      // Arabic uses no more English than mixed does.
      expect(latinWords(ar.explanation).length).toBeLessThanOrEqual(latinWords(mixed.explanation).length);
    });
  }

  it("Arabic and mixed are meaningfully different on medical terms; mixed keeps them English", () => {
    const pages = [page(1, "Apoptosis", ["Apoptosis is programmed cell death mediated by caspases."])];
    const ar = generate(pages, "ar").concepts[0]!.retrievalItems[0]!;
    const mixed = generate(pages, "ar-en").concepts[0]!.retrievalItems[0]!;
    expect(ar.prompt).toBe("ما هو الاستماتة (Apoptosis)؟");
    expect(ar.explanation).toBe("الاستماتة (Apoptosis) هو الموت الخلوي المبرمج (programmed cell death) بوساطة الكاسبيزات (caspases).");
    expect(mixed.prompt).toBe("ما هو Apoptosis؟");
    expect(mixed.explanation).toBe("Apoptosis هو programmed cell death بوساطة caspases.");
  });

  it("noun phrases are never translated word by word; unknown terms stay as the lecture wrote them", () => {
    // Word-by-word would give "خلوي تورم" / "خلية إصابة" — wrong Arabic order.
    expect(renderPhrase("cellular swelling", "ar-en").text).toBe("cellular swelling");
    expect(renderPhrase("cell injury", "ar-en").text).toBe("cell injury");
    expect(renderPhrase("irreversible injury", "ar").text).toBe("إصابة غير عكوسة");
    expect(renderPhrase("severe damage", "ar").text).toBe("تلف شديد");
    expect(renderPhrase("renal papillary necrosis", "ar").text).toBe("renal papillary necrosis");
    expect(renderPhrase("failure of the sodium pump", "ar-en").text).toBe("فشل sodium pump");
    expect(renderPhrase("Causes of cell injury", "ar-en").text).toBe("أسباب cell injury");
    expect(renderPhrase("Na+/K+ ATPase", "ar").text).toBe("Na+/K+ ATPase");
  });

  it("a sentence outside the supported patterns keeps its English and is counted as partial, never hidden", () => {
    const sentence = "Neutrophils ingest bacteria through receptor mediated phagocytosis of opsonized microbial particles quickly.";
    const out = generate([page(1, "Phagocytosis", [sentence])], "ar");
    const card = cardFor(out, sentence)!;
    expect(hasArabic(card.prompt)).toBe(true); // an Arabic instruction, not an English wrap
    expect(card.prompt.startsWith("أكمل الفراغ")).toBe(true);
    expect(out.coverage.partial).toBe(1);
    expect(out.coverage.arabic).toBe(0);
  });
});

/* ------------------------------------------------------------------ */

const raster = (caption?: string, extra: Partial<FigureCandidate> = {}): FigureCandidate => ({
  kind: "raster",
  region: { x: 0.25, y: 0.55, w: 0.5, h: 0.3 },
  ...(caption ? { caption } : {}),
  ...extra,
});

describe("Fix 2: image cards are grounded in what the image shows", () => {
  const steatosisPage = page(3, "Fatty change", [
    "Fatty change (steatosis) is the accumulation of triglycerides within parenchymal cells.",
    "Figure 3.1: steatosis of hepatocytes",
  ]);

  it("a captioned raster becomes an image question answered by its caption, with the correct source page", () => {
    const out = generate([steatosisPage], "en", [{ pageNumber: 3, figures: [raster("Figure 3.1: steatosis of hepatocytes")], textChars: 0 }]);
    const image = out.concepts.find((c) => c.retrievalItems[0]!.kind === "IMAGE")!;
    expect(image.retrievalItems[0]!.prompt).toBe("What is shown in this image?");
    expect(image.retrievalItems[0]!.explanation).toBe("Steatosis of hepatocytes (Fatty change).");
    expect(image.retrievalItems[0]!.image).toEqual({ assetId: figureAssetId(DOC, 3, 0), documentId: DOC, pageNumber: 3, region: raster().region, placement: "front" });
    expect(image.source).toMatchObject({ documentId: DOC, pageNumber: 3, excerpt: "Figure 3.1: steatosis of hepatocytes" });
    // The same figure also illustrates the back of the text card it is about.
    const text = out.concepts.find((c) => c.retrievalItems[0]!.kind !== "IMAGE")!;
    expect(text.retrievalItems[0]!.image).toMatchObject({ placement: "back", pageNumber: 3 });
  });

  it("an image WITHOUT a caption never becomes a question, and is not attached to an unrelated card", () => {
    const out = generate([steatosisPage], "en", [{ pageNumber: 3, figures: [raster()], textChars: 0 }]);
    expect(out.concepts.some((c) => c.retrievalItems[0]!.kind === "IMAGE")).toBe(false);
    expect(out.concepts.every((c) => !c.retrievalItems[0]!.image)).toBe(true);
    // A caption that says nothing ("Figure 3") is not enough either.
    const bare = generate([steatosisPage], "en", [{ pageNumber: 3, figures: [raster("Figure 3.1")], textChars: 0 }]);
    expect(bare.concepts.some((c) => c.retrievalItems[0]!.kind === "IMAGE")).toBe(false);
  });

  it("the old failure: a figure is never answered with a sentence from elsewhere on the slide", () => {
    const slide = page(5, "Cellular swelling", ["Cellular swelling is the first manifestation of almost all forms of injury to cells."]);
    const out = generate([slide], "en", [{ pageNumber: 5, figures: [raster()], textChars: 0 }]);
    expect(out.concepts.filter((c) => c.retrievalItems[0]!.kind === "IMAGE")).toEqual([]);
    expect(out.concepts.every((c) => c.retrievalItems[0]!.prompt !== "What is shown in this image?")).toBe(true);
  });

  it("a labelled vector diagram is not a question (its labels print the answer) but illustrates the related mechanism card's back", () => {
    const slide = page(4, "ATP depletion", [
      "ATP depletion causes failure of the sodium pump.",
      "Reduced ATP also causes a switch to anaerobic glycolysis.",
    ]);
    const diagram: FigureCandidate = { kind: "diagram", region: { x: 0.1, y: 0.6, w: 0.8, h: 0.25 }, labels: ["ATP depletion", "Pump failure", "Cellular swelling"] };
    const out = generate([slide], "en", [{ pageNumber: 4, figures: [diagram], textChars: 0 }]);
    expect(out.concepts.some((c) => c.retrievalItems[0]!.kind === "IMAGE")).toBe(false);
    const related = cardFor(out, "ATP depletion causes failure of the sodium pump.")!;
    expect(related.image).toMatchObject({ placement: "back", pageNumber: 4, assetId: figureAssetId(DOC, 4, 0) });
    expect(cardFor(out, "Reduced ATP also causes a switch to anaerobic glycolysis.")!.image).toBeUndefined();
  });

  it("an image whose answer is written inside it is not a question", () => {
    const labelled = raster("Figure 3.1: steatosis of hepatocytes", { labels: ["Steatosis of hepatocytes", "H&E x400"] });
    const out = generate([steatosisPage], "en", [{ pageNumber: 3, figures: [labelled], textChars: 0 }]);
    expect(out.concepts.some((c) => c.retrievalItems[0]!.kind === "IMAGE")).toBe(false);
  });

  it("an image question that only repeats a text card is dropped", () => {
    const slide = page(2, "Apoptosis", ["Apoptosis is programmed cell death mediated by caspases.", "Figure 2.1: Apoptosis"]);
    const out = generate([slide], "en", [{ pageNumber: 2, figures: [raster("Figure 2.1: Apoptosis is programmed cell death")], textChars: 0 }]);
    expect(out.concepts.some((c) => c.retrievalItems[0]!.kind === "IMAGE")).toBe(false);
  });

  it("the same picture on two pages: one question when the captions agree, none when they contradict; provenance kept", () => {
    const pages = [page(5, "Swelling", ["Hydropic change is reversible."]), page(6, "Steatosis", ["Steatosis affects hepatocytes."])];
    const same = generate(pages, "en", [
      { pageNumber: 5, figures: [raster("Figure 5.1: hydropic change of tubular cells", { contentHash: "abcd" })], textChars: 0 },
      { pageNumber: 6, figures: [raster("Figure 6.1: hydropic change of tubular cells", { contentHash: "abcd" })], textChars: 0 },
    ]);
    const questions = same.concepts.filter((c) => c.retrievalItems[0]!.kind === "IMAGE");
    expect(questions).toHaveLength(1);
    expect(questions[0]!.retrievalItems[0]!.image!.pageNumber).toBe(questions[0]!.source.pageNumber);
    const contradictory = generate(pages, "en", [
      { pageNumber: 5, figures: [raster("Figure 5.1: hydropic change of tubular cells", { contentHash: "abcd" })], textChars: 0 },
      { pageNumber: 6, figures: [raster("Figure 6.1: steatosis of hepatocytes", { contentHash: "abcd" })], textChars: 0 },
    ]);
    expect(contradictory.concepts.some((c) => c.retrievalItems[0]!.kind === "IMAGE")).toBe(false);
    // Different pictures with different captions both stay.
    const different = generate(pages, "en", [
      { pageNumber: 5, figures: [raster("Figure 5.1: hydropic change of tubular cells", { contentHash: "aaaa" })], textChars: 0 },
      { pageNumber: 6, figures: [raster("Figure 6.1: steatosis of hepatocytes", { contentHash: "bbbb" })], textChars: 0 },
    ]);
    expect(different.concepts.filter((c) => c.retrievalItems[0]!.kind === "IMAGE")).toHaveLength(2);
  });

  it("captions and labels are read from the page's positioned text: below the figure, not the slide's prose", () => {
    // Page 612 x 792 pt; figure at y 120..345 (PDF units), caption just below it, prose at the top.
    const figure = raster(undefined, { region: { x: 156 / 612, y: 1 - 345 / 792, w: 300 / 612, h: 225 / 792 } });
    const text = (str: string, x: number, y: number, width: number): PositionedText => ({ str, transform: [11, 0, 0, 11, x, y], width, height: 11 });
    const items = [
      text("Cellular swelling is the first manifestation of injury.", 56, 690, 440),
      text("Nuclei", 200, 300, 40),
      text("Figure 5.1: hydropic change of renal tubular cells", 156, 104, 238),
    ];
    const [annotated] = annotateFigures([figure], items, { width: 612, height: 792 });
    expect(annotated!.caption).toBe("Figure 5.1: hydropic change of renal tubular cells");
    expect(annotated!.labels).toEqual(["Nuclei"]);
    expect(captionTarget(annotated!.caption!)).toBe("hydropic change of renal tubular cells");
    // No text near the figure: no caption.
    const [bare] = annotateFigures([figure], [items[0]!], { width: 612, height: 792 });
    expect(bare!.caption).toBeUndefined();
  });

  it("image cards in Arabic modes: Arabic question, caption-grounded answer", () => {
    const out = generate([steatosisPage], "ar", [{ pageNumber: 3, figures: [raster("Figure 3.1: steatosis of hepatocytes")], textChars: 0 }]);
    const image = out.concepts.find((c) => c.retrievalItems[0]!.kind === "IMAGE")!.retrievalItems[0]!;
    expect(image.prompt).toBe("ماذا تُظهر هذه الصورة؟");
    expect(image.explanation).toBe("التنكس الدهني (Steatosis) لـ خلايا الكبد (hepatocytes) — التغير الدهني (Fatty change).");
  });
});
