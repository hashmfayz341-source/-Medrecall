import { describe, expect, it } from "vitest";
import type { Page } from "@/lib/domain/types";
import { renderPhrase } from "@/lib/generation/arabic";
import { generateCards, type GeneratedCards } from "@/lib/generation/generate";
import type { FigureCandidate } from "@/lib/visuals/analyze";

/**
 * The last three merge-gate blockers of PR #10, on sentences written for
 * these tests (not taken from any fixture), each a class of failure:
 *
 * M1. English sentence structure (a relative clause, verbs with objects)
 *     kept inside an Arabic card makes it Partly English — never "Fully
 *     Arabic" — while English medical noun phrases do not.
 * M2. "within" is temporal (خلال) before a duration, counted or not;
 *     spatial (داخل) only before a recognised place; otherwise English and
 *     partial, never a guessed "داخل".
 * M3. An image is not attached to a card about a different entity of the
 *     same kind (another subtype, type, stage) however many words they
 *     share; a genuinely related card still gets it.
 */

type Language = "en" | "ar" | "ar-en";

function generate(lines: string[], language: Language, figures: FigureCandidate[] = [], heading = "Lecture"): GeneratedCards {
  const pages: Page[] = [{ number: 1, title: heading, text: [heading, ...lines].join("\n") }];
  return generateCards({
    courseId: "course",
    lectureId: "lecture",
    document: { id: "doc", title: "Doc", pages },
    visuals: figures.length > 0 ? [{ pageNumber: 1, figures, textChars: 0 }] : [],
    language,
    count: 20,
    existing: [],
  });
}

/** The single card generated from one sentence, and whether it is partial. */
function one(sentence: string, language: "ar" | "ar-en", heading = "Lecture") {
  const out = generate([sentence], language, [], heading);
  expect(out.concepts, sentence).toHaveLength(1);
  const card = out.concepts[0]!;
  return { prompt: card.retrievalItems[0]!.prompt, explanation: card.retrievalItems[0]!.explanation, partial: out.partialIds.includes(card.id), coverage: out.coverage };
}

describe("M1: English clauses are Partly English, never Fully Arabic", () => {
  it("the reported class: a relative clause with verbs and objects ('phagocytes that engulf debris and secrete cytokines')", () => {
    for (const language of ["ar", "ar-en"] as const) {
      const card = one("Macrophages are phagocytes that engulf debris and secrete cytokines.", language, "Macrophages");
      expect(card.partial, language).toBe(true);
      expect(card.coverage).toEqual({ arabic: 0, partial: 1 });
    }
  });

  it("other English verb clauses between Arabic connectors are partial", () => {
    const sentences = [
      "Eosinophils are granulocytes that release major basic protein and kill helminths.",
      "Kupffer cells are sinusoidal macrophages which remove senescent erythrocytes from portal blood.",
      "Podocytes are epithelial cells that maintain the filtration barrier.",
      "Osteoclasts are multinucleated cells that resorb bone matrix.", // "resorb" is in no word list: the relative clause gives it away
    ];
    for (const sentence of sentences) {
      for (const language of ["ar", "ar-en"] as const) expect(one(sentence, language).partial, `${language}: ${sentence}`).toBe(true);
    }
  });

  it("a finite verb with its object inside a kept phrase is a clause, a verb-like word ending a noun phrase is not", () => {
    // Verb + object in a kept English phrase.
    expect(renderPhrase("neutrophils engulf opsonized bacteria", "ar-en").partial).toBe(true);
    expect(renderPhrase("the graft secretes insulin", "ar-en").partial).toBe(true);
    // The same words as the head of a medical noun phrase.
    expect(renderPhrase("plaque rupture", "ar-en").partial).toBe(false);
    expect(renderPhrase("granuloma formation", "ar-en").partial).toBe(false);
  });

  it("legitimate multi-word medical noun phrases stay acceptable terminology", () => {
    for (const phrase of [
      "Down syndrome", "type I hypersensitivity", "common bile duct", "prolonged prothrombin time", "papillary thyroid carcinoma",
      "small cell lung carcinoma", "hepatitis B surface antigen", "diffuse alveolar damage", "clear cell carcinoma", "mature cystic teratoma",
    ]) {
      expect(renderPhrase(phrase, "ar-en").partial, phrase).toBe(false);
    }
  });

  it("English medical terms inside Arabic sentence structure are Fully Arabic", () => {
    const cases = [
      "Ionizing radiation is the most common cause of papillary thyroid carcinoma.",
      "Hashimoto thyroiditis leads to primary hypothyroidism.",
      "Graves disease is caused by thyroid stimulating immunoglobulins.",
      "Subacute thyroiditis is characterized by painful thyroid enlargement.",
    ];
    for (const sentence of cases) {
      for (const language of ["ar", "ar-en"] as const) {
        const card = one(sentence, language);
        expect(card.partial, `${language}: ${sentence} → ${card.explanation}`).toBe(false);
        expect(card.explanation).toMatch(/[؀-ۿ]/);
      }
    }
  });
});

