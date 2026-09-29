import type { CardLanguage } from "@/lib/domain/types";

/**
 * Deterministic Arabic rendering of the generator's fact templates.
 *
 * The rendering works on the STRUCTURE of a fact (subject, connector,
 * object), never word by word. A sentence is split into noun phrases and
 * the connectors between them ("causes", "leads to", "is caused by", "in",
 * "and", …). Connectors and question words are always Arabic, so the
 * sentence is an Arabic sentence. Each noun phrase is then either rendered
 * as a whole, or kept exactly as the lecture wrote it; it is never
 * translated word by word, which would scramble Arabic word order.
 *
 * Two modes, meaningfully different:
 *
 * - `ar-en` (Arabic + English medical terms): Arabic sentence and general
 *   words ("failure" → "فشل", "most common cause" → "السبب الأكثر شيوعًا");
 *   medical noun phrases stay in English ("ATP depletion", "cell injury").
 * - `ar` (Arabic): the same, plus every medical term the general lexicon
 *   knows written in Arabic with the English in brackets
 *   ("نقص الأكسجة (Hypoxia)"), and adjective + noun phrases rendered in
 *   Arabic order ("irreversible injury" → "إصابة غير عكوسة"). Terms the
 *   lexicon does not know stay in English.
 *
 * The lexicon is general medical vocabulary, not a fixture. Nothing is
 * translated that is not in it. When a sentence falls outside the supported
 * patterns, part of it stays in English and the card is reported as
 * `partial`, which the UI discloses.
 */

export type ArabicMode = Exclude<CardLanguage, "en">;
export type Coverage = "arabic" | "partial";

export interface RenderedArabic {
  prompt: string;
  explanation: string;
  coverage: Coverage;
}

/* ------------------------------------------------------------------ */
/* Lexicon                                                              */
/* ------------------------------------------------------------------ */

/** General nouns and whole general phrases: Arabic in BOTH modes. */
const GENERAL: Record<string, string> = {
  failure: "فشل", loss: "فقدان", cause: "سبب", causes: "أسباب", mechanism: "آلية", mechanisms: "آليات",
  manifestation: "مظهر", manifestations: "مظاهر", feature: "سمة", features: "سمات", pattern: "نمط", patterns: "أنماط",
  type: "نوع", types: "أنواع", stage: "مرحلة", stages: "مراحل", step: "خطوة", steps: "خطوات", pathway: "مسار", pathways: "مسارات",
  change: "تغير", changes: "تغيرات", damage: "تلف", injury: "إصابة", injuries: "إصابات", transition: "الانتقال",
  release: "تحرر", influx: "تدفق", efflux: "خروج", accumulation: "تراكم", depletion: "نفاد", production: "إنتاج", delivery: "توصيل",
  function: "وظيفة", dysfunction: "خلل", swelling: "تورم", death: "موت", switch: "التحول", exudation: "نضح", formation: "تكوّن",
  energy: "طاقة", water: "ماء", oxygen: "أكسجين", blood: "دم", cell: "خلية", cells: "خلايا", tissue: "نسيج", tissues: "أنسجة",
  organ: "عضو", organs: "أعضاء", patient: "المريض", patients: "المرضى", disease: "مرض", diseases: "أمراض", symptoms: "أعراض",
  signs: "علامات", diagnosis: "تشخيص", treatment: "علاج", pain: "ألم", fever: "حمى", heat: "حرارة", redness: "احمرار",
  hours: "ساعات", days: "أيام", reaction: "تفاعل", response: "استجابة", fluid: "سائل", forms: "أشكال", form: "شكل",
  "injury to cells": "إصابة الخلايا", "injury to the cell": "إصابة الخلية", "loss of function": "فقدان الوظيفة",
};

/** Words that go BEFORE the noun in Arabic too: quantifiers, ordinals, and "increased/decreased X". */
const PRENOMINAL: Record<string, string> = {
  "almost all": "معظم", all: "جميع", most: "معظم", many: "العديد من", several: "عدة", some: "بعض", each: "كل", every: "كل",
  first: "أول", earliest: "أبكر", increased: "زيادة", decreased: "انخفاض", reduced: "انخفاض", elevated: "ارتفاع", raised: "ارتفاع",
  low: "انخفاض", high: "ارتفاع", impaired: "ضعف", excessive: "فرط",
};

