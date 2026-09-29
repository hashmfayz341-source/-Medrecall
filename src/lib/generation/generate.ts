import { normalize } from "@/lib/domain/text";
import type { CardImage, CardLanguage, Concept, ConceptImportance, RetrievalItem, RetrievalKind, SourceDocument } from "@/lib/domain/types";
import { captionKey, captionTarget, figureAssetId, sameImage, type PageVisuals } from "@/lib/visuals/analyze";
import {
  isStructureWord,
  renderCloze,
  renderDefinition,
  renderFigure,
  renderList,
  renderMechanism,
  renderSuperlative,
  type ArabicMode,
  type Coverage,
  type RenderedArabic,
} from "./arabic";
import { extractFacts, factsOverlap, splitMechanism, type Fact } from "./facts";
import { templatesFor } from "./language";

/**
 * Lecture → flashcards.
 *
 * Every generated card is one DRAFT Concept with one RetrievalItem: the
 * Concept keeps MedRecall's semantic layer (approval gate, provenance,
 * mastery, the Tutor) and the item is the card the learner studies. Ids are
 * deterministic (`${document}-p${page}-f${fact}`), so generating again
 * yields the same ids for the same facts and "Generate more" can skip what
 * already exists without touching its FSRS history.
 *
 * A lecture may have several documents; generation runs over the ones it is
 * given, and every card keeps the exact document, page, excerpt and image
 * of the fact it came from.
 */

export interface ExistingCard {
  id: string;
  title: string;
  summary: string;
}

export type CardCount = number | "auto";

/** One source document of the lecture, with the figures found in it (possibly none). */
export interface GenerationDocument extends Pick<SourceDocument, "id" | "title" | "pages"> {
  visuals?: readonly PageVisuals[];
}

export interface GenerateCardsInput {
  courseId: string;
  lectureId: string;
  /** The documents to generate from. */
  documents?: readonly GenerationDocument[];
  /** Single-document form (kept for callers that generate from one PDF). */
  document?: Pick<SourceDocument, "id" | "title" | "pages">;
  visuals?: readonly PageVisuals[];
  language: CardLanguage;
  count: CardCount;
  /** Cards the LECTURE already has (every document), so nothing is generated twice. */
  existing: readonly ExistingCard[];
}

export interface GeneratedCards {
  concepts: Concept[];
  requested: CardCount;
  /** Distinct, grounded facts available after removing what already exists. */
  available: number;
  /** How many fewer cards than requested could be made (0 when satisfied or AUTO). */
  shortfall: number;
  /**
   * For the Arabic modes: cards written as Arabic sentences by the
   * deterministic templates, and cards where part of the lecture's English
   * wording was kept because the sentence is outside the supported patterns
   * (disclosed in the UI, never hidden). Both zero in English.
   */
  coverage: { arabic: number; partial: number };
  /** The partial cards' ids (Arabic modes), so a reviewer can find them. */
  partialIds: string[];
}

/** AUTO keeps facts at or above this score: the important material, once. */
export const AUTO_MIN_SCORE = 1.5;
export const MAX_CARD_COUNT = 500;

export function factId(documentId: string, fact: Pick<Fact, "pageNumber" | "index">): string {
  return `${documentId}-p${fact.pageNumber}-f${fact.index}`;
}

const STOP = new Set(["the", "and", "that", "this", "with", "from", "into", "which", "when", "than", "then", "their", "there", "they", "them", "its", "for", "are", "was", "were", "has", "have", "had", "been", "being", "most", "more", "much", "many", "some", "such", "also", "very", "other", "because", "about", "after", "before", "between", "during", "through", "while", "would", "could", "should", "over", "under", "both", "each", "not", "but", "can", "may", "will", "one", "within", "cells", "cell"]);

function keywords(text: string, limit: number): string[] {
  const out: string[] = [];
  for (const word of normalize(text).split(/\s+/)) {
    if (word.length < 4 || STOP.has(word) || out.includes(word)) continue;
    out.push(word);
    if (out.length >= limit) break;
  }
  return out;
}

