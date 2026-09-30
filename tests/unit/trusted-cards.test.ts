import { describe, expect, it } from "vitest";
import type { Page } from "@/lib/domain/types";
import { extractFacts, type Skipped } from "@/lib/generation/facts";
import { generateCards, type GeneratedCards } from "@/lib/generation/generate";
import { excerptOnPage, rejectTarget, targetsOf, type LearningTarget } from "@/lib/generation/targets";
import { layoutPage, type PositionedItem } from "@/lib/ingestion/layout";
import { annotateFigures, selectFigures, type FigureCandidate, type PageVisualAnalysis, type PageVisuals, type PositionedText } from "@/lib/visuals/analyze";

/**
 * Trusted medical cards: the invariants behind every generated card, one
 * class of production failure per test, on text written for these tests.
 *
 * Source structure: paragraphs, bullets, text boxes, columns, captions and
 * table cells are never merged. Learning targets: one subject, one relation,
 * one short answer from the lecture's words. Quality filters: no pronoun or
 * vague subject, no grammatical blank, no question-only prompt, no truncated
 * list, no answer leak, no unsupported answer, verbatim excerpts from one
 * block. Coverage: larger counts add distinct material, never filler, and a
 * shortfall says why. Images: a caption belongs to one figure; a subtype
 * never gets another subtype's picture; tables and shared captions are not
 * image answers.
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

/** A pdfjs-like text run: `size` pt, baseline at (x, y), width estimated unless given. */
function run(str: string, x: number, y: number, opts: { size?: number; width?: number; eol?: boolean; font?: string } = {}): PositionedItem {
  const size = opts.size ?? 20;
  return { str, transform: [size, 0, 0, size, x, y], width: opts.width ?? str.length * size * 0.5, height: size, hasEOL: opts.eol ?? true, fontName: opts.font ?? "f1" };
}
const spacer = (x: number, y: number, width: number, size = 16): PositionedItem => ({ str: " ", transform: [size, 0, 0, size, x, y], width, height: 0, hasEOL: false });
const lines = (text: string) => text.split("\n").filter(Boolean);

/** A structured page (as extraction now writes it): blocks separated by blank lines. */
const blocksPage = (number: number, title: string, blocks: string[][]): Page => ({
  number,
  title,
  text: [title, ...blocks.map((b) => b.join("\n"))].join("\n\n"),
  layout: "blocks",
});

function generate(pages: Page[], count: number | "auto" = 50, visuals: PageVisuals[] = []): GeneratedCards {
  return generateCards({ courseId: "course", lectureId: "lecture", document: { id: "doc", title: "Doc", pages }, visuals, language: "en", count, existing: [] });
}
const qa = (out: GeneratedCards) => out.concepts.map((c) => ({ q: c.retrievalItems[0]!.prompt, a: c.retrievalItems[0]!.explanation, s: c.source.excerpt, page: c.source.pageNumber, image: c.retrievalItems[0]!.image }));
const answerTo = (out: GeneratedCards, question: string) => qa(out).find((c) => c.q === question)?.a;

/* ------------------------------------------------------------------ */
/* 1. Source structure                                                  */
/* ------------------------------------------------------------------ */