/** Adjectives, for `ar` mode's noun + adjective reordering. */
const ADJECTIVES: Record<string, string> = {
  severe: "شديد", mild: "خفيف", acute: "حاد", chronic: "مزمن", early: "مبكر", late: "متأخر", main: "رئيسي", major: "رئيسي",
  reversible: "عكوس", irreversible: "غير عكوس", normal: "طبيعي", abnormal: "غير طبيعي", intracellular: "داخل خلوي",
  extracellular: "خارج خلوي", cellular: "خلوي", toxic: "سام", metabolic: "استقلابي", inflammatory: "التهابي",
  hypoxic: "ناقص الأكسجة", ischaemic: "إقفاري", ischemic: "إقفاري", vascular: "وعائي", renal: "كلوي", hepatic: "كبدي",
};

/** Medical terms: kept English in `ar-en`; Arabic with the English in brackets in `ar`. */
const MEDICAL: Record<string, string> = {
  "programmed cell death": "الموت الخلوي المبرمج", "cell injury": "إصابة الخلية", "cellular swelling": "التورم الخلوي",
  "fatty change": "التغير الدهني", "hydropic change": "التغير المائي", "membrane damage": "تلف الغشاء",
  "mitochondrial dysfunction": "خلل الميتوكوندريا", "ion pumps": "مضخات الأيونات", "ion pump": "مضخة الأيونات",
  "sodium pump": "مضخة الصوديوم", "atp depletion": "نفاد ATP", "blood supply": "التروية الدموية", "blood flow": "تدفق الدم",
  "acute inflammation": "الالتهاب الحاد", "chronic inflammation": "الالتهاب المزمن", "vascular permeability": "نفاذية الأوعية",
  "oxidative phosphorylation": "الفسفرة التأكسدية", "anaerobic glycolysis": "التحلل السكري اللاهوائي", "free radicals": "الجذور الحرة",
  "immune response": "الاستجابة المناعية", "plasma membrane": "الغشاء البلازمي", "cell membrane": "غشاء الخلية",
  "parenchymal cells": "الخلايا البرانشيمية", "renal tubular cells": "خلايا النبيبات الكلوية", "intrinsic pathway": "المسار الداخلي",
  "extrinsic pathway": "المسار الخارجي", "inflammatory reaction": "التفاعل الالتهابي", "coagulative necrosis": "النخر التخثري",
  "liquefactive necrosis": "النخر التميعي", "caseous necrosis": "النخر الجبني", "fat necrosis": "النخر الدهني",
  "fibrinoid necrosis": "النخر الفيبرينوئيدي", "gangrenous necrosis": "النخر الغنغريني", "physical agents": "العوامل الفيزيائية",
  "chemical agents": "العوامل الكيميائية", "infectious agents": "العوامل المعدية", "immunologic reactions": "التفاعلات المناعية",
  "genetic derangements": "الاضطرابات الوراثية", "nutritional imbalances": "اختلالات التغذية", "cardinal signs": "العلامات الأساسية",
  hypoxia: "نقص الأكسجة", ischaemia: "نقص التروية", ischemia: "نقص التروية", inflammation: "الالتهاب", necrosis: "النخر",
  apoptosis: "الاستماتة", steatosis: "التنكس الدهني", oedema: "الوذمة", edema: "الوذمة", exudate: "النضحة", infection: "العدوى",
  tumour: "الورم", tumor: "الورم", cancer: "السرطان", membrane: "الغشاء", mitochondria: "الميتوكوندريا", mitochondrion: "الميتوكوندريون",
  nucleus: "النواة", cytoplasm: "السيتوبلازم", protein: "البروتين", proteins: "البروتينات", enzyme: "الإنزيم", enzymes: "الإنزيمات",
  liver: "الكبد", kidney: "الكلية", heart: "القلب", lung: "الرئة", lungs: "الرئتان", brain: "الدماغ", skin: "الجلد",
  neutrophils: "العدلات", macrophages: "البلاعم", lymphocytes: "اللمفاويات", leukocytes: "الكريات البيض", monocytes: "الوحيدات",
  histamine: "الهيستامين", prostaglandins: "البروستاغلاندينات", bradykinin: "البراديكينين", vasodilation: "توسع الأوعية",
  permeability: "النفاذية", glycolysis: "التحلل السكري", triglycerides: "الدهون الثلاثية", caspases: "الكاسبيزات",
  sodium: "الصوديوم", potassium: "البوتاسيوم", calcium: "الكالسيوم", glucose: "الغلوكوز", hepatocytes: "خلايا الكبد",
  endothelium: "البطانة", selectins: "السيليكتينات", integrins: "الإنتغرينات", drugs: "الأدوية",
};