function blank(sentence: string, part: string): string {
  const idx = sentence.indexOf(part);
  return idx >= 0 ? `${sentence.slice(0, idx)}___${sentence.slice(idx + part.length)}` : `___ ${sentence}`;
}

/** A fact located in its document. */
interface Located {
  fact: Fact;
  documentId: string;
}

/** The Arabic rendering of a fact, from its structure. Falls back to an Arabic cloze, never to a wrapped English sentence. */
function arabicFor(fact: Fact, mode: ArabicMode): RenderedArabic {
  let rendered: RenderedArabic | null = null;
  switch (fact.kind) {
    case "superlative":
      rendered = fact.subject && fact.consequence ? renderSuperlative(fact.subject, fact.consequence, mode) : null;
      break;
    case "definition":
      rendered = fact.subject ? renderDefinition(fact.subject, fact.text.slice(fact.subject.length).trim(), mode) : null;
      break;
    case "mechanism": {
      const parts = splitMechanism(fact.text);
      rendered = parts ? renderMechanism(parts.cause, parts.connector, parts.consequence, mode) : null;
      break;
    }
    case "list":
      rendered = renderList(fact.term, fact.items ?? [], mode);
      break;
    case "figure": {
      const answer = fact.figure?.answer ?? fact.term;
      const heading = fact.heading && !normalize(answer).includes(normalize(fact.heading)) && !normalize(fact.heading).includes(normalize(answer)) ? fact.heading : null;
      rendered = renderFigure(answer.charAt(0).toUpperCase() + answer.slice(1), heading, mode);
      break;
    }
  }
  return rendered ?? renderCloze(fact.text, fact.subject ?? fact.term, mode);
}

/** The visual answer, capitalised, with the slide heading when the caption does not already name it. */
function figureAnswer(fact: Fact): string {
  const answer = fact.figure?.answer ?? fact.term;
  const text = answer.charAt(0).toUpperCase() + answer.slice(1);
  if (fact.heading && !normalize(answer).includes(normalize(fact.heading)) && !normalize(fact.heading).includes(normalize(answer))) {
    return `${text} (${fact.heading})`;
  }
  return text;
}

function itemFor(fact: Fact, conceptId: string, language: CardLanguage, documentId: string): { item: RetrievalItem; coverage: Coverage | null } {
  const t = templatesFor(language);
  const term = fact.term;
  let kind: RetrievalKind = "BASIC";
  let prompt: string;
  let acceptable: string[] = [];
  let required: string[][];
  let image: CardImage | undefined;

  switch (fact.kind) {
    case "definition":
      prompt = t.definition(term);
      required = keywords(fact.text.slice(fact.subject ? fact.subject.length : 0), 2).map((k) => [k]);
      break;
    case "superlative":
      prompt = t.superlative(fact.consequence ?? fact.text);
      acceptable = [term, ...(fact.subject && fact.subject !== term ? [fact.subject] : [])];
      required = [[normalize(term)]];
      break;
    case "mechanism":
      kind = "MECHANISM";
      prompt = t.mechanism(blank(fact.text, fact.consequence ?? ""));
      required = keywords(fact.consequence ?? fact.text, 2).map((k) => [k]);
      break;
    case "list":
      prompt = t.list(term);
      required = (fact.items ?? []).slice(0, 3).map((item) => keywords(item, 1)).filter((k) => k.length > 0);
      break;
    case "figure":
      kind = "IMAGE";
      prompt = t.figure();
      acceptable = [fact.figure?.answer ?? term];
      required = [keywords(fact.figure?.answer ?? term, 2)].filter((k) => k.length > 0);
      image = {
        assetId: figureAssetId(documentId, fact.pageNumber, fact.figure?.index ?? 0),
        documentId,
        pageNumber: fact.pageNumber,
        region: fact.figure?.region,
        placement: "front",
      };
      break;
    default:
      kind = "CLOZE";
      prompt = t.cloze(blank(fact.text, fact.subject ?? term));
      acceptable = [term, ...(fact.subject && fact.subject !== term ? [fact.subject] : [])];
      required = [[normalize(term)]];
  }
  if (required.length === 0) required = [[normalize(term)]];
  let explanation =
    fact.kind === "list" ? (fact.items ?? []).join("; ") : fact.kind === "figure" ? `${figureAnswer(fact)}.` : fact.text;
  let coverage: Coverage | null = null;
  if (language !== "en") {
    // The Arabic modes write the question AND the answer from the fact's
    // structure; the verbatim English stays the card's source excerpt.
    const rendered = arabicFor(fact, language);
    prompt = rendered.prompt;
    explanation = rendered.explanation;
    coverage = rendered.coverage;
  }
  const item: RetrievalItem = { id: `${conceptId}-r1`, conceptId, kind, prompt, requiredKeywords: required, acceptableAnswers: acceptable, explanation };
  return { item: image ? { ...item, image } : item, coverage };
}

