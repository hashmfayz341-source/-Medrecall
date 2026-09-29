import { normalize } from "@/lib/domain/text";
import { contentWords } from "@/lib/domain/duplicates";
import type { CardImage, CardLanguage, Concept, ConceptImportance, RetrievalItem, RetrievalKind, SourceDocument } from "@/lib/domain/types";
import { captionKey, figureAssetId, type PageVisuals } from "@/lib/visuals/analyze";
import {
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

/** Words too generic to show that a figure is about a sentence. */
const GENERIC = new Set(["cell", "cells", "cellular", "change", "changes", "figure", "image", "tissue", "shown", "showing", "from", "with", "normal"]);

interface PageFigure {
  image: CardImage;
  /** Content words of the figure's caption and labels: what it is about. */
  words: Set<string>;
}

/**
 * A figure belongs on the back of a text card only when its caption or
 * labels share a specific word with the card's sentence — i.e. it is
 * demonstrably about the same thing. A figure with no caption and no labels
 * is never attached.
 */
function relatedFigure(fact: Fact, figures: readonly PageFigure[]): CardImage | undefined {
  const words = contentWords(`${fact.text} ${fact.term}`);
  for (const figure of figures) {
    for (const w of words) if (!GENERIC.has(w) && figure.words.has(w)) return { ...figure.image, placement: "back" };
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
 * One picture, one answer. Figures whose rendered content is identical
 * (same perceptual hash, across pages and documents) keep a single image
 * question when their captions agree; when the captions disagree the
 * picture cannot be the answer to either, so neither becomes a question.
 * Provenance is untouched: every asset stays on its own page.
 */
function dropContradictoryFigures(facts: readonly Located[]): Located[] {
  const byHash = new Map<string, Located[]>();
  for (const located of facts) {
    const hash = located.fact.figure?.contentHash;
    if (located.fact.kind !== "figure" || !hash) continue;
    byHash.set(hash, [...(byHash.get(hash) ?? []), located]);
  }
  const drop = new Set<Located>();
  for (const group of byHash.values()) {
    if (group.length < 2) continue;
    const answers = new Set(group.map((l) => captionKey(l.fact.figure!.answer)));
    if (answers.size > 1) for (const l of group) drop.add(l);
    else for (const l of group.slice(1)) drop.add(l);
  }
  return facts.filter((l) => !drop.has(l));
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
  const all = dropContradictoryFigures(extracted).filter((l) => l.fact.kind !== "figure" || !isRedundantFigure(l.fact, textFacts));

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
        const words = contentWords([figure.caption ?? "", ...(figure.labels ?? [])].join(" "));
        if (words.size === 0) return;
        const key = `${doc.id}#${page.pageNumber}`;
        figuresOnPage.set(key, [
          ...(figuresOnPage.get(key) ?? []),
          {
            image: { assetId: figureAssetId(doc.id, page.pageNumber, i), documentId: doc.id, pageNumber: page.pageNumber, region: figure.region, placement: "back" },
            words,
          },
        ]);
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
  };
}