describe("M2: 'within' keeps its temporal meaning; داخل only before a recognised place", () => {
  const ar = (phrase: string) => renderPhrase(phrase, "ar-en");

  it("durations, counted or not, are خلال", () => {
    expect(ar("within several minutes").text).toBe("خلال عدة دقائق");
    expect(ar("within a minute").text).toBe("خلال دقيقة");
    expect(ar("within one minute").text).toBe("خلال دقيقة واحدة");
    expect(ar("within a few hours").text).toBe("خلال بضع ساعات");
    expect(ar("within a few days").text).toBe("خلال بضعة أيام");
    expect(ar("within days").text).toBe("خلال أيام");
    expect(ar("within minutes").text).toBe("خلال دقائق");
    expect(ar("within an hour").text).toBe("خلال ساعة");
    expect(ar("within several weeks").text).toBe("خلال عدة أسابيع");
    for (const phrase of ["within several minutes", "within a minute", "within one minute", "within a few hours", "within days"]) {
      expect(ar(phrase).text, phrase).not.toContain("داخل");
      expect(ar(phrase).partial, phrase).toBe(false);
    }
    // The same durations after other temporal prepositions.
    expect(ar("for a week").text).toBe("لمدة أسبوع");
    expect(ar("after several days").text).toBe("بعد عدة أيام");
  });

  it("whole sentences keep the temporal meaning; a supported pattern with a duration is fully Arabic", () => {
    for (const language of ["ar", "ar-en"] as const) {
      // Meaning first: خلال, never داخل (full-Arabic status depends on how the sentence's subject is found).
      const occur = one("Ventricular arrhythmias occur within several minutes.", language, "Arrhythmias");
      expect(occur.explanation).toContain("خلال عدة دقائق");
      expect(occur.explanation).not.toContain("داخل");
      // A cause-and-effect card whose only English is medical terms: fully Arabic.
      const loss = one("Coronary occlusion results in loss of contractility within a minute.", language, "Occlusion");
      expect(loss.explanation).toContain("خلال دقيقة");
      expect(loss.explanation).not.toContain("داخل");
      expect(loss.partial).toBe(false);
    }
  });

  it("recognised places are داخل", () => {
    expect(ar("within canaliculi").text).toBe("داخل canaliculi");
    expect(ar("within the nucleus").text).toBe("داخل nucleus");
    expect(renderPhrase("within the nucleus", "ar").text).toBe("داخل النواة (nucleus)");
    expect(ar("within hepatocytes").text).toBe("داخل hepatocytes");
    expect(ar("within renal tubules").text).toBe("داخل renal tubules");
    for (const phrase of ["within canaliculi", "within the nucleus", "within hepatocytes"]) expect(ar(phrase).partial, phrase).toBe(false);
  });

  it("neither a duration nor a recognised place: English kept, partial — never a guessed داخل", () => {
    for (const phrase of ["within normal limits", "within the reference range", "within the therapeutic window"]) {
      const out = ar(phrase);
      expect(out.text, phrase).not.toContain("داخل");
      expect(out.text, phrase).not.toContain("خلال");
      expect(out.text, phrase).toContain("within");
      expect(out.partial, phrase).toBe(true);
    }
    // "a second" is left alone (it is as often an ordinal).
    expect(ar("in a second attack").text).not.toContain("ثانية");
  });
});