/** The same fact phrased as a cloze, when its natural prompt would repeat an earlier card's. */
function asCloze(fact: Fact): Fact {
  return { ...fact, kind: "statement" };
}

/**
 * Words too generic to show, on their own, that a figure is about a
 * sentence: shared by most slides of a pathology lecture ("necrosis",
 * "injury", "tissue") or by any image ("figure", "section", "stain").
 */
const GENERIC = new Set([
  "cell", "cells", "cellular", "change", "changes", "figure", "image", "tissue", "tissues", "shown", "showing", "from", "with",
  "normal", "necrosis", "necrotic", "injury", "injuries", "damage", "damaged", "disease", "diseases", "lesion", "lesions",
  "inflammation", "inflammatory", "infection", "tumour", "tumor", "tumours", "tumors", "cancer", "death", "degeneration",
  "pattern", "patterns", "type", "types", "stage", "stages", "section", "sections", "stain", "stained", "staining", "view",
  "specimen", "patient", "patients", "organ", "organs", "acute", "chronic", "early", "late", "severe", "mild", "micrograph",
  "photomicrograph", "histology", "magnification", "arrow", "arrows", "power", "field", "area", "areas", "region", "feature",
  "features", "example", "appearance", "typical", "classic",
]);

/** Prepositions that end a caption's subject: "coagulative necrosis | of myocardial fibres". */
const SUBJECT_END = /\s+(?:of|in|with|showing|from|at|on|after|during|within|following|and|versus|vs)\s+/i;

interface PageFigure {
  image: CardImage;
  /** What the figure is: the caption's subject, and each label — as phrases and as named entities. */
  names: { phrase: string; entity: Entity | null }[];
  /** The caption subject's specific words (stemmed), for a reworded mention ("carcinoma of papillary type"). */
  subjectWords: string[];
  /** Specific words of the rest of the caption ("… in rapidly progressive glomerulonephritis"). */
  contextWords: Set<string>;
}

/*
 * A named entity: the head noun of a phrase and its modifiers — "papillary
 * thyroid carcinoma" is a carcinoma with modifiers {papillary, thyroid};
 * "type I hypersensitivity" a hypersensitivity with {type, i}. Two phrases
 * with the same head are the same thing only when their modifiers agree:
 * papillary vs medullary, acute vs chronic, small cell vs non-small cell,
 * type I vs type II, proximal vs distal are different entities.
 */
interface Entity {
  head: string;
  modifiers: string[];
}

const FUNCTION_WORDS = new Set(["the", "a", "an", "of", "in", "with", "from", "to", "at", "on", "and", "or", "for", "by", "showing", "after", "during", "within", "following", "versus", "vs"]);
/** A label after the head: "hepatitis B", "type II", "stage 3", "grade 2a". */
const LABEL_TOKEN = /^([a-z]|[ivx]+|\d+[a-z]?)$/;
/** Plural-insensitive comparison: "crescents" / "crescent", "deposits" / "deposit". */
const stem = (w: string) => (w.length > 4 && /s$/.test(w) && !/(ss|is|us)$/.test(w) ? w.slice(0, -1) : w);
const wordsOf = (text: string) => normalize(text.replace(/\([^)]*\)/g, " ")).split(" ").filter(Boolean);

