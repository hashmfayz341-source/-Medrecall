import { normalize } from "@/lib/domain/text";
import type { Page, PageRegion } from "@/lib/domain/types";
import { splitSentences, splitSubjectPredicate, titleFromSubject } from "@/lib/ingestion/extractor";
import { contentWords, wordOverlap } from "@/lib/domain/duplicates";
import type { FigureKind, PageVisuals } from "@/lib/visuals/analyze";

/**
 * Grounded facts of a lecture: what a flashcard can be made from.
 *
 * Deterministic and purely textual, like extraction (Milestone 2): a fact IS
 * a verbatim sentence, a verbatim bullet list under its heading, or a
 * figure with the verbatim text of its page. Nothing is asserted that the
 * lecture does not say; the generator only selects, scores and phrases.
 *
 * Scoring prefers what medical students actually need to retrieve —
 * mechanisms, definitions, cause and effect, differentiating features,
 * enumerations, and figures — and drops administrative slide text
 * (title slides, references, "thank you"), headings alone, and fragments.
 */

export type FactKind = "definition" | "superlative" | "mechanism" | "list" | "statement" | "figure";

export interface Fact {
  kind: FactKind;
  pageNumber: number;
  /** Position within the page's facts; with the page it identifies the fact. */
  index: number;
  /** The page heading, when the page has one. */
  heading: string | null;
  /** Verbatim source text: the sentence, the list (one item per line), or the figure page's key sentence. */
  text: string;
  /** The term the card is about (title of the concept). */
  term: string;
  /** For definitions/statements/mechanisms: the sentence's subject. */
  subject?: string;
  /** For mechanisms: the consequence that is blanked in the question. */
  consequence?: string;
  /** For lists: the items. */
  items?: string[];
  /** For figures: which figure of the page. */
  figure?: { index: number; kind: FigureKind; region: PageRegion };
  score: number;
}

const ADMIN_PAGE = /^(references?|bibliography|further reading|thank you|thanks|questions\??|any questions|objectives|learning objectives|outline|agenda|contents|acknowledg\w*|summary of the lecture)$/i;
const ADMIN_LINE = /(^|\b)(dr\.|prof\.|professor|university|faculty of|department of|college of|©|copyright|all rights reserved|https?:\/\/|www\.|\bet al\b|\d+(st|nd|rd|th) edition|edition\.|thank you|questions\?|lecture \d+|slide \d+ of)/i;
const CORE_SIGNALS = /\b(most common|most important|commonest|first|earliest|hallmark|defined as|characteristic|pathognomonic|key|central|marks the transition|primary|main|major|classic|typical)\b/i;
// "causes" as a verb, not "the most common cause of".
const MECHANISM = /(→|->|\bleads? to\b|(?<!\b(?:the|a|an|common|commonest|main|major|leading|important|underlying|first|primary)\s)\bcauses?\b|\bcaused by\b|\bresults? in\b|\bresulting in\b|\bproduc(?:es|ing)\b|\bactivates?\b|\btriggers?\b|\binhibits?\b|\bdue to\b|\bfollowed by\b|\bswitch(?:es)? to\b|\bmediat(?:es|ed by)\b|\ballows?\b)/i;
const COPULA = /^(is|are|refers to|means|represents|constitutes?)$/i;
/** "X is the most common cause of Y": the ideal retrieval asks for X given the rest. */
const SUPERLATIVE = /^(.+?)\s+(is|are)\s+(the\s+(?:most common|commonest|most important|main|major|leading|first|earliest|hallmark|characteristic|classic|typical|primary|only)\b.+?)[.!?]?$/i;
/** Words that make a line a statement rather than a bullet item. */
const VERB_PHRASE = /\b(is|are|was|were|has|have|had|can|may|must|will|should|causes?|caused|leads?|results?|produces?|occurs?|becomes?|shows?|mediates?|includes?|requires?|involves?|means|refers|represents|allows?|inhibits?|activates?|triggers?|→|->)\b/i;

const MIN_SENTENCE_WORDS = 4;
const MAX_SENTENCE_WORDS = 40;
const MIN_LIST_ITEMS = 3;
const MAX_LIST_ITEMS = 12;

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Lines that are list items: short, no terminal punctuation, no verb phrase. */
function looksLikeListItem(line: string): boolean {
  const trimmed = line.replace(/^[\s•\-–*·▪○●\d.)]+/, "").trim();
  if (!trimmed || trimmed.length > 90 || wordCount(trimmed) > 8) return false;
  if (/[.!?;:]$/.test(trimmed)) return false;
  return !VERB_PHRASE.test(trimmed);
}

export function splitSuperlative(sentence: string): { subject: string; rest: string } | null {
  const match = SUPERLATIVE.exec(sentence.trim());
  if (!match) return null;
  const subject = match[1]!.trim();
  const rest = match[3]!.trim();
  if (wordCount(subject) > 8 || wordCount(rest) < 3) return null;
  return { subject, rest };
}

function cleanItem(line: string): string {
  return line.replace(/^[\s•\-–*·▪○●]+/, "").replace(/^\d+[.)]\s*/, "").trim();
}

function isAdministrativePage(heading: string | null, lines: readonly string[]): boolean {
  if (heading && ADMIN_PAGE.test(heading.trim())) return true;
  const admin = lines.filter((l) => ADMIN_LINE.test(l)).length;
  return lines.length > 0 && admin >= Math.ceil(lines.length / 2);
}

