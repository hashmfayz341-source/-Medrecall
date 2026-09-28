import { normalize } from "@/lib/domain/text";
import type { CardImage, CardLanguage, Concept, ConceptImportance, RetrievalItem, RetrievalKind, SourceDocument } from "@/lib/domain/types";
import { figureAssetId, type PageVisuals } from "@/lib/visuals/analyze";
import { extractFacts, factsOverlap, type Fact } from "./facts";
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
 */

export interface ExistingCard {
  id: string;
  title: string;
  summary: string;
}

export type CardCount = number | "auto";

export interface GenerateCardsInput {
  courseId: string;
  lectureId: string;
  document: Pick<SourceDocument, "id" | "title" | "pages">;
  /** Figures found in the document (from `lib/visuals`); may be empty. */
  visuals: readonly PageVisuals[];
  language: CardLanguage;
  count: CardCount;
  /** Cards the lecture already has, so nothing is generated twice. */
  existing: readonly ExistingCard[];
}

export interface GeneratedCards {
  concepts: Concept[];
  requested: CardCount;
  /** Distinct, grounded facts available after removing what already exists. */
  available: number;
  /** How many fewer cards than requested could be made (0 when satisfied or AUTO). */
  shortfall: number;
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

function itemFor(fact: Fact, conceptId: string, language: CardLanguage, documentId: string): RetrievalItem {
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
    case "mechanism": {
      kind = "MECHANISM";
      prompt = t.mechanism(blank(fact.text, fact.consequence ?? ""));
      required = keywords(fact.consequence ?? fact.text, 2).map((k) => [k]);
      break;
    }
    case "list":
      prompt = t.list(term);
      required = (fact.items ?? []).slice(0, 3).map((item) => keywords(item, 1)).filter((k) => k.length > 0);
      break;
    case "figure": {
      kind = "IMAGE";
      prompt = t.figure(fact.pageNumber);
      acceptable = fact.heading ? [fact.heading] : [];
      required = [keywords(fact.heading ?? fact.text, 2)].filter((k) => k.length > 0);
      image = {
        assetId: figureAssetId(documentId, fact.pageNumber, fact.figure?.index ?? 0),
        documentId,
        pageNumber: fact.pageNumber,
        region: fact.figure?.region,
        placement: "front",
      };
      break;
    }
    default: {
      kind = "CLOZE";
      prompt = t.cloze(blank(fact.text, fact.subject ?? term));
      acceptable = [term, ...(fact.subject && fact.subject !== term ? [fact.subject] : [])];
      required = [[normalize(term)]];
    }
  }
  if (required.length === 0) required = [[normalize(term)]];
  const item: RetrievalItem = {
    id: `${conceptId}-r1`,
    conceptId,
    kind,
    prompt,
    requiredKeywords: required,
    acceptableAnswers: acceptable,
    explanation: fact.kind === "list" ? (fact.items ?? []).join("; ") : fact.text,
  };
  return image ? { ...item, image } : item;
}

/** The same fact phrased as a cloze, when its natural prompt would repeat an earlier card's. */
function asCloze(fact: Fact): Fact {
  return { ...fact, kind: "statement" };
}

function conceptFor(fact: Fact, input: GenerateCardsInput, diagramOnPage: Map<number, CardImage>): Concept {
  const id = factId(input.document.id, fact);
  const item = itemFor(fact, id, input.language, input.document.id);
  // A mechanism on a page that has a diagram gets the diagram with its answer.
  const diagram = fact.kind === "mechanism" && !item.image ? diagramOnPage.get(fact.pageNumber) : undefined;
  const importance: ConceptImportance = fact.score >= 2 ? "CORE" : "SUPPORTING";
  return {
    id,
    courseId: input.courseId,
    lectureId: input.lectureId,
    title: fact.kind === "figure" ? `${fact.term} (figure, page ${fact.pageNumber})` : fact.term.length > 90 ? `${fact.term.slice(0, 87)}…` : fact.term,
    summary:
      fact.kind === "list"
        ? `${fact.term}: ${(fact.items ?? []).join("; ")}`
        : fact.kind === "figure"
          ? `Figure on page ${fact.pageNumber}: ${fact.text}`
          : fact.text,
    importance,
    status: "DRAFT",
    prerequisiteIds: [],
    source: {
      courseId: input.courseId,
      lectureId: input.lectureId,
      documentId: input.document.id,
      pageNumber: fact.pageNumber,
      excerpt: fact.text,
    },
    retrievalItems: [diagram ? { ...item, image: { ...diagram, placement: "back" } } : item],
  };
}