function entityOf(phrase: string): Entity | null {
  const words = wordsOf(phrase);
  while (words.length > 0 && FUNCTION_WORDS.has(words[0]!)) words.shift();
  // A relation ("from ATP depletion to cellular swelling") is not one named thing.
  if (words.length === 0 || words.some((w) => FUNCTION_WORDS.has(w))) return null;
  let h = words.length - 1;
  while (h > 0 && LABEL_TOKEN.test(words[h]!)) h--;
  return { head: stem(words[h]!), modifiers: words.filter((w, i) => i !== h && !FUNCTION_WORDS.has(w)).map(stem) };
}

/** A specific word: not generic, not a function word, at least three letters (labels like "B" are compared as modifiers). */
const specific = (w: string) => w.length >= 3 && !GENERIC.has(w) && !FUNCTION_WORDS.has(w);

/**
 * A participle clause after the subject also ends it: "type I pneumocytes |
 * lining an alveolus" (an -ing word followed by a determiner — not
 * "hepatocyte ballooning", where the -ing word is part of the name).
 */
const PARTICIPLE_END = /\s+(?=[a-z]{3,}ing\s+(?:a|an|the|its|their)\s)/i;

function pageFigure(image: CardImage, caption: string | undefined, labels: readonly string[]): PageFigure | null {
  const target = caption ? captionTarget(caption) : "";
  const [clause = "", ...after] = target.split(SUBJECT_END);
  const [subject = "", ...participle] = clause.split(PARTICIPLE_END);
  const rest = [...participle, ...after];
  const names = [subject, ...labels]
    .map((p) => normalize(p.replace(/\([^)]*\)/g, " ")))
    .filter((p) => p.length > 0)
    .map((phrase) => ({ phrase, entity: entityOf(phrase) }));
  const subjectWords = wordsOf(subject).filter(specific).map(stem);
  const contextWords = new Set(wordsOf(rest.join(" ")).filter(specific).map(stem));
  return names.length === 0 ? null : { image, names, subjectWords, contextWords };
}

/** A phrase that names something specific: at least one word that is not generic. */
const specificPhrase = (phrase: string) => phrase.split(" ").some(specific);

/**
 * Whether the card is about a DIFFERENT entity of the same kind as the
 * figure: its topic has the figure's head noun but a modifier the figure
 * lacks (papillary vs medullary carcinoma), or the figure has a modifier
 * the card never mentions (a papillary carcinoma image on a card about
 * thyroid carcinoma in general). Either way the picture may show something
 * else: no image.
 */
function conflicts(figure: Entity, topics: readonly Entity[], cardWords: ReadonlySet<string>): boolean {
  return topics.some(
    (topic) =>
      topic.head === figure.head &&
      (topic.modifiers.some((m) => !figure.modifiers.includes(m)) || figure.modifiers.some((m) => !cardWords.has(m))),
  );
}

/**
 * How the card's own text names things with the figure's head noun: each
 * occurrence with the words right before it (as many as the figure has
 * modifiers, stopping at sentence structure — "causes | failure") and a
 * label right after it ("hepatitis B"). "Type II pneumocytes" next to a
 * "type I pneumocytes" figure is a different entity even when the extracted
 * topic of the card was cut short.
 */
function mentionsOf(words: readonly string[], figure: Entity): Entity[] {
  const out: Entity[] = [];
  const span = figure.modifiers.length;
  words.forEach((word, i) => {
    if (stem(word) !== figure.head) return;
    const modifiers: string[] = [];
    if (LABEL_TOKEN.test(words[i + 1] ?? "") && !FUNCTION_WORDS.has(words[i + 1]!)) modifiers.push(words[i + 1]!);
    for (let k = i - 1; k >= 0 && i - k <= span; k--) {
      const w = words[k]!;
      if (FUNCTION_WORDS.has(w) || isStructureWord(w)) break;
      modifiers.push(stem(w));
    }
    out.push({ head: figure.head, modifiers });
  });
  return out;
}