describe("M3: an image never goes on a card about a different entity of the same kind", () => {
  const raster = (caption: string): FigureCandidate => ({ kind: "raster", region: { x: 0.2, y: 0.5, w: 0.5, h: 0.3 }, caption });
  /** Whether the text card from `sentence` gets the figure on its back, with other cards on the same page. */
  const attached = (caption: string, sentences: string[], target: string, heading = "Lecture") => {
    const out = generate(sentences, "en", [raster(caption)], heading);
    const card = out.concepts.find((c) => c.source.excerpt === target && c.retrievalItems[0]!.kind !== "IMAGE");
    expect(card, target).toBeTruthy();
    return card!.retrievalItems[0]!.image?.placement === "back";
  };
  const thyroid = [
    "Papillary thyroid carcinoma is the most common thyroid malignancy.",
    "Medullary thyroid carcinoma is derived from parafollicular C cells.",
  ];

  it("Papillary image → Papillary card: yes; → Medullary card on the same page: no", () => {
    expect(attached("Figure 1: Papillary thyroid carcinoma", thyroid, thyroid[0]!, "Thyroid carcinoma")).toBe(true);
    expect(attached("Figure 1: Papillary thyroid carcinoma", thyroid, thyroid[1]!, "Thyroid carcinoma")).toBe(false);
  });

  it("other subtype conflicts: small cell vs non-small cell, type I vs type II, acute vs chronic, proximal vs distal", () => {
    const lung = ["Small cell lung carcinoma is strongly associated with smoking.", "Non-small cell lung carcinoma is treated surgically when localized."];
    expect(attached("Figure 2: Small cell lung carcinoma", lung, lung[0]!)).toBe(true);
    expect(attached("Figure 2: Small cell lung carcinoma", lung, lung[1]!)).toBe(false);
    const pneumocytes = ["Type I pneumocytes cover most of the alveolar surface.", "Type II pneumocytes secrete surfactant."];
    expect(attached("Figure 3: Type I pneumocytes lining an alveolus", pneumocytes, pneumocytes[0]!)).toBe(true);
    expect(attached("Figure 3: Type I pneumocytes lining an alveolus", pneumocytes, pneumocytes[1]!)).toBe(false);
    const gallbladder = ["Acute cholecystitis is usually caused by an obstructing gallstone.", "Chronic cholecystitis is characterized by Rokitansky-Aschoff sinuses."];
    expect(attached("Figure 4: acute cholecystitis with mucosal ulceration", gallbladder, gallbladder[0]!)).toBe(true);
    expect(attached("Figure 4: acute cholecystitis with mucosal ulceration", gallbladder, gallbladder[1]!)).toBe(false);
    const tubule = ["Proximal tubule injury leads to glycosuria and aminoaciduria.", "Distal tubule injury leads to impaired urine concentration."];
    expect(attached("Figure 5: proximal tubule injury after cisplatin", tubule, tubule[0]!)).toBe(true);
    expect(attached("Figure 5: proximal tubule injury after cisplatin", tubule, tubule[1]!)).toBe(false);
  });

  it("a genuinely related card in other words still gets the image", () => {
    const reworded = "Thyroid carcinoma of the papillary type shows psammoma bodies and Orphan Annie nuclei.";
    expect(attached("Figure 1: Papillary thyroid carcinoma", [reworded], reworded)).toBe(true);
    const cause = "Ionizing radiation is the most common cause of papillary thyroid carcinoma.";
    expect(attached("Figure 1: Papillary thyroid carcinoma", [cause], cause)).toBe(true);
  });

  it("sharing only family or anatomy words attaches nothing", () => {
    const general = "Thyroid carcinoma spreads to cervical lymph nodes.";
    expect(attached("Figure 1: Papillary thyroid carcinoma", [general], general)).toBe(false);
    const anatomy = "Thyroid follicles store colloid rich in thyroglobulin.";
    expect(attached("Figure 1: Papillary thyroid carcinoma", [anatomy], anatomy)).toBe(false);
    const family = "Renal cell carcinoma arises from proximal tubular epithelium.";
    expect(attached("Figure 6: Transitional cell carcinoma of the bladder", [family], family)).toBe(false);
  });
});