/**
 * Generate cards for a lecture. Pure and deterministic.
 *
 * - Facts already covered by `existing` cards (same id, or the same
 *   statement) are skipped, so a second run adds only new material.
 * - A requested count larger than the distinct facts available yields the
 *   maximum useful set and a `shortfall`; facts are never duplicated or
 *   padded to reach a number.
 * - AUTO keeps every fact scoring at least `AUTO_MIN_SCORE`.
 * - Selected cards are returned in lecture order.
 */
export function generateCards(input: GenerateCardsInput): GeneratedCards {
  const requested = input.count === "auto" ? "auto" : Math.max(1, Math.min(MAX_CARD_COUNT, Math.floor(input.count)));
  const all = extractFacts(input.document.pages, input.visuals);
  const existingIds = new Set(input.existing.map((e) => e.id));
  const existingTexts = input.existing.map((e) => ({ text: e.summary }));
  const existingTitles = new Set(input.existing.map((e) => normalize(e.title)));

  // Dedupe against what exists, then among the new facts (best score wins).
  const fresh = all.filter((fact) => {
    if (existingIds.has(factId(input.document.id, fact))) return false;
    if (fact.kind !== "figure" && existingTitles.has(normalize(fact.term)) && existingTexts.some((e) => factsOverlap(e, fact))) return false;
    return !existingTexts.some((e) => factsOverlap(e, fact));
  });
  const ranked = [...fresh].sort((a, b) => b.score - a.score || a.pageNumber - b.pageNumber || a.index - b.index);
  const kept: Fact[] = [];
  for (const fact of ranked) {
    if (fact.kind !== "figure" && kept.some((k) => k.kind !== "figure" && factsOverlap(k, fact))) continue;
    if (fact.kind === "figure" && kept.some((k) => k.kind === "figure" && k.pageNumber === fact.pageNumber && k.figure?.index === fact.figure?.index)) continue;
    kept.push(fact);
  }

  // Diagrams available per page, for mechanism cards on that page.
  const diagramOnPage = new Map<number, CardImage>();
  for (const page of input.visuals) {
    page.figures.forEach((figure, i) => {
      if (figure.kind === "diagram" && !diagramOnPage.has(page.pageNumber)) {
        diagramOnPage.set(page.pageNumber, {
          assetId: figureAssetId(input.document.id, page.pageNumber, i),
          documentId: input.document.id,
          pageNumber: page.pageNumber,
          region: figure.region,
          placement: "back",
        });
      }
    });
  }

  // Two facts about the same term would ask the same question ("What is X?")
  // with different answers; the later one is asked as a cloze instead, and a
  // prompt that still repeats is dropped rather than shown twice. Visual
  // cards are distinct by the figure they show. Done before the count is
  // applied, so a requested number is met whenever enough distinct cards
  // exist.
  const prompts = new Set<string>();
  const candidates: { fact: Fact; concept: Concept }[] = [];
  for (const fact of kept) {
    let concept = conceptFor(fact, input, diagramOnPage);
    const keyOf = (c: Concept) => (fact.kind === "figure" ? `figure:${c.retrievalItems[0]!.image?.assetId}` : normalize(c.retrievalItems[0]!.prompt));
    let key = keyOf(concept);
    if (prompts.has(key) && fact.kind !== "figure") {
      concept = conceptFor(asCloze(fact), input, diagramOnPage);
      key = keyOf(concept);
    }
    if (prompts.has(key)) continue;
    prompts.add(key);
    candidates.push({ fact, concept });
  }

  const selected =
    requested === "auto" ? candidates.filter((c) => c.fact.score >= AUTO_MIN_SCORE) : candidates.slice(0, requested);
  selected.sort((a, b) => a.fact.pageNumber - b.fact.pageNumber || a.fact.index - b.fact.index);
  const concepts = selected.map((c) => c.concept);
  return {
    concepts,
    requested,
    available: candidates.length,
    shortfall: requested === "auto" ? 0 : Math.max(0, requested - concepts.length),
  };
}