/**
 * A figure belongs on the back of a text card only on strong evidence that it
 * shows what the card is about (no image is better than a wrong one):
 * - never when the card's topic is a different entity of the same kind
 *   (`conflicts`) — a subtype, a stage, a type number, "acute" vs
 *   "chronic" — whatever words they share;
 * - otherwise when the card names the figure's subject or one of its labels
 *   as a specific phrase ("coagulative necrosis", "plaque rupture",
 *   "steatosis"), never a generic word alone ("necrosis");
 * - or mentions every specific word of the figure's subject in other words
 *   ("thyroid carcinoma of papillary type");
 * - or names a one-word subject and shares a specific word of the caption's
 *   context ("crescents in rapidly progressive glomerulonephritis").
 * Shared family or anatomy words alone ("thyroid", "carcinoma") never
 * attach. A figure with no caption and no labels is never attached;
 * figures come from the card's own page only.
 */
function relatedFigure(fact: Fact, figures: readonly PageFigure[]): CardImage | undefined {
  const text = ` ${normalize(`${fact.text} ${fact.term}`)} `;
  const cardWords = new Set(wordsOf(`${fact.text} ${fact.term}`).map(stem));
  const topics = [fact.term, fact.subject ?? ""]
    .map((t) => entityOf(t.replace(/\([^)]*\)/g, " ").split(SUBJECT_END)[0]!))
    .filter((e): e is Entity => e !== null);
  // Each sentence or list item on its own, so words of one are never read as modifiers of the next.
  const segments = [fact.text, fact.term].flatMap((t) => t.split(/[.;:!?\n]+/)).map(wordsOf).filter((w) => w.length > 0);
  for (const figure of figures) {
    if (figure.names.some((n) => n.entity && conflicts(n.entity, [...topics, ...segments.flatMap((s) => mentionsOf(s, n.entity!))], cardWords))) continue;
    const named = figure.names.some((n) => specificPhrase(n.phrase) && text.includes(` ${n.phrase} `));
    const reworded = figure.subjectWords.length >= 2 && figure.subjectWords.every((w) => cardWords.has(w));
    const withContext =
      figure.subjectWords.length === 1 && cardWords.has(figure.subjectWords[0]!) && [...figure.contextWords].some((w) => cardWords.has(w));
    if (named || reworded || withContext) return { ...figure.image, placement: "back" };
  }
  return undefined;
}

function conceptFor(located: Located, input: GenerateCardsInput, figuresOnPage: Map<string, PageFigure[]>): { concept: Concept; coverage: Coverage | null } {
  const { fact, documentId } = located;
  const id = factId(documentId, fact);
  const { item, coverage } = itemFor(fact, id, input.language, documentId);
  const support = !item.image ? relatedFigure(fact, figuresOnPage.get(`${documentId}#${fact.pageNumber}`) ?? []) : undefined;
  const importance: ConceptImportance = fact.score >= 2 ? "CORE" : "SUPPORTING";
  const concept: Concept = {
    id,
    courseId: input.courseId,
    lectureId: input.lectureId,
    title:
      fact.kind === "figure"
        ? `${figureAnswer(fact)} (figure, page ${fact.pageNumber})`
        : fact.term.length > 90
          ? `${fact.term.slice(0, 87)}…`
          : fact.term,
    summary:
      fact.kind === "list"
        ? `${fact.term}: ${(fact.items ?? []).join("; ")}`
        : fact.kind === "figure"
          ? `Figure on page ${fact.pageNumber}: ${figureAnswer(fact)}`
          : fact.text,
    importance,
    status: "DRAFT",
    prerequisiteIds: [],
    source: {
      courseId: input.courseId,
      lectureId: input.lectureId,
      documentId,
      pageNumber: fact.pageNumber,
      excerpt: fact.text,
    },
    retrievalItems: [support ? { ...item, image: support } : item],
  };
  return { concept, coverage };
}

/**
 * Pictures that appear more than once with captions that disagree: the same
 * picture — perceptual hashes equal or within a few bits (`sameImage`: the
 * same image re-rendered or resized), across pages and documents — captioned
 * as two different things. Such a picture cannot be the answer to either
 * caption, nor illustrate a card: the asset ids of every copy.
 */