/**
 * Connectors, verbs and function words: always Arabic (longest match first).
 * They split a sentence into noun phrases.
 */
const CONNECTORS: Record<string, string> = {
  "is caused by": "يحدث بسبب", "are caused by": "تحدث بسبب", "caused by": "بسبب", "is due to": "يحدث بسبب", "due to": "بسبب",
  "leads to": "يؤدي إلى", "lead to": "تؤدي إلى", "results in": "ينتج عنه", "result in": "ينتج عنها", "resulting in": "مما ينتج عنه",
  "is defined by": "يُعرَّف بـ", "is defined as": "يُعرَّف بأنه", "defined as": "المعرَّف بأنه", "is characterized by": "يتميز بـ",
  "is characterised by": "يتميز بـ", "are characterized by": "تتميز بـ", "characterized by": "يتميز بـ", "is marked by": "يتميز بـ",
  "is associated with": "يرتبط بـ", "associated with": "المرتبط بـ", "mediated by": "بوساطة", "followed by": "يليه",
  "is seen in": "يُشاهد في", "are seen in": "تُشاهد في", "seen in": "يُشاهد في", "is found in": "يوجد في", "occurs in": "يحدث في",
  "are replaced by": "تُستبدل بـ", "is replaced by": "يُستبدل بـ", "does not elicit": "لا يُحدث", "does not": "لا", "do not": "لا",
  "to arrive in": "تصل إلى", "to arrive at": "تصل إلى", "switch to": "التحول إلى", "switches to": "يتحول إلى",
  produces: "ينتج", producing: "منتجًا", causes: "يسبب", cause: "تسبب", activates: "يُنشِّط", inhibits: "يثبط", triggers: "يُطلق",
  allows: "يسمح بـ", marks: "يمثل", shows: "يُظهر", show: "تُظهر", lowers: "يخفض", raises: "يرفع", increases: "يزيد",
  decreases: "يقلل", reduces: "يقلل", stops: "يتوقف", stop: "يتوقف", injures: "يُصيب", occurs: "يحدث", occur: "تحدث",
  contains: "يحتوي على", includes: "يشمل", include: "تشمل", involves: "يتضمن", requires: "يتطلب", becomes: "يصبح",
  develops: "يتطور", prevents: "يمنع", promotes: "يعزز", stimulates: "يحفز", mediate: "تتوسط", mediates: "يتوسط",
  elicit: "يُحدث", elicits: "يُحدث", arrive: "تصل", arrives: "يصل", because: "لأن", also: "أيضًا", mainly: "بشكل رئيسي",
  often: "غالبًا", usually: "عادةً", only: "فقط", which: "الذي", that: "الذي", and: "و", or: "أو", with: "مع", without: "دون",
  within: "داخل", into: "إلى", to: "إلى", from: "من", in: "في", after: "بعد", before: "قبل", during: "أثناء", between: "بين",
  by: "بواسطة", for: "لـ", than: "من", as: "كـ", at: "عند", on: "على", is: "هو", are: "هي", not: "لا", no: "لا",
};

const ARTICLES = new Set(["the", "a", "an"]);
/** A single-word verb followed by "of" is a noun ("Causes of cell injury"). */
const NOUN_BEFORE_OF = new Set(["causes", "cause", "shows", "forms", "switch", "release"]);

/* ------------------------------------------------------------------ */
/* Phrase rendering                                                     */
/* ------------------------------------------------------------------ */