/** Split a mechanism sentence at its connector: cause | connector | consequence. */
export function splitMechanism(sentence: string): { cause: string; connector: string; consequence: string } | null {
  const match = MECHANISM.exec(sentence);
  if (!match || match.index === undefined) return null;
  const cause = sentence.slice(0, match.index).trim();
  const consequence = sentence.slice(match.index + match[0].length).replace(/[.!?]$/, "").trim();
  if (wordCount(cause) < 2 || wordCount(consequence) < 2) return null;
  return { cause, connector: match[0].trim(), consequence };
}

function scoreSentence(kind: FactKind, sentence: string, heading: string | null): number {
  let score = 1;
  if (kind === "definition") score += 1;
  if (kind === "mechanism") score += 1;
  if (kind === "superlative") score += 1.5;
  if (CORE_SIGNALS.test(sentence)) score += 1;
  if (heading && normalize(sentence).includes(normalize(heading))) score += 0.25;
  const words = wordCount(sentence);
  if (words < 6 || words > 30) score -= 0.5;
  if (ADMIN_LINE.test(sentence)) score -= 2;
  return score;
}

/**
 * All facts of a document, page by page, in page order. `visuals` (from
 * `lib/visuals`) adds one figure fact per selected figure.
 */
export function extractFacts(pages: readonly Page[], visuals: readonly PageVisuals[] = []): Fact[] {
  const facts: Fact[] = [];
  const figuresByPage = new Map(visuals.map((v) => [v.pageNumber, v.figures]));

  for (const page of pages) {
    const rawLines = page.text.split("\n").map((l) => l.trim()).filter(Boolean);
    let heading = /^Page \d+$/.test(page.title) ? null : page.title.trim() || null;
    let lines = heading && rawLines[0] === heading ? rawLines.slice(1) : rawLines;
    // A slide whose first line is a short label over bullet items ("Causes of
    // cell injury") is headed by that label even when extraction did not call
    // it a heading (it contains a verb-like word).
    if (!heading && rawLines.length >= 4 && rawLines[0]!.length <= 80 && wordCount(rawLines[0]!) <= 8 && !/[.!?;:]$/.test(rawLines[0]!) &&
      rawLines.slice(1).filter(looksLikeListItem).length >= Math.max(MIN_LIST_ITEMS, (rawLines.length - 1) * 0.6)) {
      heading = rawLines[0]!;
      lines = rawLines.slice(1);
    }
    if (isAdministrativePage(heading, lines)) continue;

    let index = 0;
    const pageFacts: Fact[] = [];
    const push = (fact: Omit<Fact, "index" | "pageNumber">) => {
      pageFacts.push({ ...fact, pageNumber: page.number, index: index++ });
    };

    // Bullet lists under a heading: an enumeration card.
    const items = lines.filter(looksLikeListItem).map(cleanItem);
    if (heading && items.length >= MIN_LIST_ITEMS && items.length <= MAX_LIST_ITEMS && items.length >= lines.length * 0.6) {
      push({ kind: "list", heading, text: items.join("\n"), term: heading, items, score: 1.5 + (CORE_SIGNALS.test(heading) ? 1 : 0) });
    }

    const prose = lines.filter((l) => !looksLikeListItem(l)).join(" ");
    for (const sentence of splitSentences(prose)) {
      const words = wordCount(sentence);
      if (words < MIN_SENTENCE_WORDS || words > MAX_SENTENCE_WORDS) continue;
      if (ADMIN_LINE.test(sentence)) continue;
      const split = splitSubjectPredicate(sentence);
      if (!split) continue;
      const term = titleFromSubject(split.subject);
      if (!term) continue;
      const superlative = splitSuperlative(sentence);
      const mechanism = superlative ? null : splitMechanism(sentence);
      const verb = split.predicate.split(/\s+/)[0] ?? "";
      let kind: FactKind = "statement";
      if (superlative) kind = "superlative";
      else if (mechanism) kind = "mechanism";
      else if (COPULA.test(verb) || /\bdefined as\b/i.test(sentence)) kind = "definition";
      push({
        kind,
        heading,
        text: sentence,
        term: superlative ? titleFromSubject(superlative.subject) ?? term : term,
        subject: superlative?.subject ?? split.subject,
        consequence: mechanism?.consequence ?? superlative?.rest,
        score: scoreSentence(kind, sentence, heading),
      });
    }

    // One figure fact per selected figure, answered by the page's best sentence.
    const figures = figuresByPage.get(page.number) ?? [];
    const best = [...pageFacts].filter((f) => f.kind !== "list").sort((a, b) => b.score - a.score)[0];
    const answer = best?.text ?? (heading ? heading : null);
    if (answer) {
      figures.forEach((figure, i) => {
        push({
          kind: "figure",
          heading,
          text: answer,
          term: heading ?? best?.term ?? `Figure, page ${page.number}`,
          subject: best?.subject,
          figure: { index: i, kind: figure.kind, region: figure.region },
          score: 2.5,
        });
      });
    }
    facts.push(...pageFacts);
  }
  return facts;
}

/** Whether two facts say the same thing (same normalised text, or mostly the same content words). */
export function factsOverlap(a: { text: string }, b: { text: string }, threshold = 0.6): boolean {
  const na = normalize(a.text);
  const nb = normalize(b.text);
  if (na === nb) return true;
  const wa = contentWords(a.text);
  const wb = contentWords(b.text);
  if (wa.size < 3 || wb.size < 3) return false;
  return wordOverlap(wa, wb) >= threshold;
}
