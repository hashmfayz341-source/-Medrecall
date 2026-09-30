import { normalize } from "@/lib/domain/text";
import type { Page, PageRegion } from "@/lib/domain/types";
import { splitSentences, titleFromSubject } from "@/lib/ingestion/extractor";
import { contentWords, wordOverlap } from "@/lib/domain/duplicates";
import { captionTarget, type FigureKind, type PageVisuals } from "@/lib/visuals/analyze";

/**
 * Grounded facts of a lecture: what a flashcard can be made from.
 *
 * Deterministic and purely textual: a fact IS a verbatim sentence, a
 * verbatim list under its heading, a "term: explanation" item, a table, or a
 * figure with its caption. Nothing is asserted that the lecture does not say;
 * the generator only selects, scores and phrases.
 *
 * The source's structure is respected (see lib/ingestion/layout): a
 * sentence is read inside ONE unit — a paragraph, a bullet item, a caption,
 * a table cell — and never across paragraphs, text boxes, columns, list
 * items or table rows. A pronoun ("It is used to treat …") is resolved only
 * from the sentence right before it in the same paragraph (or the bullet a
 * sub-bullet hangs from); otherwise the sentence is not used. Lecturer
 * questions, captions, case vignettes, administrative slides and headings
 * without a fact are not facts. When in doubt, nothing is merged and nothing
 * is guessed.
 */

export type FactKind = "definition" | "superlative" | "mechanism" | "list" | "statement" | "figure" | "table" | "pair";

/** A sentence read as subject + verb group + the rest (all verbatim, from the resolved sentence). */
export interface Clause {
  subject: string;
  /** Adverbs between subject and verb ("most commonly", "irreversibly"). */
  adverbs: string;
  /** The verb group as written: "is", "causes", "can precipitate", "does not cross". */
  verb: string;
  /** The main verb's base form ("cause", "be", "precipitate"). */
  base: string;
  /** The auxiliary or modal when there is one ("is", "are", "can", "may", "does"). */
  aux: string | null;
  negated: boolean;
  /** Everything after the verb group, without the final punctuation. */
  rest: string;
  plural: boolean;
}

export interface Fact {
  kind: FactKind;
  pageNumber: number;
  /** Position within the page's facts; with the page it identifies the fact. */
  index: number;
  /** The page heading, when the page has one. */
  heading: string | null;
  /** Verbatim source text: the sentence, the list (one item per line), the table rows, or the figure caption. */
  text: string;
  /** The term the card is about (title of the concept). */
  term: string;
  /** For definitions/statements/mechanisms: the sentence's subject (resolved when the sentence began with a pronoun). */
  subject?: string;
  /** For mechanisms: the consequence that is blanked in the question. */
  consequence?: string;
  /** For lists: the items. */
  items?: string[];
  /** For figures: which figure of the page, and the visual answer its caption establishes. */
  figure?: {
    index: number;
    kind: FigureKind;
    region: PageRegion;
    /** The caption's content without its "Figure 5.1:" label: what the picture shows. */
    answer: string;
    contentHash?: string;
  };
  score: number;
  /** The block of the page the fact comes from (facts never span blocks). */
  block?: number;
  /** The heading of the block (a bold label over a paragraph, a list's lead-in), when it has one. */
  context?: string | null;
  /** Verbatim source to cite; several lines only when a pronoun's antecedent is in the bullet above. Defaults to `text`. */
  excerpt?: string;
  /** The sentence with a leading pronoun replaced by its antecedent (derived, never cited). */
  resolved?: string;
  /** The antecedent a pronoun was resolved to. */
  antecedent?: string;
  /** The parsed sentence. */
  clause?: Clause;
  /** For tables: header row first, verbatim cells. */
  rows?: string[][];
  /** For "term: explanation" items: the term and its explanation. */
  label?: string;
  detail?: string;
}

/** A unit of text that produced no fact, and why (diagnostics for the shortfall report). */
export interface Skipped {
  pageNumber: number;
  reason: string;
  text: string;
}

/** A caption must say something: at least this many words after its "Figure 5.1:" label. */
const MIN_CAPTION_WORDS = 2;