type Token = { kind: "word"; raw: string; low: string } | { kind: "punct"; raw: string } | { kind: "verbatim"; raw: string };

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const parts = text.replace(/[.!?]+$/, "").split(/\s+/).filter(Boolean);
  let paren: string[] | null = null;
  for (const part of parts) {
    if (paren) {
      paren.push(part);
      if (part.includes(")")) {
        out.push({ kind: "verbatim", raw: paren.join(" ") });
        paren = null;
      }
      continue;
    }
    if (part.startsWith("(")) {
      if (part.includes(")")) out.push({ kind: "verbatim", raw: part });
      else paren = [part];
      continue;
    }
    const trail = /([,;:]+)$/.exec(part);
    const word = trail ? part.slice(0, -trail[1]!.length) : part;
    if (word) {
      if (/^[\p{L}\p{N}]/u.test(word) || word === "___") out.push({ kind: "word", raw: word, low: word.toLowerCase() });
      else out.push({ kind: "verbatim", raw: word });
    }
    if (trail) out.push({ kind: "punct", raw: trail[1]! });
  }
  if (paren) out.push({ kind: "verbatim", raw: paren.join(" ") });
  return out;
}

/** Abbreviations, formulas, numbers and blanks stay as written in every mode. */
function keepsLatin(raw: string): boolean {
  return raw === "___" || /\d/.test(raw) || /[+/]/.test(raw) || /^[A-Z]{2,}[a-z]?$/.test(raw);
}

function longest(dict: Record<string, string>, words: readonly string[], start: number, max = 5): { ar: string; len: number } | null {
  for (let len = Math.min(max, words.length - start); len >= 1; len--) {
    const key = words.slice(start, start + len).join(" ");
    const ar = dict[key];
    if (ar !== undefined) return { ar, len };
  }
  return null;
}

/** Arabic adjective agreement: feminine noun (ending in ة) → feminine adjective. */
function agree(adjective: string, noun: string): string {
  if (!/ة$/.test(noun.split(" ")[0] ?? "")) return adjective;
  const parts = adjective.split(" ");
  const last = parts.pop()!;
  const fem = /ي$/.test(last) ? `${last}ة` : /ة$/.test(last) ? last : `${last}ة`;
  return [...parts, fem].join(" ");
}

interface ChunkResult {
  text: string;
  arabic: boolean;
  /** The chunk ends with an English term in brackets ("الاستماتة (Apoptosis)"). */
  bracketed: boolean;
  /** Words left in English that are not a term (a clause): the card is partial. */
  clause: boolean;
}

/** One noun phrase: rendered as a whole, or kept as the lecture wrote it. */
function renderChunk(raws: readonly string[], mode: ArabicMode): ChunkResult | null {
  let words = [...raws];
  while (words.length > 0 && ARTICLES.has(words[0]!.toLowerCase())) words = words.slice(1);
  if (words.length === 0) return null;
  const lows = words.map((w) => w.toLowerCase());
  const whole = lows.join(" ");
  if (GENERAL[whole]) return { text: GENERAL[whole]!, arabic: true, bracketed: false, clause: false };
  if (mode === "ar" && MEDICAL[whole]) return { text: `${MEDICAL[whole]} (${words.join(" ")})`, arabic: true, bracketed: true, clause: false };

  // Quantifiers / ordinals / "increased X": Arabic, before the noun, in both modes.
  const prefix: string[] = [];
  let start = 0;
  for (;;) {
    const hit = longest(PRENOMINAL, lows, start, 2);
    if (!hit || start + hit.len >= lows.length) break;
    prefix.push(hit.ar);
    start += hit.len;
  }
  const coreRaw = words.slice(start);
  const core = lows.slice(start);
  const coreKey = core.join(" ");
  const pre = prefix.length > 0 ? `${prefix.join(" ")} ` : "";

  if (GENERAL[coreKey]) return { text: `${pre}${GENERAL[coreKey]}`, arabic: true, bracketed: false, clause: false };
  if (mode === "ar" && MEDICAL[coreKey]) return { text: `${pre}${MEDICAL[coreKey]} (${coreRaw.join(" ")})`, arabic: true, bracketed: true, clause: false };

  // `ar` only: adjectives + a known noun → noun + adjectives, in Arabic order.
  if (mode === "ar" && core.length >= 2) {
    const nounKey = core[core.length - 1]!;
    const noun = GENERAL[nounKey] ?? MEDICAL[nounKey];
    const adjectives = core.slice(0, -1).map((a) => ADJECTIVES[a]);
    if (noun && adjectives.every(Boolean)) {
      const arabicAdjectives = adjectives.map((a) => agree(a!, noun)).reverse();
      const text = `${pre}${noun} ${arabicAdjectives.join(" ")}`;
      return MEDICAL[nounKey]
        ? { text: `${text} (${coreRaw.join(" ")})`, arabic: true, bracketed: true, clause: false }
        : { text, arabic: true, bracketed: false, clause: false };
    }
  }

  // Kept as written: a term if short, a clause if long.
  const english = coreRaw.join(" ");
  return { text: `${pre}${english}`, arabic: prefix.length > 0, bracketed: false, clause: core.length > 5 && !core.every((w) => keepsLatin(w)) };
}