describe("source structure: layout from positions", () => {
  it("joins a paragraph's wrapped lines, and keeps two paragraphs apart", () => {
    const layout = layoutPage([
      run("Hypoxia is a deficiency of oxygen that", 50, 400, { width: 390 }),
      run("causes cell injury.", 50, 376, { width: 180 }),
      run("Ischemia is a loss of blood supply.", 50, 330, { width: 340 }),
    ]);
    expect(lines(layout.text)).toEqual(["Hypoxia is a deficiency of oxygen that causes cell injury.", "Ischemia is a loss of blood supply."]);
  });

  it("each bullet is one unit: its wrapped continuation joins it, the next bullet does not", () => {
    const layout = layoutPage([
      run("•", 50, 400, { width: 8, eol: false }), spacer(58, 400, 18, 20),
      run("ATP depletion causes failure of the pump, leading to", 76, 400, { width: 420 }),
      run("cellular swelling.", 76, 376, { width: 160 }),
      run("•", 50, 340, { width: 8, eol: false }), spacer(58, 340, 18, 20),
      run("Influx of calcium activates phospholipases.", 76, 340, { width: 390 }),
    ]);
    expect(lines(layout.text)).toEqual(["• ATP depletion causes failure of the pump, leading to cellular swelling.", "• Influx of calcium activates phospholipases."]);
  });

  it("short items are separate lines, and a heading in its own font is its own block", () => {
    const layout = layoutPage([
      run("Muscarinic signs of poisoning", 50, 424, { width: 300, font: "bold" }),
      run("Diarrhea", 50, 400, { width: 80 }),
      run("Urination", 50, 376, { width: 90 }),
      run("Bronchospasm", 50, 352, { width: 130 }),
      run("Bradycardia", 50, 328, { width: 110 }),
    ]);
    expect(layout.text.split("\n\n").map(lines)).toEqual([["Muscarinic signs of poisoning"], ["Diarrhea", "Urination", "Bronchospasm", "Bradycardia"]]);
  });

  it("two text boxes side by side (two drugs) are two blocks: nothing crosses the column gap", () => {
    const layout = layoutPage([
      run("Atropine is a muscarinic antagonist. It", 50, 400, { width: 390 }),
      run("increases heart rate.", 50, 376, { width: 200 }),
      run("Clonidine is an alpha-2 agonist. It", 500, 400, { width: 360 }),
      run("decreases sympathetic outflow.", 500, 376, { width: 300 }),
    ]);
    const blocks = layout.text.split("\n\n").map(lines);
    expect(blocks).toEqual([["Atropine is a muscarinic antagonist. It increases heart rate."], ["Clonidine is an alpha-2 agonist. It decreases sympathetic outflow."]]);
  });

  it("a line in another column is never a wrap, even when it would read on", () => {
    const layout = layoutPage([
      run("Atropine is a muscarinic antagonist that", 50, 400, { width: 390 }),
      run("blocks nicotinic receptors at the endplate.", 500, 376, { width: 400 }),
    ]);
    expect(lines(layout.text)).toEqual(["Atropine is a muscarinic antagonist that", "blocks nicotinic receptors at the endplate."]);
  });

  it("a table is rebuilt row by row with tab-separated cells; a wrapped cell stays in its cell", () => {
    const row = (y: number, cells: [string, number][], wrap?: [string, number]) => [
      ...cells.flatMap(([text, x], i) => [run(text, x, y, { size: 16, width: text.length * 8, eol: false }), ...(i < cells.length - 1 ? [spacer(x + text.length * 8, y, cells[i + 1]![1] - x - text.length * 8)] : [])]),
      ...(wrap ? [run(wrap[0], wrap[1], y - 18, { size: 16, width: wrap[0].length * 8 })] : []),
    ];
    const layout = layoutPage([
      ...row(420, [["Receptor", 50], ["G protein", 250], ["Location", 450]]),
      ...row(376, [["M1", 50], ["Gq", 250], ["CNS and gastric parietal", 450]], ["cells", 450]),
      ...row(330, [["M2", 50], ["Gi", 250], ["Heart", 450]]),
    ]);
    expect(layout.blocks[0]).toEqual({ kind: "table", rows: [["Receptor", "G protein", "Location"], ["M1", "Gq", "CNS and gastric parietal cells"], ["M2", "Gi", "Heart"]] });
    expect(layout.text).toBe("Receptor\tG protein\tLocation\nM1\tGq\tCNS and gastric parietal cells\nM2\tGi\tHeart");
  });

  it("captions under two figures stay two captions", () => {
    const layout = layoutPage([
      run("Figure 1: Wet gangrene of the foot", 90, 60, { size: 14, width: 230 }),
      run("Figure 2: Dry gangrene of the toes", 520, 60, { size: 14, width: 225 }),
    ]);
    expect(layout.text.split("\n\n")).toEqual(["Figure 1: Wet gangrene of the foot", "Figure 2: Dry gangrene of the toes"]);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Reading: sentences never cross blocks; no merged facts            */
/* ------------------------------------------------------------------ */

describe("reading: no cross-paragraph, cross-drug or fabricated excerpts", () => {
  const drugs = blocksPage(1, "Muscarinic antagonists and alpha-2 agonists", [
    ["Atropine", "Atropine is a competitive antagonist at muscarinic receptors. It increases heart rate and causes mydriasis. It is used to treat symptomatic bradycardia."],
    ["Clonidine", "Clonidine is a centrally acting alpha-2 agonist. It decreases sympathetic outflow from the brainstem."],
  ]);

  it("every card's excerpt is verbatim text of ONE block, and no card mixes the two drugs", () => {
    const out = generate([drugs]);
    expect(out.concepts.length).toBeGreaterThanOrEqual(6);
    for (const card of qa(out)) {
      expect(excerptOnPage(card.s, drugs), card.s).toBe(true);
      const text = `${card.q} ${card.a} ${card.s}`.toLowerCase();
      expect(text.includes("atropine") && text.includes("clonidine"), text).toBe(false);
    }
  });

  it("pronouns are resolved from the sentence that names the subject, never across drugs", () => {
    const out = generate([drugs]);
    expect(answerTo(out, "What does atropine increase?")).toBe("Heart rate");
    expect(answerTo(out, "What does atropine cause?")).toBe("Mydriasis");
    expect(answerTo(out, "What is atropine used to treat?")).toBe("Symptomatic bradycardia");
    expect(answerTo(out, "What does clonidine decrease?")).toBe("Sympathetic outflow from the brainstem");
    // The cited source names the drug.
    const use = qa(out).find((c) => c.q === "What is atropine used to treat?")!;
    expect(use.s.startsWith("Atropine is a competitive antagonist")).toBe(true);
  });

  it("a paragraph that begins with a pronoun (no antecedent in it) gives no card", () => {
    const skipped: Skipped[] = [];
    const facts = extractFacts([blocksPage(1, "Drugs", [["Epinephrine is the drug of choice for anaphylaxis."], ["It is used to treat asthma."]])], [], skipped);
    expect(facts.some((f) => /asthma/.test(f.text))).toBe(false);
    expect(skipped.some((s) => s.reason === "pronoun")).toBe(true);
  });

  it("a bullet that begins 'It …' is not resolved from the bullet beside it (only a sub-bullet hangs from its parent)", () => {
    const sibling = generate([blocksPage(1, "Drugs", [["• Epinephrine is the drug of choice for anaphylaxis.", "• It is used to treat asthma."]])]);
    expect(qa(sibling).some((c) => /asthma/i.test(c.a))).toBe(false);
    const child = generate([blocksPage(1, "Drugs", [["• Neostigmine is a reversible cholinesterase inhibitor.", "– It is used to treat myasthenia gravis."]])]);
    expect(answerTo(child, "What is neostigmine used to treat?")).toBe("Myasthenia gravis");
  });

  it("a sentence with its topic outside it ('At high doses …') gives no card", () => {
    const out = generate([blocksPage(1, "Epinephrine", [["Epinephrine is the drug of choice for anaphylaxis. At high doses alpha-1 effects predominate and cause vasoconstriction."]])]);
    expect(qa(out).some((c) => /vasoconstriction/i.test(c.a))).toBe(false);
  });

  it("lecturer questions, case vignettes and captions are not cards; 'There are …' is never 'What is There?'", () => {
    const out = generate([
      blocksPage(1, "Think about it", [["Why does ischemia cause more rapid injury than hypoxia?", "What happens to the cell if the insult persists?"]]),
      blocksPage(2, "Irreversible injury", [["There are two patterns of cell death: necrosis and apoptosis."]]),
      blocksPage(3, "Case", [["A 45-year-old farmer presents with pinpoint pupils and excessive salivation."]]),
      blocksPage(4, "Gangrene", [["Figure 2: Dry gangrene of the toes"], ["Dry gangrene is coagulative necrosis of a limb that has lost its blood supply."]]),
    ]);
    const cards = qa(out);
    expect(cards.some((c) => c.page === 1 || c.page === 3)).toBe(false);
    expect(cards.some((c) => /\bThere\b/.test(c.q))).toBe(false);
    expect(answerTo(out, "What are the two patterns of cell death?")).toBe("Necrosis and apoptosis");
    expect(cards.some((c) => /^Figure/.test(c.s))).toBe(false);
  });

  it("a caption-like 'Term: detail' standing alone is not a definition (left-sided heart failure is not pulmonary edema)", () => {
    const out = generate([blocksPage(1, "Heart failure", [["Left-sided heart failure: pulmonary edema"], ["Right-sided heart failure: nutmeg liver"], ["Left-sided heart failure most commonly causes pulmonary congestion and edema."]])]);
    expect(qa(out).some((c) => c.q === "What is left-sided heart failure?")).toBe(false);
    expect(answerTo(out, "What does left-sided heart failure most commonly cause?")).toBe("Pulmonary congestion and edema");
  });

  it("labelled items in a list are definitions; the list keeps every item", () => {
    const out = generate([blocksPage(1, "Irreversible injury", [["Nuclear changes in necrosis"], ["Pyknosis: nuclear shrinkage and increased basophilia", "Karyorrhexis: fragmentation of the pyknotic nucleus", "Karyolysis: fading of basophilia due to DNase activity"]])]);
    expect(answerTo(out, "What is pyknosis?")).toBe("Nuclear shrinkage and increased basophilia");
    expect(answerTo(out, "List: Nuclear changes in necrosis")).toBe("Pyknosis; Karyorrhexis; Karyolysis");
  });

  it("a paragraph after a numbered list is not one of its items", () => {
    const out = generate([blocksPage(1, "Virchow triad", [["Three factors predispose to thrombosis:", "1. Endothelial injury", "2. Abnormal blood flow", "3. Hypercoagulability", "Stasis is the major factor in venous thrombosis."]])]);
    expect(answerTo(out, "List: Three factors predispose to thrombosis")).toBe("Endothelial injury; Abnormal blood flow; Hypercoagulability");
  });
});

/* ------------------------------------------------------------------ */
/* 3. Atomic cards and quality filters                                  */
/* ------------------------------------------------------------------ */

describe("atomic cards: one retrieval, a short answer in the lecture's words", () => {
  it("a sentence with two facts gives two cards with one answer each", () => {
    const out = generate([blocksPage(1, "Cholinergic agonists", [["Pilocarpine is a muscarinic agonist used to treat glaucoma."]])]);
    expect(answerTo(out, "What is pilocarpine?")).toBe("A muscarinic agonist");
    expect(answerTo(out, "What is pilocarpine used to treat?")).toBe("Glaucoma");
  });

  it("relations: superlative, identity, cause, caused-by, action, location, timing, comparison, passive", () => {
    const out = generate([
      blocksPage(1, "Mechanisms", [[
        "Cocaine is the only local anesthetic that causes vasoconstriction.",
        "Acetylcholine is the neurotransmitter of postganglionic parasympathetic fibers.",
        "Mitochondrial damage leads to formation of the permeability transition pore.",
        "Right-sided heart failure is most often caused by left-sided heart failure.",
        "Organophosphates irreversibly inhibit acetylcholinesterase.",
        "Dystrophic calcification occurs in dead or dying tissues.",
        "Neutrophil infiltration peaks 1 to 3 days after infarction.",
        "Ischemia injures tissues faster than hypoxia alone.",
        "Sweat glands are innervated by sympathetic cholinergic fibers.",
      ]]),
    ]);
    expect(answerTo(out, "What is the only local anesthetic that causes vasoconstriction?")).toBe("Cocaine");
    expect(answerTo(out, "What is the neurotransmitter of postganglionic parasympathetic fibers?")).toBe("Acetylcholine");
    expect(answerTo(out, "What does mitochondrial damage lead to?")).toBe("Formation of the permeability transition pore");
    expect(answerTo(out, "What most often causes right-sided heart failure?")).toBe("Left-sided heart failure");
    expect(answerTo(out, "What do organophosphates irreversibly inhibit?")).toBe("Acetylcholinesterase");
    expect(answerTo(out, "Where does dystrophic calcification occur?")).toBe("In dead or dying tissues");
    expect(answerTo(out, "When does neutrophil infiltration peak?")).toBe("1 to 3 days after infarction");
    expect(answerTo(out, "Which injures tissues faster: ischemia or hypoxia alone?")).toBe("Ischemia");
    expect(answerTo(out, "Fill in the blank: Sweat glands are innervated by ___.")).toBe("Sympathetic cholinergic fibers");
  });

  it("plural subjects with examples, prepositional verbs, participle + preposition, and abbreviations as written", () => {
    const out = generate([
      blocksPage(1, "Anticoagulants", [[
        "Direct oral anticoagulants such as rivaroxaban inhibit factor Xa directly.",
        "Carcinomas typically spread through lymphatics.",
        "Heparin is monitored with the activated partial thromboplastin time.",
      ]]),
      blocksPage(2, "Monitoring", [["Drug\tMonitoring test", "Heparin\taPTT", "Warfarin\tPT/INR", "Dabigatran\tNone routinely"]]),
    ]);
    expect(answerTo(out, "What do direct oral anticoagulants such as rivaroxaban inhibit?")).toBe("Factor Xa directly");
    expect(answerTo(out, "What do carcinomas typically spread through?")).toBe("Lymphatics");
    expect(answerTo(out, "Fill in the blank: Heparin is monitored with ___.")).toBe("The activated partial thromboplastin time");
    expect(answerTo(out, "What is the monitoring test of heparin?")).toBe("aPTT");
  });

  it("a second clause with its own subject is its own card; a trailing reason is not part of an answer", () => {
    const out = generate([blocksPage(1, "Spread and safety", [[
      "Carcinomas typically spread through lymphatics, whereas sarcomas typically spread through the blood.",
      "Selectins mediate rolling and integrins mediate firm adhesion of leukocytes.",
      "Warfarin is contraindicated in pregnancy because it is teratogenic.",
    ]])]);
    expect(answerTo(out, "What do carcinomas typically spread through?")).toBe("Lymphatics");
    expect(answerTo(out, "What do sarcomas typically spread through?")).toBe("The blood");
    expect(answerTo(out, "What do selectins mediate?")).toBe("Rolling");
    expect(answerTo(out, "What do integrins mediate?")).toBe("Firm adhesion of leukocytes");
    expect(answerTo(out, "Fill in the blank: Warfarin is contraindicated in ___.")).toBe("Pregnancy");
  });

  const target = (over: Partial<LearningTarget>): LearningTarget => {
    const [fact] = extractFacts([blocksPage(1, "T", [["Cocaine blocks the reuptake of norepinephrine."]])]);
    return { subject: "Cocaine", relation: "action", fact: "The reuptake of norepinephrine", question: "What does cocaine block?", kind: "BASIC", sourcePage: 1, sourceExcerpt: "Cocaine blocks the reuptake of norepinephrine.", importance: 2, source: fact!, ordinal: 0, context: "", ...over };
  };
  const pageOf = blocksPage(1, "T", [["Cocaine blocks the reuptake of norepinephrine."], ["Amphetamine releases stored catecholamines."]]);

  it("the filters: pronoun, grammatical blank, leak, truncation, run-on, unsupported, question-only, merged excerpt", () => {
    expect(rejectTarget(target({}), pageOf)).toBeNull();
    expect(rejectTarget(target({ subject: "It" }), pageOf)).toBe("pronoun");
    expect(rejectTarget(target({ fact: "The" }), pageOf)).toBe("meaningless-blank");
    expect(rejectTarget(target({ question: "What does cocaine block, the reuptake of norepinephrine?" }), pageOf)).toBe("answer-leak");
    // The answer's words given away in another order are a leak too.
    expect(rejectTarget(target({ question: "What does cocaine do to norepinephrine reuptake?" }), pageOf)).toBe("answer-leak");
    expect(rejectTarget(target({ fact: "The reuptake of" }), pageOf)).toBe("truncated-answer");
    expect(rejectTarget(target({ fact: "The reuptake. Amphetamine releases catecholamines" }), pageOf)).toBe("multiple-targets");
    expect(rejectTarget(target({ fact: "The reuptake of serotonin" }), pageOf)).toBe("unsupported-answer");
    expect(rejectTarget(target({ question: "What does cocaine block in the heart?" }), pageOf)).toBe("unsupported-question");
    expect(rejectTarget(target({ sourceExcerpt: "Why does cocaine block norepinephrine?" }), pageOf)).toBe("question-only-source");
    // An excerpt that joins two blocks is not the page's text.
    expect(rejectTarget(target({ sourceExcerpt: "Cocaine blocks the reuptake of norepinephrine. Amphetamine releases stored catecholamines." }), pageOf)).toBe("excerpt-not-verbatim");
  });

  it("an incomplete list (an item cut off mid-phrase) is not a card", () => {
    const [list] = extractFacts([blocksPage(1, "Causes of cell injury", [["Hypoxia", "Physical agents and", "Chemical agents", "Infections"]])]).filter((f) => f.kind === "list");
    const [t] = targetsOf(list!);
    expect(rejectTarget(t!, blocksPage(1, "Causes of cell injury", [["Hypoxia", "Physical agents and", "Chemical agents", "Infections"]]))).toBe("incomplete-list");
  });

  it("excerpts are checked within one block (and on old unstructured pages, within the page text)", () => {
    const page = blocksPage(1, "T", [["Atropine increases heart rate."], ["Clonidine decreases sympathetic outflow."]]);
    expect(excerptOnPage("Atropine increases heart rate.", page)).toBe(true);
    expect(excerptOnPage("Atropine increases heart rate.\nClonidine decreases sympathetic outflow.", page)).toBe(false);
    expect(excerptOnPage("Atropine increases heart rate and decreases sympathetic outflow.", page)).toBe(false);
    expect(excerptOnPage("heart rate. Clonidine", { text: "Atropine increases heart\nrate. Clonidine decreases outflow." })).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Tables                                                            */
/* ------------------------------------------------------------------ */

describe("tables: a card per cell when the structure is reliable, none otherwise", () => {
  const receptors = blocksPage(1, "Autonomic receptors", [["Receptor\tG protein\tSecond messenger", "M1\tGq\tIncreased IP3 and DAG", "M2\tGi\tDecreased cAMP", "Beta-1\tGs\tIncreased cAMP"]]);

  it("entity rows: 'What is the <column> of <row>?', citing the header and the row", () => {
    const out = generate([receptors]);
    expect(answerTo(out, "What is the G protein of M1?")).toBe("Gq");
    expect(answerTo(out, "What is the second messenger of M2?")).toBe("Decreased cAMP");
    expect(answerTo(out, "What is the G protein of beta-1?")).toBe("Gs");
    const card = qa(out).find((c) => c.q === "What is the G protein of M1?")!;
    expect(card.s).toBe("Receptor\tG protein\tSecond messenger\nM1\tGq\tIncreased IP3 and DAG");
    // Never a relationship across rows.
    for (const c of qa(out)) expect(c.s.split("\n")).toHaveLength(2);
  });

  it("comparison tables compare one feature across the columns", () => {
    const out = generate([blocksPage(1, "Necrosis versus apoptosis", [["Feature\tNecrosis\tApoptosis", "Cell size\tEnlarged\tReduced", "Plasma membrane\tDisrupted\tIntact", "Inflammation\tFrequent\tNone"]])]);
    expect(answerTo(out, "Compare the plasma membrane in necrosis and apoptosis.")).toBe("Necrosis: Disrupted; Apoptosis: Intact");
  });

  it("'Type of shock' | 'Cardiogenic': the row is cardiogenic shock", () => {
    const out = generate([blocksPage(1, "Shock", [["Type of shock\tMechanism", "Cardiogenic\tMyocardial pump failure", "Hypovolemic\tLoss of blood volume", "Septic\tPeripheral vasodilation"]])]);
    expect(answerTo(out, "What is the mechanism of cardiogenic shock?")).toBe("Myocardial pump failure");
  });

  it("an unreliable table (ragged rows) gives no card and no guessed relationship", () => {
    const out = generate([blocksPage(1, "Drugs", [["Drug\tMechanism\tUse", "Atropine\tMuscarinic antagonist", "Clonidine\tAlpha-2 agonist\tHypertension\tExtra"]])]);
    expect(out.concepts).toHaveLength(0);
    expect(out.rejected["table-unreliable"]).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Coverage-aware counts                                             */
/* ------------------------------------------------------------------ */

describe("coverage: larger counts add distinct material; never filler; the shortfall says why", () => {
  const lecture = [
    blocksPage(1, "Cholinergic drugs", [["Bethanechol is a muscarinic agonist that is resistant to acetylcholinesterase. It is used to treat urinary retention.", "Pilocarpine is a muscarinic agonist used to treat glaucoma. It causes miosis."]]),
    blocksPage(2, "Receptors", [["Receptor\tG protein\tLocation", "M1\tGq\tStomach", "M2\tGi\tHeart", "M3\tGq\tSmooth muscle"]]),
    blocksPage(3, "Adrenergic drugs", [["Epinephrine is the drug of choice for anaphylaxis.", "Clonidine is a centrally acting alpha-2 agonist. It decreases sympathetic outflow.", "Cocaine blocks the reuptake of norepinephrine."]]),
    blocksPage(4, "Blockers", [["Prazosin is a selective alpha-1 antagonist used to treat hypertension.", "Beta blockers decrease heart rate and myocardial contractility."]]),
  ];

  it("5 ⊂ 10 ⊂ 15, the first cards cover every section, and no card repeats a question", () => {
    const ids = (n: number) => new Set(generate(lecture, n).concepts.map((c) => c.id));
    const [five, ten, fifteen] = [ids(5), ids(10), ids(15)];
    for (const id of five) expect(ten.has(id)).toBe(true);
    for (const id of ten) expect(fifteen.has(id)).toBe(true);
    expect(new Set(generate(lecture, 5).concepts.map((c) => c.source.pageNumber))).toEqual(new Set([1, 2, 3, 4]));
    const prompts = generate(lecture, 50).concepts.map((c) => c.retrievalItems[0]!.prompt);
    expect(new Set(prompts).size).toBe(prompts.length);
  });

  it("'Generate more' continues the same order: 5, then 5 more, are the 10 of a single run", () => {
    const first = generate(lecture, 5);
    const existing = first.concepts.map((c) => ({ id: c.id, title: c.title, summary: c.summary }));
    const more = generateCards({ courseId: "course", lectureId: "lecture", document: { id: "doc", title: "Doc", pages: lecture }, language: "en", count: 5, existing });
    const both = new Set([...first.concepts, ...more.concepts].map((c) => c.id));
    expect(both).toEqual(new Set(generate(lecture, 10).concepts.map((c) => c.id)));
  });

  it("more than the lecture supports: every valid card, a shortfall, reason 'source'", () => {
    const out = generate(lecture, 100);
    expect(out.concepts.length).toBe(out.available);
    expect(out.shortfall).toBe(100 - out.available);
    expect(out.shortfallReason).toBe("source");
  });

  it("material that could not be read reliably is reported as 'extraction', not padded", () => {
    const unreadable = blocksPage(1, "Epinephrine", [[
      "At low doses it has predominantly beta effects.", "At high doses alpha-1 effects predominate.", "In the heart it increases contractility.",
      "With repeated dosing tachyphylaxis develops.", "During anaphylaxis it reverses bronchospasm.", "Epinephrine is the drug of choice for anaphylaxis.",
    ]]);
    const out = generate([unreadable], 3);
    expect(out.concepts.length).toBe(1);
    expect(out.shortfallReason).toBe("extraction");
    expect(out.rejected["no-subject"]).toBeGreaterThanOrEqual(4);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Images                                                            */
/* ------------------------------------------------------------------ */

describe("images: conservative grounding", () => {
  const PAGE = { width: 960, height: 540 };
  const region = (x0: number, x1: number) => ({ x: x0 / 960, y: 100 / 540, w: (x1 - x0) / 960, h: 250 / 540 });
  const text = (str: string, x: number, y: number, width: number): PositionedText => ({ str, transform: [14, 0, 0, 14, x, y], width, height: 14 });
  const left: FigureCandidate = { kind: "raster", region: region(80, 420) };
  const right: FigureCandidate = { kind: "raster", region: region(520, 860) };

  it("each caption belongs to the figure it sits under, never to its neighbour", () => {
    const [a, b] = annotateFigures([left, right], [text("Figure 1: Wet gangrene of the foot", 90, 170, 230), text("Figure 2: Dry gangrene of the toes", 530, 170, 225)], PAGE);
    expect(a!.caption).toBe("Figure 1: Wet gangrene of the foot");
    expect(b!.caption).toBe("Figure 2: Dry gangrene of the toes");
  });

  it("a caption line spanning both figures belongs to neither", () => {
    const [a, b] = annotateFigures([left, right], [text("Figure 3: Two forms of gangrene of the lower limb compared", 300, 170, 380)], PAGE);
    expect(a!.caption).toBeUndefined();
    expect(b!.caption).toBeUndefined();
  });

  it("wet vs dry, left vs right: a card never shows the other subtype's picture", () => {
    const visuals: PageVisuals[] = [{ pageNumber: 1, textChars: 0, figures: [{ ...left, caption: "Figure 1: Wet gangrene of the foot" }, { ...right, caption: "Figure 2: Dry gangrene of the toes" }] }];
    const out = generate([blocksPage(1, "Gangrene", [["Dry gangrene is coagulative necrosis of a limb that has lost its blood supply.", "Wet gangrene occurs when bacterial infection is superimposed."]])], 50, visuals);
    const dry = qa(out).find((c) => c.q === "What is dry gangrene?")!;
    const wet = qa(out).find((c) => c.q === "When does wet gangrene occur?")!;
    expect(dry.image?.assetId).toBe("doc#p1#f1");
    expect(wet.image?.assetId).toBe("doc#p1#f0");
    const hf: PageVisuals[] = [{ pageNumber: 1, textChars: 0, figures: [{ ...left, caption: "Left-sided heart failure: pulmonary edema" }] }];
    const heart = generate([blocksPage(1, "Heart failure", [["Right-sided heart failure causes congestive hepatomegaly."]])], 50, hf);
    expect(qa(heart).find((c) => c.q === "What does right-sided heart failure cause?")!.image).toBeUndefined();
  });

  it("a table image, a shared or positional caption, or a text slide is never an image answer nor a card's picture", () => {
    const visuals: PageVisuals[] = [{
      pageNumber: 1,
      textChars: 0,
      figures: [
        { ...left, caption: "Table 2: Classification of amyloidosis" },
        { ...right, caption: "Figure 3: Wet (left) and dry (right) gangrene" },
        { kind: "diagram", region: region(80, 860), labels: Array.from({ length: 20 }, (_, i) => `row ${i} amyloidosis`) },
      ],
    }];
    const out = generate([blocksPage(1, "Amyloidosis", [["Amyloidosis is classified by the protein deposited.", "Wet gangrene shows a swollen limb."]])], 50, visuals);
    expect(qa(out).filter((c) => c.image)).toHaveLength(0);
  });

  it("different pictures in the same slot on many slides are figures; a shared logo is not", () => {
    const img = (objId: string, x: number, w: number) => ({ objId, region: { x, y: 0.2, w, h: 0.45 }, width: 640, height: 480 });
    const logo = { objId: "g_d0_img_p1_1", region: { x: 0.92, y: 0.02, w: 0.06, h: 0.11 }, width: 220, height: 220 };
    const pages: PageVisualAnalysis[] = [1, 2, 3, 4, 5].map((n) => ({ pageNumber: n, width: 960, height: 540, images: [logo, img(`img_p${n}_1`, 0.08, 0.36)], pathOps: 0, pathBounds: null, textChars: 100 }));
    const selected = selectFigures(pages);
    for (const page of selected) expect(page.figures).toHaveLength(1);
    expect(selected[0]!.figures[0]!.region.x).toBeCloseTo(0.08);
  });
});