/**
 * What a figure can be asked about, or null when it cannot be an image
 * question at all.
 *
 * An image question needs an answer the picture itself supports and does
 * not give away:
 * - only a RASTER figure (a photograph, a micrograph, a scan) qualifies. A
 *   vector diagram or a whole page carries its labels and text inside the
 *   picture, so the answer would be printed on the front;
 * - its caption, found OUTSIDE the cropped figure, names what it shows, and
 *   names ONE thing: a caption shared by several pictures ("Wet (left) and
 *   dry (right) gangrene"), or one naming a table, is not an answer;
 * - the answer is not written inside the figure itself.
 *
 * A sentence elsewhere on the slide never qualifies: nothing establishes
 * that the picture shows it. Figures that fail these rules can still
 * illustrate the back of a text card they are demonstrably about (see
 * `generateCards`).
 */
export function visualTarget(figure: { kind: FigureKind; caption?: string; labels?: string[] }): { answer: string } | null {
  if (figure.kind !== "raster") return null;
  const caption = figure.caption ? captionTarget(figure.caption) : "";
  if (!caption || wordCount(caption) < MIN_CAPTION_WORDS || ADMIN_LINE.test(caption)) return null;
  if (!singleSubjectCaption(figure.caption!)) return null;
  const answer = normalize(caption);
  if ((figure.labels ?? []).some((label) => normalize(label).includes(answer) || (normalize(label).length > 3 && answer.includes(normalize(label))))) return null;
  return { answer: caption };
}

/**
 * Whether a caption names one picture's content: not a table's title, not
 * two captions run together ("… Figure 2: …"), not a panel legend that
 * names several things by position ("(left)", "(right)", "A:", "top").
 */
export function singleSubjectCaption(caption: string): boolean {
  if (/^\s*(?:table|tab\.)\s*\d/i.test(caption)) return false;
  if ((caption.match(/\b(?:fig(?:ure)?|table)\.?\s*\d+/gi) ?? []).length > 1) return false;
  if (/\((?:left|right|top|bottom|above|below|upper|lower|a|b|c|i|ii)\)|\b(?:left|right|top|bottom)\s*(?:panel|image)\b|\b(?:on the (?:left|right))\b/i.test(caption)) return false;
  return true;
}

const ADMIN_PAGE = /^(references?|bibliography|further reading|thank you|thanks|questions\??|any questions\??|objectives|learning objectives|learning outcomes|outline|agenda|contents|acknowledg\w*|summary of the lecture|case discussion|case study|clinical case|quiz|self[- ]assessment|revision questions)$/i;
const ADMIN_LINE = /(^|\b)(dr\.|prof\.|professor|university|faculty of|department of|college of|©|copyright|all rights reserved|https?:\/\/|www\.|\bet al\b|\d+(st|nd|rd|th) (edition|ed\.)|edition\.|thank you|questions\?|lecture \d+|slide \d+ of|by the end of this lecture|you should be able to|for educational use)/i;
const CORE_SIGNALS = /\b(most common|most important|commonest|first|earliest|hallmark|defined as|characteristic|pathognomonic|key|central|marks the transition|primary|main|major|classic|typical|drug of choice|only)\b/i;
// "causes" as a verb, not "the most common cause of".
const MECHANISM = /(→|->|\bleads? to\b|(?<!\b(?:the|a|an|common|commonest|main|major|leading|important|underlying|first|primary)\s)\bcauses?\b|\bcaused by\b|\bresults? in\b|\bresulting in\b|\bproduc(?:es|ing)\b|\bactivates?\b|\btriggers?\b|\binhibits?\b|\bdue to\b|\bfollowed by\b|\bswitch(?:es)? to\b|\bmediat(?:es|ed by)\b|\ballows?\b)/i;
const COPULA = /^(is|are|refers to|means|represents|constitutes?)$/i;
const NOT_A_DEFINITION = /^(seen|found|located|observed|present|absent|common|rare|usually|often|mainly|also|not|more|less|most|associated|replaced|released|stored)$/i;
/** "X is the most common cause of Y": the ideal retrieval asks for X given the rest. */
const SUPERLATIVE = /^(.+?)\s+(is|are)\s+(the\s+(?:most common|commonest|most important|main|major|leading|first|earliest|hallmark|characteristic|classic|typical|primary|only|drug of choice|treatment of choice)\b.+?)[.!?]?$/i;
/** Words that make a line a statement rather than a bullet item. */
const VERB_PHRASE = /\b(is|are|was|were|has|have|had|can|may|must|will|should|causes?|caused|leads?|results?|produces?|occurs?|becomes?|shows?|mediates?|includes?|requires?|involves?|means|refers|represents|allows?|inhibits?|activates?|triggers?|blocks?|releases?|binds?|→|->)\b/i;
const BULLET = /^\s*(?:[•●○◦▪▫■□►▸‣⁃∙·*–—-]\s*|(?:\d{1,2}|[a-z])[.)]\s+)/i;
const CAPTION = /^\s*(?:fig(?:ure)?|table|image|photo|micrograph|diagram)\.?\s*\d+[a-z]?(?:\.\d+)?\s*[:.\-–—]/i;
const QUESTION = /\?\s*$/;
const PRONOUN_START = /^(it|they|this|these|this drug|these drugs|this agent|this condition|this pathway|this process)\s/i;
const POSSESSIVE_START = /^(its|their)\s/i;
const VAGUE_SUBJECT = /^(it|they|this|these|those|that|there|here|both|each|all|either|neither|such|another|the latter|the former|one|some|many|most|other|others|he|she|we|you|what|which|why|how|when|where|who)\b/i;
const CONNECTIVE = /^(therefore|however|thus|hence|also|in addition|moreover|furthermore|consequently|in contrast|importantly|notably|finally|similarly),\s+/i;
const LEADING_PREPOSITION = /^(at|in|on|with|during|after|before|for|under|within|by|without|from|upon|following|unlike|like|as)\s/i;
const CASE_VIGNETTE = /\b\d+[- ]year[- ]old\b|\b(presents|presented) with\b/i;