export interface RenderedPhrase {
  text: string;
  /** Some English was left that is not a term (a clause the patterns do not cover). */
  partial: boolean;
  /** At least one noun phrase or connector was rendered in Arabic. */
  hasArabic: boolean;
}

/**
 * Render an English phrase: connectors in Arabic, each noun phrase as a
 * whole (Arabic when the lexicon knows it for this mode, else as written).
 */
export function renderPhrase(source: string, mode: ArabicMode): RenderedPhrase {
  const tokens = tokenize(source);
  const out: string[] = [];
  let partial = false;
  let hasArabic = false;
  let previous: ChunkResult | null = null;
  let i = 0;
  const words = () => tokens.map((t) => (t.kind === "word" ? t.low : "\u0000"));
  const lows = words();

  const flushChunk = (raws: string[]) => {
    const chunk = renderChunk(raws, mode);
    if (!chunk) return;
    out.push(chunk.text);
    partial ||= chunk.clause;
    hasArabic ||= chunk.arabic;
    previous = chunk;
  };

  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind === "punct") {
      out.push(token.raw.replace(/,/g, "،").replace(/;/g, "؛"));
      previous = null;
      i++;
      continue;
    }
    if (token.kind === "verbatim") {
      out.push(token.raw);
      previous = null;
      i++;
      continue;
    }
    if (token.low === "of") {
      // Arabic idafa needs no preposition after an Arabic head; after a
      // bracketed term "لـ" keeps it readable; between English words it stays.
      const prev = previous as ChunkResult | null;
      if (prev?.arabic) out.push(prev.bracketed ? "لـ" : "");
      else out.push("of");
      i++;
      continue;
    }
    // A whole general phrase that spans a connector word ("injury to cells").
    const phrase = longest(GENERAL, lows, i, 4);
    if (phrase && phrase.len >= 2) {
      flushChunk(tokens.slice(i, i + phrase.len).map((t) => (t.kind === "word" ? t.raw : "")));
      i += phrase.len;
      continue;
    }
    const nextIsOf = lows[i + 1] === "of";
    const connector = NOUN_BEFORE_OF.has(token.low) && nextIsOf ? null : longest(CONNECTORS, lows, i, 4);
    if (connector && !(connector.len === 1 && token.low === "to" && CONNECTORS[lows[i + 1] ?? ""] && lows[i + 1] !== "the")) {
      out.push(connector.ar);
      hasArabic = true;
      previous = null;
      i += connector.len;
      continue;
    }
    if (connector && token.low === "to") {
      // "to" + verb: the infinitive marker, dropped.
      i++;
      continue;
    }
    // A noun phrase: consecutive words up to the next connector, "of", or punctuation.
    const raws: string[] = [];
    while (i < tokens.length) {
      const t = tokens[i]!;
      if (t.kind !== "word") break;
      if (t.low === "of") break;
      const isNoun = NOUN_BEFORE_OF.has(t.low) && lows[i + 1] === "of";
      if (raws.length > 0 && !isNoun && longest(CONNECTORS, lows, i, 4)) break;
      if (keepsLatin(t.raw) && raws.length === 0 && GENERAL[t.low] === undefined) {
        raws.push(t.raw);
        i++;
        continue;
      }
      raws.push(t.raw);
      i++;
    }
    flushChunk(raws);
  }
  const text = out.filter((s) => s.length > 0).join(" ").replace(/\s+([،؛:])/g, "$1").replace(/\s+/g, " ").trim();
  return { text, partial, hasArabic };
}