function contradictoryFigures(documents: readonly GenerationDocument[]): Set<string> {
  const figures = documents.flatMap((doc) =>
    (doc.visuals ?? []).flatMap((page) =>
      page.figures.flatMap((figure, i) =>
        figure.contentHash && figure.caption
          ? [{ assetId: figureAssetId(doc.id, page.pageNumber, i), hash: figure.contentHash, caption: captionKey(captionTarget(figure.caption)) }]
          : [],
      ),
    ),
  );
  const contradictory = new Set<string>();
  for (const group of sameImageGroups(figures.map((f) => f.hash))) {
    const members = group.map((i) => figures[i]!);
    if (new Set(members.map((m) => m.caption)).size > 1) for (const m of members) contradictory.add(m.assetId);
  }
  return contradictory;
}

/** Indexes grouped by "same picture" (connected components of `sameImage`; a handful of figures, so pairwise is fine). */
function sameImageGroups(hashes: readonly string[]): number[][] {
  const parent = hashes.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]!)));
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) if (sameImage(hashes[i], hashes[j])) parent[root(j)] = root(i);
  }
  const groups = new Map<number, number[]>();
  hashes.forEach((_, i) => groups.set(root(i), [...(groups.get(root(i)) ?? []), i]));
  return [...groups.values()];
}

/**
 * One picture, one answer. A picture with contradictory captions
 * (`contradictoryFigures`) never becomes a question; copies of one picture
 * whose captions agree keep a single image question (the first). Provenance
 * is untouched: every asset stays on its own page.
 */
function dropRepeatedFigures(facts: readonly Located[], contradictory: ReadonlySet<string>): Located[] {
  const assetOf = (l: Located) => figureAssetId(l.documentId, l.fact.pageNumber, l.fact.figure!.index);
  const figures = facts.filter((l) => l.fact.kind === "figure" && l.fact.figure?.contentHash);
  const drop = new Set<Located>(figures.filter((l) => contradictory.has(assetOf(l))));
  for (const group of sameImageGroups(figures.map((l) => l.fact.figure!.contentHash!))) {
    for (const i of group.slice(1)) drop.add(figures[i]!);
  }
  return facts.filter((l) => !drop.has(l) && !(l.fact.kind === "figure" && contradictory.has(assetOf(l))));
}

/**
 * An image question that asks for what a text card already asks — its
 * answer is that card's statement or that card's term — adds no retrieval
 * value. It is dropped; its figure still illustrates the text card's back
 * when related.
 */
function isRedundantFigure(figure: Fact, textFacts: readonly Fact[]): boolean {
  const answer = normalize(figure.figure?.answer ?? "");
  if (!answer) return true;
  return textFacts.some((t) => factsOverlap({ text: figure.figure!.answer }, t) || normalize(t.term) === answer);
}

function documentsOf(input: GenerateCardsInput): GenerationDocument[] {
  if (input.documents && input.documents.length > 0) return [...input.documents];
  if (input.document) return [{ ...input.document, visuals: input.visuals ?? [] }];
  return [];
}

/**
 * Generate cards for a lecture's documents. Pure and deterministic.
 *
 * - Facts already covered by `existing` cards (same id, or the same
 *   statement, from ANY document of the lecture) are skipped, so a second
 *   run adds only new material and never touches existing cards.
 * - A requested count larger than the distinct facts available yields the
 *   maximum useful set and a `shortfall`; facts are never duplicated or
 *   padded to reach a number.
 * - AUTO keeps every fact scoring at least `AUTO_MIN_SCORE`.
 * - Selected cards are returned in document then page order.
 */