const MIN_SENTENCE_WORDS = 4;
const MAX_SENTENCE_WORDS = 45;
const MIN_LIST_ITEMS = 3;
const MAX_LIST_ITEMS = 12;

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/* ------------------------------------------------------------------ */
/* Clause parsing                                                       */
/* ------------------------------------------------------------------ */

/**
 * Verbs a medical lecture states facts with (base forms). A word is read as
 * a finite verb only in a form and position that make it one; otherwise the
 * sentence is not parsed (and not used) rather than guessed.
 */
const VERBS = new Set([
  "cause", "lead", "result", "produce", "activate", "inhibit", "block", "antagonize", "antagonise", "stimulate", "bind", "release",
  "regenerate", "increase", "decrease", "reduce", "raise", "lower", "impair", "injure", "damage", "trigger", "mediate", "regulate",
  "promote", "prevent", "induce", "destroy", "remove", "replace", "cross", "show", "occur", "develop", "arise", "affect", "involve",
  "include", "contain", "consist", "characterize", "characterise", "mark", "define", "require", "depend", "enter", "form", "accumulate",
  "converge", "peak", "precipitate", "mask", "predominate", "secrete", "engulf", "kill", "cover", "store", "maintain", "resorb", "spread",
  "cleave", "convert", "synthesize", "synthesise", "hydrolyze", "hydrolyse", "degrade", "metabolize", "metabolise", "excrete", "open",
  "close", "contract", "relax", "dilate", "constrict", "reverse", "treat", "protect", "follow", "precede", "begin", "start", "persist",
  "appear", "become", "remain", "represent", "constitute", "refer", "mean", "allow", "permit", "enable", "lack", "express", "recruit",
  "attract", "migrate", "infiltrate", "invade", "compress", "obstruct", "deposit", "lyse", "digest", "phosphorylate", "couple", "act",
  "elicit", "lose", "gain", "undergo", "worsen", "improve", "relieve", "suppress", "enhance", "potentiate", "facilitate", "limit",
  "determine", "differentiate", "distinguish", "resemble", "surround", "line", "drain", "supply", "innervate", "transmit", "carry",
  "transport", "absorb", "filter", "produce", "generate", "initiate", "terminate", "cleave", "modulate", "target", "affect",
  "characterise", "manifest", "present", "respond", "exhibit", "display", "demonstrate", "indicate", "suggest", "predispose",
  "contribute", "participate", "originate", "derive", "evolve", "progress", "heal", "repair", "regress", "recur", "metastasize",
  "metastasise", "cross", "penetrate", "reach", "exceed", "decline", "rise", "fall", "drop", "ingest", "phagocytose", "recognize",
  "recognise", "detect", "encode", "stain", "calcify", "thicken", "narrow", "occlude", "rupture", "bleed", "erode", "ulcerate",
  "perforate", "proliferate", "divide", "mature", "circulate", "attach", "adhere", "marginate", "emigrate", "elevate", "deplete",
  "restore", "lack", "reflect", "accompany", "complicate", "benefit", "harm", "mimic", "resemble", "outline", "separate", "join",
  "connect", "empty", "fill", "flow", "pass", "leave", "return", "stimulate", "excite", "depolarize", "hyperpolarize", "sensitize",
]);
const AUX_BE = new Set(["is", "are", "was", "were"]);
const MODALS = new Set(["can", "may", "might", "must", "will", "should", "could", "does", "do", "did", "would"]);
const IRREGULAR: Record<string, string> = { has: "have", have: "have", does: "do", do: "do", arises: "arise", leads: "lead" };
const ADVERB = /^(?:\w+ly|also|often|usually|mainly|most|more|commonly|consistently|typically|frequently|rarely|never|not|only|always|then|still|further|predominantly|primarily|chiefly|largely|mostly|generally|almost|nearly|directly|indirectly|selectively|irreversibly|reversibly|competitively)$/i;
/** A word before a -s form that makes it a noun ("the main causes of", "common changes"). */
const NOUN_CONTEXT = /^(the|a|an|main|major|common|commonest|most|its|their|of|two|three|four|several|many|these|those|other|key|important|primary|secondary|such|all|some|any|no|early|late|typical|classic)$/i;