const coverage = (...parts: RenderedPhrase[]): Coverage => (parts.some((p) => p.partial) ? "partial" : "arabic");

/* ------------------------------------------------------------------ */
/* Templates                                                            */
/* ------------------------------------------------------------------ */

const QUALIFIERS: [RegExp, string][] = [
  [/^(?:the\s+)?(?:most common|commonest)\b/i, "الأكثر شيوعًا"],
  [/^(?:the\s+)?most important\b/i, "الأهم"],
  [/^(?:the\s+)?(?:main|major|leading|primary)\b/i, "الرئيسي"],
  [/^(?:the\s+)?(?:first|earliest)\b/i, "الأول"],
  [/^(?:the\s+)?(?:hallmark|characteristic|classic|typical)\b/i, "المميز"],
  [/^(?:the\s+)?only\b/i, "الوحيد"],
];
const SLOT_NOUNS: Record<string, string> = {
  cause: "السبب", causes: "الأسباب", manifestation: "المظهر", feature: "السمة", site: "الموقع", sign: "العلامة", symptom: "العَرَض",
  complication: "المضاعفة", type: "النوع", form: "الشكل", change: "التغير", event: "الحدث", step: "الخطوة", source: "المصدر",
  mechanism: "الآلية", pathway: "المسار", finding: "الموجودة", treatment: "العلاج", drug: "الدواء", cells: "الخلايا", cell: "الخلية",
};

/** "X is the most common cause of Y" → asks for X; null when the pattern is not one of these. */
export function renderSuperlative(subject: string, rest: string, mode: ArabicMode): RenderedArabic | null {
  const qualifier = QUALIFIERS.find(([re]) => re.test(rest));
  if (!qualifier) return null;
  const after = rest.replace(qualifier[0], "").trim();
  const match = /^(\w+)\s+(?:of|in|for)\s+(.+)$/i.exec(after);
  if (!match) return null;
  const noun = SLOT_NOUNS[match[1]!.toLowerCase()];
  if (!noun) return null;
  const object = renderPhrase(match[2]!, mode);
  const subj = renderPhrase(subject, mode);
  const head = `${noun} ${qualifier[1]}`;
  return {
    prompt: `ما هو ${head} لـ ${object.text}؟`,
    explanation: `${subj.text} هو ${head} لـ ${object.text}.`,
    coverage: coverage(object, subj),
  };
}

/** Participles that make "X is <participle> …" a statement, not a definition. */
const NOT_A_DEFINITION = /^(seen|found|located|observed|present|absent|common|rare|usually|often|mainly|also|not|more|less|most|caused|associated|replaced|released|stored|produced|increased|decreased|reduced)\b/i;

/** "X is Y" → "ما هو X؟"; "X is defined as / characterized by Y" → the matching Arabic question; null for a statement. */
export function renderDefinition(subject: string, predicate: string, mode: ArabicMode): RenderedArabic | null {
  const body = predicate.replace(/^(is|are)\s+/i, "");
  const subj = renderPhrase(subject, mode);
  const defined = /^defined\s+(as|by)\s+(.+)$/i.exec(body);
  if (defined) {
    const rest = renderPhrase(defined[2]!, mode);
    return defined[1]!.toLowerCase() === "as"
      ? { prompt: `ما تعريف ${subj.text}؟`, explanation: `يُعرَّف ${subj.text} بأنه ${rest.text}.`, coverage: coverage(subj, rest) }
      : { prompt: `بماذا يُعرَّف ${subj.text}؟`, explanation: `يُعرَّف ${subj.text} بـ ${rest.text}.`, coverage: coverage(subj, rest) };
  }
  const marked = /^(?:characteri[sz]ed|marked)\s+by\s+(.+)$/i.exec(body);
  if (marked) {
    const rest = renderPhrase(marked[1]!, mode);
    return { prompt: `بماذا يتميز ${subj.text}؟`, explanation: `يتميز ${subj.text} بـ ${rest.text}.`, coverage: coverage(subj, rest) };
  }
  if (NOT_A_DEFINITION.test(body)) return null;
  const pred = renderPhrase(body, mode);
  return { prompt: `ما هو ${subj.text}؟`, explanation: `${subj.text} هو ${pred.text}.`, coverage: coverage(subj, pred) };
}