export function generateCards(input: GenerateCardsInput): GeneratedCards {
  const requested = input.count === "auto" ? "auto" : Math.max(1, Math.min(MAX_CARD_COUNT, Math.floor(input.count)));
  const documents = documentsOf(input);
  const documentOrder = new Map(documents.map((d, i) => [d.id, i]));

  const extracted: Located[] = documents.flatMap((doc) =>
    extractFacts(doc.pages, doc.visuals ?? []).map((fact) => ({ fact, documentId: doc.id })),
  );
  const textFacts = extracted.filter((l) => l.fact.kind !== "figure").map((l) => l.fact);
  const contradictory = contradictoryFigures(documents);
  const all = dropRepeatedFigures(extracted, contradictory).filter((l) => l.fact.kind !== "figure" || !isRedundantFigure(l.fact, textFacts));

  const existingIds = new Set(input.existing.map((e) => e.id));
  const existingTexts = input.existing.map((e) => ({ text: e.summary }));

  // Dedupe against what exists, then among the new facts (best score wins).
  const fresh = all.filter(({ fact, documentId }) => {
    if (existingIds.has(factId(documentId, fact))) return false;
    if (fact.kind === "figure") return true;
    return !existingTexts.some((e) => factsOverlap(e, fact));
  });
  const order = (a: Located, b: Located) =>
    (documentOrder.get(a.documentId) ?? 0) - (documentOrder.get(b.documentId) ?? 0) || a.fact.pageNumber - b.fact.pageNumber || a.fact.index - b.fact.index;
  const ranked = [...fresh].sort((a, b) => b.fact.score - a.fact.score || order(a, b));
  const kept: Located[] = [];
  for (const located of ranked) {
    const { fact } = located;
    if (fact.kind !== "figure" && kept.some((k) => k.fact.kind !== "figure" && factsOverlap(k.fact, fact))) continue;
    kept.push(located);
  }

  // Figures available per page (with what they are about), for the back of
  // text cards on that page that say the same thing.
  const figuresOnPage = new Map<string, PageFigure[]>();
  for (const doc of documents) {
    for (const page of doc.visuals ?? []) {
      page.figures.forEach((figure, i) => {
        const image: CardImage = { assetId: figureAssetId(doc.id, page.pageNumber, i), documentId: doc.id, pageNumber: page.pageNumber, region: figure.region, placement: "back" };
        if (contradictory.has(image.assetId)) return;
        const described = pageFigure(image, figure.caption, figure.labels ?? []);
        if (!described) return;
        const key = `${doc.id}#${page.pageNumber}`;
        figuresOnPage.set(key, [...(figuresOnPage.get(key) ?? []), described]);
      });
    }
  }

  // Two facts about the same term would ask the same question ("What is X?")
  // with different answers; the later one is asked as a cloze instead, and a
  // prompt that still repeats is dropped rather than shown twice. Image
  // questions are distinct by the figure they show. Done before the count is
  // applied, so a requested number is met whenever enough distinct cards
  // exist.
  const prompts = new Set<string>();
  const candidates: { located: Located; concept: Concept; coverage: Coverage | null }[] = [];
  for (const located of kept) {
    const isFigure = located.fact.kind === "figure";
    const keyOf = (c: Concept) => (isFigure ? `figure:${c.retrievalItems[0]!.image?.assetId}` : normalize(c.retrievalItems[0]!.prompt));
    let built = conceptFor(located, input, figuresOnPage);
    let key = keyOf(built.concept);
    if (prompts.has(key) && !isFigure) {
      built = conceptFor({ ...located, fact: asCloze(located.fact) }, input, figuresOnPage);
      key = keyOf(built.concept);
    }
    if (prompts.has(key)) continue;
    prompts.add(key);
    candidates.push({ located, ...built });
  }

  const selected =
    requested === "auto" ? candidates.filter((c) => c.located.fact.score >= AUTO_MIN_SCORE) : candidates.slice(0, requested);
  selected.sort((a, b) => order(a.located, b.located));
  const concepts = selected.map((c) => c.concept);
  return {
    concepts,
    requested,
    available: candidates.length,
    shortfall: requested === "auto" ? 0 : Math.max(0, requested - concepts.length),
    coverage: {
      arabic: selected.filter((c) => c.coverage === "arabic").length,
      partial: selected.filter((c) => c.coverage === "partial").length,
    },
    partialIds: selected.filter((c) => c.coverage === "partial").map((c) => c.concept.id),
  };
}
