import { normalize } from "@/lib/domain/text";
import type { Page, RetrievalKind } from "@/lib/domain/types";
import { parseClause, splitSuperlative, type Clause, type Fact } from "./facts";

/**
 * Learning targets: what a card asks, derived from a grounded fact.
 *
 * A target is ONE retrieval: a subject, a relation, and the fact that
 * answers it — a short span of the lecture's own words — with the exact
 * page and verbatim excerpt it comes from. Cards are built from targets,
 * not from sentences, so a sentence that says two things ("Pilocarpine is a
 * muscarinic agonist used to treat glaucoma") gives two cards with one
 * answer each, and a sentence that cannot be asked about cleanly gives none.
 *
 * Every target is checked before it can become a card (`rejectTarget`): no
 * pronouns or vague subjects, no blank that tests a grammatical word, no
 * answer the question gives away, no truncated or run-on answers, no
 * question-only prompts, and every word of the answer — and every content
 * word of the question — must come from the source excerpt or its stated
 * context (the slide heading, the table header, a resolved antecedent). No
 * outside knowledge is added.
 */

export type Relation =
  | "identity"
  | "definition"
  | "use"
  | "cause"
  | "caused-by"
  | "result-from"
  | "action"
  | "characterized-by"
  | "defined-as"
  | "location"
  | "timing"
  | "includes"
  | "count"
  | "comparison"
  | "passive"
  | "purpose"
  | "cloze"
  | "list"
  | "pair"
  | "table-cell"
  | "table-compare"
  | "figure";

export interface LearningTarget {
  subject: string;
  relation: Relation;
  /** The answer: the lecture's own words. */
  fact: string;
  /** The English question. */
  question: string;
  kind: RetrievalKind;
  sourcePage: number;
  /** Verbatim source text (one or more lines of ONE block of the page). */
  sourceExcerpt: string;
  importance: number;
  /** The fact it was derived from. */
  source: Fact;
  /** 0 for a fact's first target; siblings from the same fact count up. */
  ordinal: number;
  /** Text the question may draw on besides the excerpt: headings, table header, the resolved sentence. */
  context: string;
}

const CORE = /\b(most common|commonest|most important|first|earliest|hallmark|characteristic|pathognomonic|drug of choice|only|main|major|leading|classic|primary)\b/i;
const OPEN_END = /(?:^|\s)(?:and|or|of|the|a|an|by|to|with|in|on|at|for|from|as|into|than|that|which|is|are|was|were|be|its|their|such|including|between|versus|vs|via|per|not|no)$/i;
const PRONOUN = /^(it|they|this|these|those|its|their|he|she|them)\b/i;
const CONJUNCTION_START = /^(and|or|but|which|that|who|whereas|while|then|so)\b/i;
const PHARM_VERBS = new Set(["inhibit", "block", "antagonize", "antagonise", "activate", "stimulate", "bind", "release", "increase", "decrease", "reduce", "regenerate", "mask", "precipitate", "cross", "impair", "mediate", "regulate"]);
const CAUSAL = new Set(["cause", "lead", "result", "produce", "trigger", "induce"]);
const INTRANSITIVE = new Set(["accumulate", "predominate", "migrate", "progress", "heal", "regress", "decline", "rise", "fall", "drop", "respond", "participate", "contribute", "originate", "evolve", "act", "work", "depend", "converge", "remain", "become", "appear"]);
const TIMING_VERBS = new Set(["occur", "develop", "arise", "appear", "peak", "begin", "start", "persist", "recur"]);
const NUMBER_WORD = /^(two|three|four|five|six|seven|eight|nine|ten|\d+)$/i;
const TIME_START = /^(within|after|before|during|by|over|for|about|around|up to|\d|at\s+(?:\d|birth|night|rest|onset|the (?:onset|time|end|start)))/i;
const ADJECTIVE_PHRASE = /^\S+(?:ive|ant|ent|ful|able|ible|al|ous|ic|ar|ary|ile)\s+(?:to|in|for|with|than|from|on|of|against)\b/i;
/** A passive participle: "-ed/-en" followed by a preposition, "by", an adverb or nothing ("is hydrolyzed in …"), not by a noun ("programmed cell death"). */
const PARTICIPLE = /^\S+(?:ed|en)(?:\s+(?:by|in|at|on|to|from|into|within|with|as|for|during|after|before|through|via|\w+ly)\b|$)/i;