const MECHANISM_FORMS: [RegExp, (c: string) => string, (c: string, e: string) => string][] = [
  [/^(?:(?:is|are)\s+)?(?:caused by|due to)$/i, (c) => `ما سبب ${c}؟`, (c, e) => `${c} يحدث بسبب ${e}.`],
  [/^activates?$/i, (c) => `ماذا يُنشِّط ${c}؟`, (c, e) => `${c} يُنشِّط ${e}.`],
  [/^inhibits?$/i, (c) => `ماذا يثبط ${c}؟`, (c, e) => `${c} يثبط ${e}.`],
  [/^followed by$/i, (c) => `ماذا يلي ${c}؟`, (c, e) => `${c} يليه ${e}.`],
  [/^mediat(?:es|ed by)$/i, (c) => `ما الذي يتوسط ${c}؟`, (c, e) => `${c} بوساطة ${e}.`],
  [/^switch(?:es)? to$/i, (c) => `إلى ماذا يتحول ${c}؟`, (c, e) => `${c} يتحول إلى ${e}.`],
  [/^allows?$/i, (c) => `بماذا يسمح ${c}؟`, (c, e) => `${c} يسمح بـ ${e}.`],
  [/^(?:results? in|resulting in)$/i, (c) => `ما الذي ينتج عن ${c}؟`, (c, e) => `ينتج عن ${c} ${e}.`],
  [/.*/, (c) => `إلامَ يؤدي ${c}؟`, (c, e) => `${c} يؤدي إلى ${e}.`],
];

/** "C causes / leads to / results in E", "E is caused by C", "A → B → C": an Arabic cause-and-effect card. */
export function renderMechanism(cause: string, connector: string, effect: string, mode: ArabicMode): RenderedArabic {
  const c = renderPhrase(cause.replace(/\s+(is|are)$/i, ""), mode);
  const e = renderPhrase(effect, mode);
  const form = MECHANISM_FORMS.find(([re]) => re.test(connector.trim()))!;
  return { prompt: form[1](c.text), explanation: form[2](c.text, e.text), coverage: coverage(c, e) };
}

/**
 * A bullet list: Arabic instruction; items are terms. In `ar-en` each item
 * stays as the lecture wrote it; in `ar` known terms are written in Arabic
 * (an item joining two terms, "Chemical agents and drugs", is rendered
 * term by term).
 */
export function renderList(heading: string, items: readonly string[], mode: ArabicMode): RenderedArabic {
  const h = renderPhrase(heading, mode);
  const rendered = items.map((item) => (mode === "ar" ? renderPhrase(item, mode).text : item) || item);
  return { prompt: `اذكر ${h.text}.`, explanation: `${rendered.join("، ")}.`, coverage: coverage(h) };
}

/** Any other sentence: an Arabic fill-in-the-blank; the sentence rendered by the same rules. */
export function renderCloze(sentence: string, subject: string, mode: ArabicMode): RenderedArabic {
  const idx = sentence.indexOf(subject);
  const blanked = idx >= 0 ? `${sentence.slice(0, idx)}___${sentence.slice(idx + subject.length)}` : `___ ${sentence}`;
  const full = renderPhrase(sentence, mode);
  const gap = renderPhrase(blanked, mode);
  return { prompt: `أكمل الفراغ: ${gap.text}`, explanation: `${full.text}.`, coverage: coverage(full, gap) };
}

/** An image card whose answer is the figure's caption (and the slide's heading, when it adds something). */
export function renderFigure(answer: string, heading: string | null, mode: ArabicMode): RenderedArabic {
  const a = renderPhrase(answer, mode);
  const h = heading ? renderPhrase(heading, mode) : null;
  return {
    prompt: "ماذا تُظهر هذه الصورة؟",
    explanation: h ? `${a.text} — ${h.text}.` : `${a.text}.`,
    coverage: h ? coverage(a, h) : coverage(a),
  };
}