/** Words ending in -s that are not plural nouns. */
const NOT_PLURAL = new Set(["was", "has", "as", "its", "this", "thus", "gas", "plus", "does", "is", "us"]);

/** A plural noun before a base-form verb: "-s" plurals and the Latin/Greek ones medicine uses ("thrombi", "emboli", "bacteria"). */
const isPlural = (word: string) =>
  (/s$/.test(word) && !/(?:ss|us|is)$/.test(word) && !NOT_PLURAL.has(word)) || /(?:[^aeiou]i|ae)$/.test(word) || /^(bacteria|criteria|data|phenomena|media|mitochondria|protozoa)$/.test(word);

const bare = (token: string) => token.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");

/** The base form of a verb token, or null when it is not a verb form this reader knows. */
function verbBase(token: string, form: "third" | "base" | "any"): string | null {
  const t = bare(token);
  if (IRREGULAR[t] && form !== "base") return IRREGULAR[t]!;
  if ((form === "base" || form === "any") && VERBS.has(t)) return t;
  if (form === "third" || form === "any") {
    if (/ies$/.test(t) && VERBS.has(`${t.slice(0, -3)}y`)) return `${t.slice(0, -3)}y`;
    if (/(?:ches|shes|sses|xes|zes)$/.test(t) && VERBS.has(t.slice(0, -2))) return t.slice(0, -2);
    if (/s$/.test(t) && !/ss$/.test(t) && VERBS.has(t.slice(0, -1))) return t.slice(0, -1);
  }
  return null;
}

/** Tokens inside parentheses are never the verb. */
function outsideParens(tokens: readonly string[]): boolean[] {
  let depth = 0;
  return tokens.map((t) => {
    const inside = depth > 0 || t.startsWith("(");
    depth += (t.match(/\(/g) ?? []).length - (t.match(/\)/g) ?? []).length;
    return !inside;
  });
}

/**
 * Subject + verb group + rest of a sentence, or null when no reliable verb
 * boundary is found (the sentence is then not used).
 */