const words = (text: string) => text.split(/\s+/).filter(Boolean);
const trimEnd = (text: string) => text.replace(/[\s,;:]+$/, "").replace(/[.!?]+["”’)]*$/, "").trim();
/** Sentence case for an answer, except a first word that is written with internal capitals ("aPTT", "cAMP", "pH", "mRNA"). */
const capital = (text: string) => (text && !/^[a-z]+[A-Z]/.test(text) ? text.charAt(0).toUpperCase() + text.slice(1) : text);
/**
 * Words the lecture capitalises in mid-sentence (names: "Fas", "Langhans",
 * "Congo"): kept capitalised inside a question. Set per generation run.
 */
let properNouns: ReadonlySet<string> = new Set();
/** A term inside a question: lower-cased at its start ("the intrinsic pathway", "atropine") unless it is a name or an acronym. */
const inQuestion = (subject: string) => {
  const s = subject.replace(/^(The|A|An)\s/, (m) => m.toLowerCase());
  const first = /^[A-Z][a-z'’-]*\b/.exec(s)?.[0];
  if (!first || /[A-Z0-9]/.test(first.slice(1)) || properNouns.has(first)) return s;
  return first.toLowerCase() + s.slice(first.length);
};
/** "Receptor selectivity" → "receptor selectivity"; "G protein", "ATP", "Fas" stay as written. */
const label = (text: string) => (/^[A-Z][a-z]/.test(text) && !/^[A-Z][a-z]+[A-Z0-9]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text);
const doFor = (clause: Clause) => (clause.aux && !["is", "are", "was", "were"].includes(clause.aux) ? clause.aux : clause.plural ? "do" : "does");

/** Cut an answer at a following clause with its own verb: "heart rate and causes mydriasis" → "heart rate" (+ the rest). */
function coordinated(rest: string): { first: string; verb: string | null; second: string | null } {
  const m = /^(.+?),?\s+and\s+(\S+s)\s+(.+)$/.exec(rest);
  if (m && /^(causes|increases|decreases|blocks|inhibits|activates|stimulates|releases|reduces|produces|leads|results|prevents|crosses|binds|shows|contains|includes|regenerates|masks|lowers|raises|impairs|mediates)$/.test(m[2]!)) {
    return { first: m[1]!, verb: m[2]!, second: m[3]! };
  }
  return { first: rest, verb: null, second: null };
}

/**
 * Cut an answer where a new clause with its own subject begins: "rolling and
 * integrins mediate firm adhesion" → "rolling" + (integrins | mediate | firm
 * adhesion). The second clause is its own target, never part of this answer.
 */
function independent(object: string): { head: string; clause: Clause | null } {
  const joints = [...object.matchAll(/,?\s+(?:and|whereas|while|but)\s+/g)];
  for (const joint of joints) {
    const clause = parseClause(object.slice(joint.index! + joint[0].length));
    if (clause && words(clause.subject).length <= 4 && clause.base !== "be" && !/^(the|a|an|it|they|this|these)$/i.test(clause.subject)) {
      return { head: object.slice(0, joint.index!), clause };
    }
  }
  return { head: object, clause: null };
}

function baseOf(third: string): string {
  if (/(?:ches|shes|sses|xes|zes)$/.test(third)) return third.slice(0, -2);
  if (/ies$/.test(third)) return `${third.slice(0, -3)}y`;
  return third.replace(/s$/, "");
}

interface Draft {
  subject: string;
  relation: Relation;
  fact: string;
  question: string;
  kind?: RetrievalKind;
  importance: number;
}

/** The targets of a sentence fact, from its clause (on the resolved sentence). */
function sentenceTargets(fact: Fact): Draft[] {
  const clause = fact.clause;
  const sentence = (fact.resolved ?? fact.text).replace(/^(therefore|however|thus|hence|also|in addition|moreover|furthermore|consequently),\s+/i, "");
  const out: Draft[] = [];
  const core = CORE.test(sentence) ? 0.5 : 0;

  // "There are two patterns of cell death: necrosis and apoptosis."
  const there = /^there\s+(is|are)\s+((?:two|three|four|five|six|seven|eight|nine|ten|\d+|several)\s+.+?):\s+(.+?)[.!?]?$/i.exec(sentence);
  if (there) {
    out.push({ subject: there[2]!, relation: "count", fact: there[3]!, question: `What ${there[1]!.toLowerCase()} the ${there[2]!}?`, importance: 2.5 + core });
    return out;
  }
  if (!clause) return out;
  const S = clause.subject;
  const Sq = inQuestion(S);
  const aux = clause.aux ?? "";
  const rest = trimEnd(clause.rest);
  const advs = clause.adverbs ? `${clause.adverbs} ` : "";

  // "Two phenomena consistently characterize irreversibility: A and B."
  const colon = /^(.+?):\s+(.+?)[.!?]?$/.exec(sentence);
  if (colon && NUMBER_WORD.test(words(S)[0] ?? "") && !colon[1]!.includes(",")) {
    out.push({ subject: S, relation: "count", fact: colon[2]!, question: `What ${label(colon[1]!)}?`, importance: 2.5 + core });
    return out;
  }

  const superlative = splitSuperlative(sentence);
  if (superlative && clause.base === "be") {
    out.push({ subject: superlative.subject, relation: "identity", fact: superlative.subject, question: `What ${aux} ${trimEnd(superlative.rest)}?`, importance: 3 + core });
    return out;
  }

  if (clause.base === "be") {
    const m = (re: RegExp) => re.exec(rest);
    const adverb = "((?:(?:most|more|less)\\s+)?(?:\\w+ly|often|usually|mainly|mostly|typically|also)\\s+)?";
    let x: RegExpExecArray | null;
    if (clause.negated) {
      out.push({ subject: S, relation: "cloze", fact: rest.replace(/^not\s+/i, ""), question: `Fill in the blank: ${S} ${aux} not ___.`, kind: "CLOZE", importance: 1.2 });
    } else if ((x = m(new RegExp(`^${adverb}caused by (.+)$`, "i")))) {
      out.push({ subject: S, relation: "caused-by", fact: x[2]!, question: `What ${x[1] ?? ""}causes ${Sq}?`.replace(/\s+/g, " "), kind: "MECHANISM", importance: 2.5 + core });
    } else if ((x = m(new RegExp(`^${adverb}(characteri[sz]ed|marked) by (.+)$`, "i")))) {
      out.push({ subject: S, relation: "characterized-by", fact: x[3]!, question: `What ${aux} ${Sq} ${x[2]!.toLowerCase()} by?`, importance: 2.3 + core });
    } else if ((x = m(/^defined as (.+)$/i))) {
      out.push({ subject: S, relation: "defined-as", fact: x[1]!, question: `How ${aux} ${Sq} defined?`, importance: 2.5 + core });
    } else if ((x = m(new RegExp(`^(?:${adverb})(seen|found|located|present|observed)\\s+((?:\\w+ly\\s+)?(?:in|within|at|on|around|near)\\b.+)$`, "i")))) {
      out.push({ subject: S, relation: "location", fact: `${x[1] ?? ""}${x[3]!}`.trim(), question: `Where ${aux} ${Sq} ${x[2]!.toLowerCase()}?`, importance: 2 + core });
    } else if ((x = m(/^used\s+(.+)$/i))) {
      const use = targetForUse(S, aux, x[1]!);
      if (use) out.push({ ...use, importance: 2.5 + core });
    } else if ((x = m(/^(?:also\s+)?(called|termed|known as|referred to as)\s+(.+)$/i))) {
      out.push({ subject: S, relation: "identity", fact: x[2]!, question: `What ${aux} ${Sq} ${x[1]!.toLowerCase()}?`, importance: 2.3 + core });
    } else if ((x = m(/^given\s+to\s+(.+)$/i))) {
      out.push({ subject: S, relation: "purpose", fact: x[1]!, question: `Fill in the blank: ${S} ${aux} given to ___.`, kind: "CLOZE", importance: 1.8 });
    } else if (PARTICIPLE.test(rest) && (x = m(/^(\S+(?:ed|en))\s+(.*?)\bby\s+(.+)$/i))) {
      out.push({ subject: S, relation: "passive", fact: x[3]!, question: `Fill in the blank: ${S} ${aux} ${x[1]} ${x[2]}by ___.`.replace(/\s+/g, " "), kind: "CLOZE", importance: 1.8 + core });
    } else if ((x = m(/^(\S+(?:ed|en))\s+(with|in|at|on|to|from|as|into|for)\s+(.+)$/i))) {
      // "Heparin is monitored with the aPTT": the blank is what follows the participle and its preposition.
      out.push({ subject: S, relation: "passive", fact: x[3]!, question: `Fill in the blank: ${S} ${aux} ${x[1]} ${x[2]} ___.`, kind: "CLOZE", importance: 1.8 + core });
    } else if (PARTICIPLE.test(rest) || ADJECTIVE_PHRASE.test(rest) || /^(not|also|very|more|less|most|highly|usually|often)\b/i.test(rest)) {
      out.push({ subject: S, relation: "cloze", fact: rest, question: `Fill in the blank: ${S} ${aux} ___.`, kind: "CLOZE", importance: 1.2 });
    } else if (/^the\s/i.test(rest) && !/^(the|a|an)\s/i.test(S) && !NUMBER_WORD.test(words(S)[0] ?? "")) {
      // "Acetylcholine is the neurotransmitter of …": ask for the subject.
      out.push({ subject: S, relation: "identity", fact: S, question: `What ${aux} ${rest}?`, importance: 2.5 + core });
    } else if (/^the\s/i.test(S) || NUMBER_WORD.test(words(S)[0] ?? "")) {
      // "The two main morphologic correlates of … are A and B": ask for the rest.
      out.push({ subject: S, relation: "identity", fact: rest, question: `What ${aux} ${Sq}?`, importance: 2.5 + core });
    } else {
      // A definition; a "used to …" tail is its own target.
      const tail = /^(.+?),?\s+(?:that is |which is |that are |which are )?used\s+((?:to|in|for)\b.+)$/i.exec(rest);
      const answer = tail ? tail[1]! : rest;
      out.push({ subject: S, relation: "definition", fact: answer, question: `What ${aux} ${Sq}?`, importance: 2.5 + core });
      if (tail) {
        const use = targetForUse(S, aux, tail[2]!);
        if (use) out.push({ ...use, importance: 2.5 });
      }
    }
    return out;
  }

  const base = clause.base;
  const doer = doFor(clause);
  const verbPhrase = clause.aux && !["is", "are"].includes(clause.aux) ? base : base;
  // "Therefore, ischemia injures tissues faster than hypoxia alone."
  const comparison = /^(.*?)\s*\b(faster|slower|more\s+\w+|less\s+\w+|greater|earlier|later|better|worse)\s+than\s+(.+)$/i.exec(rest);
  if (comparison && !clause.aux) {
    const object = comparison[1]!.trim();
    out.push({
      subject: S,
      relation: "comparison",
      fact: S,
      question: `Which ${clause.verb}${object ? ` ${object}` : ""} ${comparison[2]}: ${Sq} or ${trimEnd(comparison[3]!.split(/,|\s+(?:because|since|as|when|while|whereas|but|so)\s/)[0]!)}?`,
      importance: 2.3 + core,
    });
    return out;
  }
  if (base === "result" && /^from\s/i.test(rest)) {
    out.push({ subject: S, relation: "result-from", fact: rest.replace(/^from\s+/i, ""), question: `What ${doer} ${Sq} ${advs}result from?`, kind: "MECHANISM", importance: 2.5 + core });
    return out;
  }
  if (clause.verb === "→" || clause.verb === "->") {
    out.push({ subject: S, relation: "cause", fact: rest, question: `What does ${Sq} lead to?`, kind: "MECHANISM", importance: 2.3 + core });
    return out;
  }
  if (CAUSAL.has(base)) {
    const prep = /^(to|in)\s/i.exec(rest)?.[1]?.toLowerCase() ?? "";
    const object = prep ? rest.slice(prep.length).trim() : rest;
    const { first, verb, second } = coordinated(object);
    const { head, clause: other } = independent(first);
    out.push({ subject: S, relation: "cause", fact: head, question: `What ${doer} ${Sq} ${advs}${verbPhrase}${prep ? ` ${prep}` : ""}?`, kind: "MECHANISM", importance: 2.5 + core });
    if (verb && second) out.push({ subject: S, relation: "action", fact: second, question: `What ${doer} ${Sq} ${baseOf(verb)}?`, importance: 2 });
    if (other) out.push(clauseTarget(other));
    return out;
  }
  if (TIMING_VERBS.has(base)) {
    if (/^(when|whenever|if|after|once)\b/i.test(rest) || TIME_START.test(rest)) {
      out.push({ subject: S, relation: "timing", fact: rest, question: `When ${doer} ${Sq} ${advs}${base}?`, importance: 2 + core });
    } else if (/^(in|within|at|on)\s/i.test(rest)) {
      out.push({ subject: S, relation: "location", fact: rest, question: `Where ${doer} ${Sq} ${advs}${base}?`, importance: 2 + core });
    } else {
      out.push({ subject: S, relation: "cloze", fact: rest, question: `Fill in the blank: ${S} ${advs}${clause.verb} ___.`, kind: "CLOZE", importance: 1.2 });
    }
    return out;
  }
  if (base === "consist" && /^of\s/i.test(rest)) {
    out.push({ subject: S, relation: "includes", fact: rest.replace(/^of\s+/i, ""), question: `What ${doer} ${Sq} consist of?`, importance: 2.2 + core });
    return out;
  }
  if (base === "include" || base === "contain") {
    out.push({ subject: S, relation: "includes", fact: rest, question: `What ${doer} ${Sq} ${base}?`, importance: 2.2 + core });
    return out;
  }
  if (clause.negated) {
    out.push({ subject: S, relation: "cloze", fact: rest.replace(/^not\s+/i, ""), question: `Fill in the blank: ${S} ${clause.verb} ___.`, kind: "CLOZE", importance: 1.2 });
    return out;
  }
  // Verbs without an object ("Lipid accumulates as clear vacuoles …"): the rest is blanked, not asked as "what".
  if (INTRANSITIVE.has(base) && !/^(on|to|into|with)\s/i.test(rest)) {
    out.push({ subject: S, relation: "cloze", fact: rest, question: `Fill in the blank: ${S} ${advs}${clause.verb} ___.`, kind: "CLOZE", importance: 1.2 });
    return out;
  }
  // Transitive verbs: "Cocaine blocks the reuptake of …" → "What does cocaine block?"
  const prep = /^(on|to|with|into|from|against|through|via)\s/i.exec(rest)?.[1]?.toLowerCase() ?? "";
  const object = prep ? rest.slice(prep.length).trim() : rest;
  const { first: whole, verb, second } = coordinated(object);
  const { head: first, clause: other } = independent(whole);
  if (words(first).length === 0) return out;
  out.push({
    subject: S,
    relation: "action",
    fact: first,
    question: `What ${doer} ${Sq} ${advs}${base}${prep ? ` ${prep}` : ""}?`,
    kind: base === "activate" || base === "inhibit" ? "MECHANISM" : "BASIC",
    importance: (PHARM_VERBS.has(base) ? 2.3 : 2) + core,
  });
  if (verb && second) {
    const b = baseOf(verb);
    out.push({ subject: S, relation: CAUSAL.has(b) ? "cause" : "action", fact: second, question: `What ${doer} ${Sq} ${b}?`, kind: CAUSAL.has(b) ? "MECHANISM" : "BASIC", importance: 2.2 });
  }
  if (other) out.push(clauseTarget(other));
  return out;
}

/** A second clause's own target: "integrins mediate firm adhesion" → "What do integrins mediate?". */
function clauseTarget(c: Clause): Draft {
  const rest = trimEnd(c.rest);
  const cause = CAUSAL.has(c.base);
  const prep = /^(to|in|on|through|via|into|from|with)\s/i.exec(rest)?.[1]?.toLowerCase() ?? "";
  return {
    subject: c.subject,
    relation: cause ? "cause" : "action",
    fact: prep ? rest.slice(prep.length).trim() : rest,
    question: `What ${doFor(c)} ${inQuestion(c.subject)} ${c.adverbs ? `${c.adverbs} ` : ""}${c.base}${prep ? ` ${prep}` : ""}?`,
    kind: cause ? "MECHANISM" : "BASIC",
    importance: 2,
  };
}

/** "used to treat X" / "used in X" / "used to reverse A and to treat B". */
function targetForUse(subject: string, aux: string, tail: string): Omit<Draft, "importance"> | null {
  const t = trimEnd(tail);
  const Sq = inQuestion(subject);
  let x: RegExpExecArray | null;
  if ((x = /^to\s+(treat|prevent|reverse|relieve|control|reduce|diagnose)\s+(.+)$/i.exec(t)) && !/\band to\b/i.test(x[2]!)) {
    return { subject, relation: "use", fact: x[2]!, question: `What ${aux} ${Sq} used to ${x[1]!.toLowerCase()}?` };
  }
  if ((x = /^in\s+(?:the\s+treatment\s+of\s+)?(.+)$/i.exec(t))) {
    return { subject, relation: "use", fact: x[1]!, question: `What ${aux} ${Sq} used in?` };
  }
  if ((x = /^for\s+(.+)$/i.exec(t))) {
    return { subject, relation: "use", fact: x[1]!, question: `What ${aux} ${Sq} used for?` };
  }
  if (/^to\s/i.test(t)) return { subject, relation: "use", fact: t, question: `What ${aux} ${Sq} used for?` };
  return null;
}

/** Capitalised words that follow a lower-case word somewhere in the text: names, not sentence starts. */
export function properNounsOf(texts: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const text of texts) {
    // Same line, after a lower-case word and a space: never the first word of a line, a bullet or a table cell.
    for (const m of text.matchAll(/(?<=\b[a-z][a-z-]*[,;]? )([A-Z][a-z'’-]+)\b/g)) names.add(m[1]!);
  }
  return names;
}

const GENERIC_FEATURE = /^(features?|characteristics?|parameters?|propert(?:y|ies)|findings?|criteri(?:on|a)|aspects?|variables?|attributes?|)$/i;

function tableTargets(fact: Fact): (Draft & { excerpt: string })[] {
  const rows = fact.rows ?? [];
  const [header, ...body] = rows;
  if (!header) return [];
  const out: (Draft & { excerpt: string })[] = [];
  const headerLine = header.join("\t");
  // "Type of shock" | "Cardiogenic": the row is "cardiogenic shock".
  const kindOf = /^(?:types?|kinds?|forms?|class(?:es)?|categor(?:y|ies)|classification)\s+of\s+(.+)$/i.exec(header[0]!.trim())?.[1];
  const keyOf = (key: string) => (kindOf && words(key).length <= 2 && !normalize(key).includes(normalize(kindOf)) ? `${key} ${kindOf.replace(/s$/i, "")}` : key);
  const comparison = GENERIC_FEATURE.test(header[0]!.trim()) || (/\b(versus|vs\.?|compared)\b/i.test(fact.heading ?? "") && header.length <= 4);
  for (const row of body) {
    const excerpt = `${headerLine}\n${row.join("\t")}`;
    if (comparison) {
      const entities = header.slice(1);
      const values = row.slice(1);
      const same = new Set(values.map((v) => normalize(v))).size === 1;
      const names = entities.map(inQuestion).length === 2 ? `${inQuestion(entities[0]!)} and ${inQuestion(entities[1]!)}` : `${entities.slice(0, -1).map(inQuestion).join(", ")} and ${inQuestion(entities[entities.length - 1]!)}`;
      out.push({
        subject: row[0]!,
        relation: "table-compare",
        fact: entities.map((e, i) => `${e}: ${values[i]}`).join("; "),
        question: `Compare the ${label(row[0]!)} in ${inQuestion(names)}.`,
        importance: same ? 1 : 2.1,
        excerpt,
      });
    } else {
      row.slice(1).forEach((cell, c) => {
        out.push({
          subject: keyOf(row[0]!),
          relation: "table-cell",
          fact: cell,
          question: `What is the ${label(header[c + 1]!)} of ${inQuestion(keyOf(row[0]!))}?`,
          importance: c === 0 ? 2.2 : 2,
          excerpt,
        });
      });
    }
  }
  return out;
}

/**
 * The learning targets of one fact (possibly none). `names`: words the
 * lecture capitalises mid-sentence (see `properNounsOf`).
 */
export function targetsOf(fact: Fact, names: ReadonlySet<string> = new Set()): LearningTarget[] {
  properNouns = names;
  const make = (d: Draft, ordinal: number, excerpt?: string, context = ""): LearningTarget => ({
    subject: d.subject,
    relation: d.relation,
    // One retrieval: a reason given after the answer ("… because it is teratogenic") is not part of it.
    fact: capital(trimEnd(d.fact.split(/,?\s+because\s+/i)[0]!)),
    question: d.question.replace(/\s+/g, " ").replace(/\s+([?.])/g, "$1").trim(),
    kind: d.kind ?? "BASIC",
    sourcePage: fact.pageNumber,
    sourceExcerpt: excerpt ?? fact.excerpt ?? fact.text,
    importance: d.importance,
    source: fact,
    ordinal,
    context,
  });
  const ctx = [fact.heading ?? "", fact.context ?? "", fact.antecedent ?? "", fact.resolved ?? ""].join(" ");
  switch (fact.kind) {
    case "figure":
      return [make({ subject: fact.term, relation: "figure", fact: fact.figure?.answer ?? fact.term, question: "What is shown in this image?", kind: "IMAGE", importance: 2.5 }, 0, fact.text, ctx)];
    case "list": {
      const items = fact.items ?? [];
      return [make({ subject: fact.term, relation: "list", fact: items.join("; "), question: `List: ${fact.term}`, importance: 2 + (CORE.test(fact.term) ? 0.5 : 0) - (items.length > 8 ? 0.5 : 0) }, 0, fact.text, ctx)];
    }
    case "pair": {
      const labelText = fact.label ?? fact.term;
      const detail = fact.detail ?? "";
      const plural = /s$/i.test(labelText) && !/(?:sis|ss|us|is|xis)$/i.test(labelText);
      const listLike = /,|\band\b/.test(detail) && plural && fact.context;
      const question = listLike ? `Which ${label(labelText)} are listed under ${label(fact.context!)}?` : `What ${plural ? "are" : "is"} ${inQuestion(labelText)}?`;
      return [make({ subject: labelText, relation: "pair", fact: detail, question, importance: listLike ? 1.8 : 2.2 }, 0, fact.text, ctx)];
    }
    case "table":
      return tableTargets(fact).map((d, i) => make(d, i, d.excerpt, `${ctx} ${(fact.rows ?? [])[0]?.join(" ") ?? ""}`));
    default:
      return sentenceTargets(fact).map((d, i) => make(d, i, undefined, ctx));
  }
}

/* ------------------------------------------------------------------ */
/* Quality filters                                                      */
/* ------------------------------------------------------------------ */

/** Words a question template adds (never evidence of anything). */
const TEMPLATE = new Set([
  "what", "which", "where", "when", "how", "does", "do", "did", "is", "are", "was", "were", "can", "may", "might", "must", "will", "should", "could",
  "the", "a", "an", "of", "in", "to", "for", "by", "on", "with", "from", "and", "or", "used", "treat", "prevent", "reverse", "fill", "blank",
  "compare", "list", "listed", "under", "cause", "causes", "lead", "result", "consist", "include", "shown", "this", "image", "defined", "given",
  "at", "into", "against", "be", "than",
]);

const contentOf = (text: string) => normalize(text).split(" ").filter((w) => w.length > 1 && !TEMPLATE.has(w));
/** Plural-insensitive word match. */
const stemmed = (w: string) => (w.length > 4 ? w.replace(/ies$/, "y").replace(/(?<=[^s])s$/, "").replace(/(?:ed|ing|e)$/, "") : w);

/**
 * Why a target must not become a card, or null when it may.
 * `page` is the target's page, for the excerpt check.
 */
export function rejectTarget(target: LearningTarget, page: Pick<Page, "text" | "layout">): string | null {
  const q = target.question;
  const a = target.fact;
  if (!q || !a) return "empty";
  if (/\?\s*$/.test(target.sourceExcerpt.trim()) && target.relation !== "figure") return "question-only-source";
  const multi = target.relation === "list" || target.relation === "table-compare";
  const answerWords = words(a).length;
  if (!multi && answerWords > 30) return "answer-too-long";
  // The blank must test knowledge: at least one content word.
  const answerContent = contentOf(a);
  if (answerContent.length === 0 && !/\d/.test(a)) return "meaningless-blank";
  if (target.relation !== "figure" && OPEN_END.test(trimEnd(a).toLowerCase())) return "truncated-answer";
  if (PRONOUN.test(a) || PRONOUN.test(target.subject)) return "pronoun";
  if (CONJUNCTION_START.test(a) || CONJUNCTION_START.test(target.subject)) return "orphan-fragment";
  if (!multi && /[.!?]\s+[A-Z]/.test(a)) return "multiple-targets";
  if (target.relation === "list" && (target.source.items ?? []).some((i) => OPEN_END.test(i.toLowerCase()) || words(i).length === 0)) return "incomplete-list";
  // The question must not give the answer away.
  const qWords = new Set(normalize(q.replace(/___/g, " ")).split(" ").map(stemmed));
  if (target.relation !== "figure" && target.relation !== "comparison" && answerContent.length > 0 && answerContent.every((w) => qWords.has(stemmed(w)))) return "answer-leak";
  if (target.relation !== "figure" && normalize(q).includes(normalize(a)) && target.relation !== "comparison") return "answer-leak";
  // Grounded: the answer's words and the question's content words come from the source (or its stated context).
  const source = new Set(normalize(`${target.sourceExcerpt} ${target.source.resolved ?? ""}`).split(" ").map(stemmed));
  if (answerContent.some((w) => !source.has(stemmed(w)))) return "unsupported-answer";
  const context = new Set(normalize(`${target.sourceExcerpt} ${target.context}`).split(" ").map(stemmed));
  if (contentOf(q.replace(/___/g, " ")).some((w) => !context.has(stemmed(w)))) return "unsupported-question";
  // The excerpt is the page's own text, inside one block.
  if (!excerptOnPage(target.sourceExcerpt, page)) return "excerpt-not-verbatim";
  return null;
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Whether every line of an excerpt is found verbatim (whitespace aside) in
 * ONE line of the page, all of them in the same block (blank-line
 * separated). A merged or rewritten excerpt fails. Pages extracted before
 * structure was kept have visual lines, so there a line may wrap: the
 * excerpt is looked for in the page's text with line breaks as spaces.
 */
export function excerptOnPage(excerpt: string, page: Pick<Page, "text" | "layout">): boolean {
  const lines = excerpt.split("\n").map(squash).filter(Boolean);
  if (lines.length === 0) return false;
  if (page.layout !== "blocks") {
    const flat = squash(page.text);
    return lines.every((line) => flat.includes(line));
  }
  const blocks = page.text.split(/\n[ \t]*\n/).map((b) => b.split("\n").map(squash));
  return blocks.some((block) => lines.every((line) => block.some((l) => l.includes(line))));
}