export function parseClause(sentence: string): Clause | null {
  const text = sentence.replace(/[.!?]+["”’)]*\s*$/, "").trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return null;
  const outside = outsideParens(tokens);
  for (let i = 1; i < Math.min(tokens.length, 14); i++) {
    if (!outside[i]) continue;
    // Adverbs right before the verb belong to the predicate.
    let j = i;
    while (j < tokens.length - 1 && ADVERB.test(bare(tokens[j]!)) && !AUX_BE.has(bare(tokens[j]!))) j++;
    const word = bare(tokens[j]!);
    const prev = bare(tokens[i - 1]!);
    let base: string | null = null;
    let aux: string | null = null;
    let end = j + 1;
    let negated = false;
    if (AUX_BE.has(word)) {
      base = "be";
      aux = word;
      // "is not", "is also", "is most often": adverbs after the copula stay in the rest.
    } else if (MODALS.has(word)) {
      let k = j + 1;
      while (k < tokens.length - 1 && ADVERB.test(bare(tokens[k]!))) {
        if (bare(tokens[k]!) === "not") negated = true;
        k++;
      }
      const main = verbBase(tokens[k] ?? "", "base") ?? (["be", "have"].includes(bare(tokens[k] ?? "")) ? bare(tokens[k]!) : null);
      if (!main) continue;
      base = main;
      aux = word;
      end = k + 1;
    } else if (j === i || ADVERB.test(bare(tokens[i]!))) {
      const third = verbBase(tokens[j]!, "third");
      const plain = third ? null : verbBase(tokens[j]!, "base");
      if (third && !NOUN_CONTEXT.test(prev) && bare(tokens[j + 1] ?? "") !== "of") base = third;
      // A base form is a verb only after a plural subject ("Beta blockers decrease").
      else if (plain && isPlural(prev) && !NOUN_CONTEXT.test(prev)) base = plain;
    }
    if (!base) continue;
    const subject = tokens.slice(0, i).join(" ");
    // A subject with its own clause is not a subject this reader trusts.
    if (/\b(that|which|who|whom|whose|when|where|if|because|although|while)\b/i.test(subject)) return null;
    const rest = tokens.slice(end).join(" ");
    if (!rest && base === "be") return null;
    return {
      subject,
      adverbs: tokens.slice(i, j).join(" "),
      verb: tokens.slice(j, end).join(" "),
      base,
      aux,
      negated: negated || /^not\b/i.test(rest),
      rest,
      plural: aux ? ["are", "were", "do"].includes(aux) : base !== null && verbBase(tokens[j]!, "third") === null,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Reading a page                                                       */
/* ------------------------------------------------------------------ */

/** Lines that are list items: short, no terminal punctuation, no verb phrase. */
function looksLikeListItem(line: string): boolean {
  const trimmed = cleanItem(line);
  if (!trimmed || trimmed.length > 90 || wordCount(trimmed) > 8) return false;
  if (/[.!?;:]$/.test(trimmed)) return false;
  return !VERB_PHRASE.test(trimmed);
}

/** "Term: explanation" (a labelled item): the term is short and capitalised, the explanation has substance. */
function asPair(line: string): { label: string; detail: string } | null {
  const m = /^([A-Z][\w\-+/()' ]{1,48}?):\s+(.+?)\.?$/.exec(cleanItem(line));
  if (!m) return null;
  const label = m[1]!.trim();
  const detail = m[2]!.trim();
  if (wordCount(label) > 5 || wordCount(detail) < 2 || /[.!?]\s/.test(detail) || VERB_PHRASE.test(label)) return null;
  return { label, detail };
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
  return line.replace(BULLET, "").trim();
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
  // A one-word cause is fine ("Ischaemia leads to …"); a pronoun is not ("This leads to …").
  if (wordCount(cause) < 1 || /^(this|that|it|these|they|which|there)$/i.test(cause) || wordCount(consequence) < 2) return null;
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

/** One logical unit of text (a paragraph, a bullet item, a caption, a cell) inside its block. */
interface Unit {
  text: string;
  /** A sub-bullet (it hangs from the unit before it). */
  sub: boolean;
  bullet: boolean;
}

interface Block {
  units: Unit[];
  table: string[][] | null;
  /** Lines with tabs that do not form a reliable table: nothing is read from them. */
  unreliable: boolean;
}

const SUB_BULLET = /^\s*[–—\-◦○▫▸‣⁃]\s/;

/**
 * The page's blocks. Structured pages (`layout: "blocks"`) carry them;
 * pages extracted before structure was kept have visual lines only: a line
 * is joined to the one before it only when that line cannot have ended
 * (no final punctuation) and this one continues it (lower-case start); a
 * bullet or a short label always starts a new unit. Their units form one
 * block, and pronouns are not resolved across them.
 */
function readBlocks(page: Page): Block[] {
  if (page.layout === "blocks") {
    return page.text
      .split(/\n[ \t]*\n/)
      .map((chunk) => chunk.split("\n").map((l) => l.trim()).filter(Boolean))
      .filter((lines) => lines.length > 0)
      .map((lines) => {
        if (lines.some((l) => l.includes("\t"))) {
          const rows = lines.map((l) => l.split("\t").map((c) => c.trim()));
          const width = rows[0]!.length;
          const reliable = rows.length >= 3 && width >= 2 && rows.every((r) => r.length === width && r.every((c) => c.length > 0));
          return { units: [], table: reliable ? rows : null, unreliable: !reliable };
        }
        return { units: lines.map((l) => ({ text: l, sub: SUB_BULLET.test(l), bullet: BULLET.test(l) })), table: null, unreliable: false };
      });
  }
  const units: Unit[] = [];
  for (const raw of page.text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const prev = units[units.length - 1];
    const continues =
      prev && !BULLET.test(line) && !/[.!?:]["”’)]?$/.test(prev.text) && /^[a-z(]/.test(line) && !(looksLikeListItem(prev.text) && wordCount(prev.text) <= 4);
    if (prev && continues) prev.text = `${prev.text} ${line}`;
    else units.push({ text: line, sub: SUB_BULLET.test(line), bullet: BULLET.test(line) });
  }
  return [{ units, table: null, unreliable: false }];
}

/** A short label with no verb and no final punctuation: a heading, not a fact. */
function isLabel(text: string): boolean {
  const t = cleanItem(text);
  return t.length > 0 && t.length <= 80 && wordCount(t) <= 8 && !/[.!?;]$/.test(t) && !VERB_PHRASE.test(t) && !asPair(t);
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) && !/^[A-Z][a-z]+[A-Z0-9]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

/**
 * All facts of a document, page by page, in page order. `visuals` (from
 * `lib/visuals`) adds one figure fact per selected figure. `skipped`, when
 * given, receives every unit that yielded nothing and why.
 */
export function extractFacts(pages: readonly Page[], visuals: readonly PageVisuals[] = [], skipped?: Skipped[]): Fact[] {
  const facts: Fact[] = [];
  const figuresByPage = new Map(visuals.map((v) => [v.pageNumber, v.figures]));
  const skip = (pageNumber: number, reason: string, text: string) => skipped?.push({ pageNumber, reason, text });

  for (const page of pages) {
    const blocks = readBlocks(page);
    let heading = /^Page \d+$/.test(page.title) ? null : page.title.trim() || null;
    // The heading is not content.
    const firstUnits = blocks[0]?.units ?? [];
    if (heading && firstUnits[0] && normalize(firstUnits[0].text) === normalize(heading)) firstUnits.shift();
    // A slide whose first line is a short label over bullet items ("Causes of
    // cell injury") is headed by that label even when extraction did not call
    // it a heading.
    if (!heading && firstUnits.length >= 4 && isLabel(firstUnits[0]!.text) && firstUnits.slice(1).filter((u) => looksLikeListItem(u.text)).length >= Math.max(MIN_LIST_ITEMS, (firstUnits.length - 1) * 0.6)) {
      heading = firstUnits.shift()!.text;
    }
    const allLines = blocks.flatMap((b) => b.units.map((u) => u.text));
    if (isAdministrativePage(heading, allLines)) {
      for (const line of allLines) skip(page.number, "administrative", line);
      continue;
    }
    const figures = figuresByPage.get(page.number) ?? [];
    const captions = new Set(figures.flatMap((f) => [f.caption ?? "", ...(f.labels ?? [])]).filter(Boolean).map((c) => normalize(c)));

    let index = 0;
    const pageFacts: Fact[] = [];
    const push = (fact: Omit<Fact, "index" | "pageNumber">) => {
      pageFacts.push({ ...fact, pageNumber: page.number, index: index++ });
    };
    // Lists without their own label take the page heading, once per page.
    let headingUsedForList = false;
    // A heading block labels the block below it.
    let pendingContext: string | null = null;

    blocks.forEach((block, b) => {
      if (block.unreliable) {
        skip(page.number, "table-unreliable", "(table)");
        return;
      }
      if (block.table) {
        const rows = block.table;
        push({ kind: "table", heading, text: rows.map((r) => r.join("\t")).join("\n"), term: heading ?? rows[0]!.join(" / "), rows, score: 2, block: b, context: heading });
        return;
      }
      // Captions and figure labels belong to their figures; lecturer questions are not facts.
      const units = block.units.filter((u) => {
        const t = cleanItem(u.text);
        if (CAPTION.test(t) || captions.has(normalize(t)) || captions.has(normalize(u.text))) return skip(page.number, "caption", u.text), false;
        if (QUESTION.test(t)) return skip(page.number, "question", u.text), false;
        if (ADMIN_LINE.test(t)) return skip(page.number, "administrative", u.text), false;
        return true;
      });
      if (units.length === 0) return;

      // A block's own heading: a lead-in ending with ":", or a label set apart as its own block
      // right above (structured pages); on unstructured pages, a label over sentences.
      let context: string | null = pendingContext;
      pendingContext = null;
      if (units.length === 1 && isLabel(units[0]!.text) && page.layout === "blocks" && b + 1 < blocks.length && !blocks[b + 1]!.table) {
        pendingContext = cleanItem(units[0]!.text);
        return;
      }
      if (units.length >= 2 && /:$/.test(units[0]!.text) && wordCount(units[0]!.text) <= 12) {
        context = cleanItem(units.shift()!.text).replace(/:$/, "").trim();
      } else if (units.length >= 2 && page.layout !== "blocks" && isLabel(units[0]!.text) && !isLabel(units[1]!.text) && !looksLikeListItem(units[1]!.text)) {
        context = cleanItem(units.shift()!.text);
      }

      // "Term: explanation" is read as a labelled item only among others like it (a caption such as
      // "Left-sided heart failure: pulmonary edema" standing alone is not a definition).
      const pairsAllowed = units.filter((unit) => asPair(unit.text)).length >= 2;
      // A list: at least three short items (labels, or "term: explanation"); at most one sentence item, used by its subject.
      const pairs = units.map((u) => (pairsAllowed ? asPair(u.text) : null));
      const fragments = units.map((u, i) => pairs[i] !== null || looksLikeListItem(u.text));
      const listHeading = context ?? (!headingUsedForList ? heading : null);
      // A list's items share one style: all bulleted or numbered, or all plain. When the styles
      // are mixed, only a contiguous bulleted run is the list (a paragraph after it is not an item).
      const mixed = units.some((u) => u.bullet) && units.some((u) => !u.bullet);
      const listIdx = units.map((u, i) => (!mixed || u.bullet ? i : -1)).filter((i) => i >= 0);
      const contiguous = listIdx.length > 0 && listIdx[listIdx.length - 1]! - listIdx[0]! === listIdx.length - 1;
      const sentenceItems = listIdx.filter((i) => !fragments[i]).length;
      if (
        listHeading && contiguous && listIdx.length >= MIN_LIST_ITEMS && listIdx.length <= MAX_LIST_ITEMS &&
        sentenceItems <= 1 && listIdx.length - sentenceItems >= MIN_LIST_ITEMS && !listIdx.some((i) => units[i]!.sub)
      ) {
        const items = listIdx.map((i) => {
          if (pairs[i]) return pairs[i]!.label;
          if (fragments[i]) return cleanItem(units[i]!.text);
          const clause = parseClause(cleanItem(units[i]!.text));
          return clause && !VAGUE_SUBJECT.test(clause.subject) && wordCount(clause.subject) <= 6 ? clause.subject : null;
        });
        if (items.every((i): i is string => i !== null && i.length > 0)) {
          if (!context) headingUsedForList = true;
          push({ kind: "list", heading, text: listIdx.map((i) => units[i]!.text).join("\n"), term: listHeading, items, score: 1.5 + (CORE_SIGNALS.test(listHeading) ? 1 : 0), block: b, context: listHeading });
        }
      }

      // Every unit, on its own: labelled items and sentences.
      let previous: { subject: string; plural: boolean; sentence: string; unit: number } | null = null;
      units.forEach((unit, u) => {
        const clean = cleanItem(unit.text);
        const pair = pairs[u];
        if (pair) {
          push({ kind: "pair", heading, text: clean, term: pair.label, subject: pair.label, label: pair.label, detail: pair.detail, score: 1.75, block: b, context: context ?? heading });
          return;
        }
        if (fragments[u]) {
          skip(page.number, "fragment", unit.text);
          return;
        }
        // A sub-bullet's pronoun may refer to the bullet above; any other unit starts afresh.
        if (!(unit.sub && page.layout === "blocks")) previous = null;
        for (const sentence of splitSentences(clean)) {
          const words = wordCount(sentence);
          if (QUESTION.test(sentence)) {
            skip(page.number, "question", sentence);
            continue;
          }
          if (words > MAX_SENTENCE_WORDS || (words < MIN_SENTENCE_WORDS - 1) || (words < MIN_SENTENCE_WORDS && !PRONOUN_START.test(sentence))) {
            skip(page.number, words < MIN_SENTENCE_WORDS ? "fragment" : "too-long", sentence);
            continue;
          }
          if (ADMIN_LINE.test(sentence) || CASE_VIGNETTE.test(sentence)) {
            skip(page.number, CASE_VIGNETTE.test(sentence) ? "case-vignette" : "administrative", sentence);
            continue;
          }
          const stripped = sentence.replace(CONNECTIVE, "");
          let resolved = stripped;
          let antecedent: string | undefined;
          let excerpt = sentence;
          const pronoun = PRONOUN_START.exec(stripped);
          const possessive = POSSESSIVE_START.exec(stripped);
          if (pronoun || possessive) {
            const word = (pronoun ?? possessive)![1]!.toLowerCase();
            const plural = /^(they|these|their)/.test(word);
            const prior = previous as { subject: string; plural: boolean; sentence: string; unit: number } | null;
            if (!prior || prior.plural !== plural) {
              skip(page.number, "pronoun", sentence);
              continue;
            }
            antecedent = prior.subject;
            resolved = possessive
              ? stripped.replace(POSSESSIVE_START, "").replace(/^(.+?)\s+(is|are|was|were|includes?)\s/i, (_m, noun: string, verb: string) => `The ${noun} of ${lowerFirst(prior.subject)} ${verb} `)
              : `${prior.subject} ${stripped.slice(pronoun![0].length)}`;
            if (possessive && resolved === stripped.replace(POSSESSIVE_START, "")) {
              skip(page.number, "pronoun", sentence);
              continue;
            }
            // Cite the antecedent too: from its sentence to this one when they share the unit, else both lines.
            if (prior.unit === u) {
              const start = clean.indexOf(prior.sentence);
              const end = clean.indexOf(sentence, Math.max(0, start)) + sentence.length;
              excerpt = start >= 0 && end > start ? clean.slice(start, end) : sentence;
            } else {
              excerpt = `${prior.sentence}\n${sentence}`;
            }
          } else if (LEADING_PREPOSITION.test(stripped)) {
            // "At high doses alpha-1 effects predominate": the topic (which drug?) is outside the sentence.
            skip(page.number, "no-subject", sentence);
            continue;
          }
          // "A → B → C": a sequence has no verb; its first step is the subject.
          const arrow = /\s(→|->)\s/.exec(resolved);
          const clause =
            parseClause(resolved) ??
            (arrow
              ? { subject: resolved.slice(0, arrow.index).trim(), adverbs: "", verb: arrow[1]!, base: "lead", aux: null, negated: false, rest: resolved.slice(arrow.index + arrow[0].length).replace(/[.!?]+$/, "").trim(), plural: false }
              : null);
          if (!clause) {
            skip(page.number, "no-verb", sentence);
            continue;
          }
          if (VAGUE_SUBJECT.test(clause.subject) || wordCount(clause.subject) > 10) {
            // "There are two patterns of cell death: …" is still a fact, read by its own pattern.
            if (!/^there\s+(is|are)\s/i.test(resolved)) {
              skip(page.number, "vague-subject", sentence);
              continue;
            }
          }
          const term = titleFromSubject(clause.subject) ?? titleFromSubject(resolved.split(/\s+/).slice(0, 4).join(" "));
          if (!term) {
            skip(page.number, "no-subject", sentence);
            continue;
          }
          const superlative = splitSuperlative(resolved);
          const mechanism = superlative ? null : splitMechanism(resolved);
          const verb = clause.verb.split(/\s+/)[0] ?? "";
          const complement = clause.rest.split(/\s+/)[0] ?? "";
          let kind: FactKind = "statement";
          if (superlative) kind = "superlative";
          else if (mechanism) kind = "mechanism";
          else if ((COPULA.test(verb) && !NOT_A_DEFINITION.test(complement)) || /\bdefined as\b/i.test(resolved)) kind = "definition";
          push({
            kind,
            heading,
            text: sentence,
            term: superlative ? titleFromSubject(superlative.subject) ?? term : term,
            subject: superlative?.subject ?? clause.subject,
            consequence: mechanism?.consequence ?? superlative?.rest,
            score: scoreSentence(kind, resolved, heading),
            block: b,
            context: context ?? heading,
            excerpt,
            ...(resolved !== sentence ? { resolved } : {}),
            ...(antecedent ? { antecedent } : {}),
            clause,
          });
          if (!/^there\s/i.test(resolved) && !VAGUE_SUBJECT.test(clause.subject)) {
            // After a resolved pronoun, the antecedent stays the sentence that NAMES the subject, so a
            // later "It …" cites from there ("Atropine is … It increases … It is used to treat …").
            const prior = previous as { plural: boolean; sentence: string; unit: number } | null;
            previous = antecedent && prior
              ? { subject: antecedent, plural: prior.plural, sentence: prior.sentence, unit: prior.unit }
              : { subject: clause.subject, plural: clause.plural, sentence, unit: u };
          }
        }
      });
    });

    // One image question per figure whose caption establishes what it shows.
    // The verbatim source of the card is the caption.
    figures.forEach((figure, i) => {
      const target = visualTarget(figure);
      if (!target) return;
      push({
        kind: "figure",
        heading,
        text: figure.caption!,
        term: target.answer,
        figure: { index: i, kind: figure.kind, region: figure.region, answer: target.answer, contentHash: figure.contentHash },
        score: 2.5,
      });
    });
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
