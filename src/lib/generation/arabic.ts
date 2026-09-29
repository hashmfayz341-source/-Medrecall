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
  "almost all": "معظم", all: "جميع", many: "العديد من", several: "عدة", some: "بعض", each: "كل", every: "كل",
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
  "such as": "مثل", "as well as": "وكذلك", into: "إلى", to: "إلى", from: "من", in: "في", after: "بعد", before: "قبل",
  during: "أثناء", between: "بين", for: "لـ", than: "من", as: "كـ", at: "عند", on: "على", is: "هو", are: "هي", not: "لا", no: "لا",
};

/*
 * Context-dependent words. A global dictionary would change medical meaning:
 * "by six weeks" is a deadline (بحلول), "cleaved by enzymes" an agent;
 * "within ten minutes" is a duration (خلال), "within hepatocytes" a place
 * (داخل); "most patients" is a quantity (معظم), "most specific" a
 * superlative. Each is translated only in the context it is recognised in;
 * otherwise the English stays and the card is reported as partial.
 */

/** Time after these prepositions: the Arabic temporal preposition. */
const TEMPORAL: Record<string, string> = {
  by: "بحلول", within: "خلال", in: "خلال", for: "لمدة", after: "بعد", before: "قبل", during: "خلال", at: "عند", on: "في",
  "up to": "حتى", over: "على مدى",
};
/*
 * "within" + a place is spatial (داخل) — but only when the place is
 * recognised: a cell, a tissue, an organ or another anatomical space.
 * "within normal limits", "within the reference range": neither a counted
 * duration nor a known place, so "within" stays English and the card is
 * partial. A wrong meaning is worse than an untranslated word.
 */
const PLACE_NOUNS = new Set([
  "cell", "cells", "cytoplasm", "cytosol", "nucleus", "nuclei", "nucleolus", "membrane", "membranes", "mitochondria",
  "mitochondrion", "lysosome", "lysosomes", "vesicle", "vesicles", "granule", "granules", "vacuole", "vacuoles", "organelle",
  "organelles", "canaliculus", "canaliculi", "tubule", "tubules", "duct", "ducts", "ductule", "ductules", "vessel", "vessels",
  "artery", "arteries", "arteriole", "arterioles", "vein", "veins", "venule", "venules", "capillary", "capillaries", "sinusoid",
  "sinusoids", "alveolus", "alveoli", "airway", "airways", "bronchus", "bronchi", "bronchiole", "bronchioles", "glomerulus",
  "glomeruli", "lumen", "lumina", "wall", "walls", "cavity", "cavities", "space", "spaces", "interstitium", "stroma",
  "parenchyma", "lobule", "lobules", "follicle", "follicles", "gland", "glands", "crypt", "crypts", "villus", "villi",
  "epithelium", "endothelium", "mucosa", "submucosa", "serosa", "matrix", "compartment", "compartments", "chamber", "chambers",
  "ventricle", "ventricles", "atrium", "atria", "heart", "liver", "kidney", "kidneys", "lung", "lungs", "brain", "skin", "bone",
  "bones", "marrow", "spleen", "node", "nodes", "plaque", "plaques", "thrombus", "thrombi", "tumour", "tumor", "tumours",
  "tumors", "lesion", "lesions", "organ", "organs", "tissue", "tissues", "abdomen", "thorax", "chest", "pelvis", "cortex",
  "medulla", "capsule", "sac", "cyst", "cysts", "abscess", "granuloma", "granulomas", "infarct", "focus", "foci", "zone",
  "zones", "layer", "layers", "sheath", "neuron", "neurons", "axon", "axons", "myocardium", "pericardium", "pleura",
  "peritoneum", "lymphatics",
]);
/** Cell types are places too: "within hepatocytes", "within macrophages". */
const CELL_TYPE = /(cytes?|blasts?|phages?)$/;

/** Whether the words after "within" (index `start`) name a recognised place: its head noun, before "of" / a connector / punctuation. */
function placeAhead(lows: readonly string[], start: number): boolean {
  let i = start;
  while (ARTICLES.has(lows[i] ?? "")) i++;
  let head: string | null = null;
  for (; i < lows.length; i++) {
    const w = lows[i]!;
    if (w === "\u0000" || w === "of" || (head !== null && longest(CONNECTORS, lows, i, 4))) break;
    head = w;
  }
  return head !== null && (PLACE_NOUNS.has(head) || CELL_TYPE.test(head));
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, "twenty-four": 24, "forty-eight": 48, "seventy-two": 72,
};
/** [singular, dual, plural (3–10), accusative singular (11+), feminine]. */
const TIME_UNITS: Record<string, [string, string, string, string, boolean]> = {
  second: ["ثانية", "ثانيتين", "ثوانٍ", "ثانية", true], minute: ["دقيقة", "دقيقتين", "دقائق", "دقيقة", true],
  hour: ["ساعة", "ساعتين", "ساعات", "ساعة", true], day: ["يوم", "يومين", "أيام", "يومًا", false],
  week: ["أسبوع", "أسبوعين", "أسابيع", "أسبوعًا", false], month: ["شهر", "شهرين", "أشهر", "شهرًا", false],
  year: ["سنة", "سنتين", "سنوات", "سنة", true],
};
const APPROXIMATELY: Record<string, string> = { about: "حوالي", approximately: "حوالي", around: "حوالي", roughly: "حوالي", nearly: "نحو" };

function numberOf(word: string | undefined): number | null {
  if (!word) return null;
  if (/^\d+(\.\d+)?$/.test(word)) return Number(word);
  return NUMBER_WORDS[word] ?? null;
}

function unitOf(word: string | undefined): [string, string, string, string, boolean] | null {
  if (!word) return null;
  return TIME_UNITS[word] ?? TIME_UNITS[word.replace(/s$/, "")] ?? null;
}

/** A counted duration: "one minute", "six to eight weeks", "about 24 hours", "the first three days". */
function timePhrase(lows: readonly string[], start: number, afterPreposition = false): { ar: string; len: number } | null {
  let i = start;
  let lead = "";
  if (lows[i] === "the" && (lows[i + 1] === "first" || lows[i + 1] === "last")) {
    lead = lows[i + 1] === "first" ? "أول " : "آخر ";
    i += 2;
  }
  const approx = APPROXIMATELY[lows[i] ?? ""];
  if (approx) i++;
  const prefix = `${lead}${approx ? `${approx} ` : ""}`;
  // Uncounted durations: "several minutes", "a few hours", and — after a
  // temporal preposition — "a minute", "an hour", "days".
  const pluralUnit = (w: string | undefined) => (w && /s$/.test(w) && !TIME_UNITS[w] ? unitOf(w) : null);
  if (lows[i] === "several" && pluralUnit(lows[i + 1])) return { ar: `${prefix}عدة ${pluralUnit(lows[i + 1])![2]}`, len: i + 2 - start };
  if (lows[i] === "a" && lows[i + 1] === "few" && pluralUnit(lows[i + 2])) {
    const unit = pluralUnit(lows[i + 2])!;
    return { ar: `${prefix}${unit[4] ? "بضع" : "بضعة"} ${unit[2]}`, len: i + 3 - start };
  }
  // ("a second" is left alone: it is as often an ordinal — "a second attack".)
  if (afterPreposition && (lows[i] === "a" || lows[i] === "an") && TIME_UNITS[lows[i + 1] ?? ""] && lows[i + 1] !== "second") {
    return { ar: `${prefix}${TIME_UNITS[lows[i + 1]!]![0]}`, len: i + 2 - start };
  }
  if (afterPreposition && !lead && !approx && pluralUnit(lows[i])) return { ar: pluralUnit(lows[i])![2], len: i + 1 - start };
  const from = numberOf(lows[i]);
  if (from === null) return null;
  i++;
  let to: number | null = null;
  if ((lows[i] === "to" || lows[i] === "or" || lows[i] === "-" || lows[i] === "–") && numberOf(lows[i + 1]) !== null) {
    to = numberOf(lows[i + 1]);
    i += 2;
  }
  const unit = unitOf(lows[i]);
  if (!unit) return null;
  i++;
  const [singular, dual, plural, accusative, feminine] = unit;
  const upper = to ?? from;
  const counted = (n: number) => (!Number.isInteger(n) || (n >= 3 && n <= 10) ? plural : accusative);
  let text: string;
  if (to !== null) text = `${from} إلى ${to} ${counted(upper)}`;
  else if (from === 1) text = lead ? singular : `${singular} ${feminine ? "واحدة" : "واحد"}`;
  else if (from === 2) text = dual;
  else text = `${from} ${counted(from)}`;
  return { ar: `${lead}${approx ? `${approx} ` : ""}${text}`, len: i - start };
}

/*
 * Ordinary English: function words, auxiliaries, pronouns, adverbs, number
 * and time words, and everyday adjectives. Left in English they are the
 * sentence's structure, not a medical term kept on purpose, so a card that
 * keeps any of them is partial. (Medical noun phrases the lexicon does not
 * know stay in English by design and do not make a card partial.)
 */
const ORDINARY_ENGLISH = new Set([
  "a", "an", "the", "this", "that", "these", "those", "it", "its", "they", "them", "their", "there", "here", "which", "who", "whom",
  "whose", "what", "when", "where", "why", "how", "whether", "if", "then", "than", "so", "such", "very", "more", "less", "least",
  "most", "much", "many", "few", "any", "both", "either", "neither", "other", "another", "same", "own", "just", "even", "still",
  "already", "yet", "again", "ever", "never", "always", "often", "sometimes", "about", "approximately", "around", "nearly",
  "almost", "roughly", "out", "over", "under", "above", "below", "across", "through", "throughout", "along",
  "among", "against", "toward", "towards", "upon", "onto", "off", "per", "via", "since", "until", "till", "unless", "while",
  "whereas", "although", "though", "however", "therefore", "thus", "hence", "instead", "rather", "quite", "too", "well", "of",
  "by", "be", "been", "being", "am", "was", "were", "has", "have", "had", "having", "do", "does", "did", "done", "can", "could",
  "may", "might", "must", "shall", "should", "will", "would", "one", "two", "three", "four", "five", "six", "seven", "eight",
  "nine", "ten", "eleven", "twelve", "twenty", "thirty", "hundred", "second", "seconds", "minute", "minutes", "hour", "hours",
  "day", "days", "week", "weeks", "month", "months", "year", "years", "typical", "important", "similar", "different", "usual",
  "likely", "unlikely", "possible", "known", "certain", "various", "our", "your", "we", "you", "alone", "faster", "slower", "greater", "larger", "smaller", "higher",
  "lower", "earlier", "later", "longer", "shorter", "better", "worse",
]);

/** A kept English noun phrase longer than this is a clause, not a term. */
const MAX_TERM_WORDS = 4;

/*
 * Common English verbs of medical and biological prose (general English,
 * not any lecture's wording). Their finite forms — "engulf", "secretes" —
 * are verbs when an object follows them inside a kept English phrase
 * ("engulf debris", "secrete cytokines"): an English clause, so partial.
 * Words used just as often as the first word of a medical term — nouns
 * ("signal transduction", "transport protein", "lead poisoning", "repair
 * enzymes") and adjectives ("diffuse fibrosis", "clear cell carcinoma",
 * "mature teratoma", "lower lobe", "cross section") — are left out; the
 * sentence-level rules still catch them as verbs (after a relative
 * pronoun, or as the sentence's own verb).
 */
const ENGLISH_VERBS = [
  "absorb", "accumulate", "activate", "adhere", "affect", "aggregate", "alter", "appear", "arise", "attach", "attract", "bind",
  "calcify", "carry", "cause", "circulate", "cleave", "compress", "consist", "contain", "contribute",
  "convert", "correlate", "decrease", "degrade", "deliver", "depend", "derive", "destroy", "detect", "develop", "differ",
  "differentiate", "digest", "dilate", "disappear", "disrupt", "divide", "elevate", "eliminate", "encode", "engulf",
  "enhance", "enter", "excrete", "expand", "extend", "follow", "form", "generate", "grow", "heal", "hydrolyze",
  "impair", "improve", "include", "increase", "indicate", "induce", "infiltrate", "inhibit", "initiate", "injure", "interact",
  "invade", "involve", "kill", "lose", "lyse", "maintain", "make", "mediate", "metabolize", "migrate",
  "modulate", "obstruct", "occlude", "occur", "originate", "penetrate", "permit", "persist", "phagocytose",
  "precede", "predispose", "prevent", "produce", "proliferate", "promote", "protect", "provide", "raise", "reach",
  "react", "recruit", "reduce", "reflect", "regenerate", "regulate", "remain", "remove", "replace", "represent", "require",
  "resemble", "resist", "resolve", "respond", "restore", "reveal", "rise", "secrete", "show", "shrink", "stimulate",
  "suppress", "surround", "survive", "sustain", "swell", "synthesize", "thicken", "undergo", "vary", "weaken", "worsen",
];
const FINITE_VERBS = new Set(
  ENGLISH_VERBS.flatMap((v) => [v, /(s|sh|ch|x|z)$/.test(v) ? `${v}es` : /[^aeiou]y$/.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`]),
);
/** Relative pronouns: what follows them is a clause (its verb first), never a term. */
const RELATIVE = new Set(["which", "that", "who", "whom", "whose"]);

/**
 * Whether a (lower-case) English word is sentence structure rather than
 * part of a name: a connector or function word, ordinary English, or a form
 * of a common verb ("causes", "producing", "engulfed"). Used to find where
 * the modifiers of a named entity end ("causes | failure").
 */
export function isStructureWord(word: string): boolean {
  if (CONNECTORS[word] !== undefined || ORDINARY_ENGLISH.has(word) || FINITE_VERBS.has(word)) return true;
  const lemma = word.replace(/(?:ed|ing)$/, "");
  return lemma !== word && (FINITE_VERBS.has(lemma) || FINITE_VERBS.has(`${lemma}e`) || FINITE_VERBS.has(lemma.replace(/(.)\1$/, "$1")));
}

/** Whether English words kept as written read as sentence structure rather than a medical term. */
function ordinaryEnglish(words: readonly string[]): boolean {
  if (words.length > MAX_TERM_WORDS) return true;
  return words.some((word, i) => {
    // A capital letter or numeral is a label, not an article or a pronoun:
    // "hepatitis A", "type I", "vitamin D", "stage IV".
    if (/^[A-Z]$/.test(word) || /^[IVX]+$/.test(word)) return false;
    const w = word.toLowerCase();
    if (ORDINARY_ENGLISH.has(w) || (/ly$/.test(w) && w.length > 4)) return true;
    // "engulf debris": a finite verb with its object after it.
    if (FINITE_VERBS.has(w) && i < words.length - 1) return true;
    // "tissue replaces necrotic": a verb between two words of the phrase.
    return i > 0 && i < words.length - 1 && /[^s]s$/.test(w) && !/(is|us|ss|ys)$/.test(w) && !keepsLatin(word);
  });
}

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
    // "most" is a quantity only before a noun the lexicon knows ("most patients");
    // before anything else ("most specific marker") it may be a superlative: kept.
    if (lows[start] === "most" && start + 1 < lows.length && isKnownNoun(lows.slice(start + 1).join(" "))) {
      prefix.push("معظم");
      start += 1;
      continue;
    }
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

  // Kept as written: a medical term, or English sentence structure (partial).
  const english = coreRaw.join(" ");
  return { text: `${pre}${english}`, arabic: prefix.length > 0, bracketed: false, clause: !coreRaw.every(keepsLatin) && ordinaryEnglish(coreRaw) };
}

/** A noun (or noun phrase) the lexicon knows, in either mode. */
function isKnownNoun(key: string): boolean {
  return GENERAL[key] !== undefined || MEDICAL[key] !== undefined;
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

  // After a relative pronoun ("that engulf debris") comes a clause: English
  // kept there is sentence structure, never a term.
  let clauseSlot = false;
  const flushChunk = (raws: string[]) => {
    const chunk = renderChunk(raws, mode);
    if (!chunk) return;
    out.push(chunk.text);
    partial ||= chunk.clause || (clauseSlot && !chunk.arabic);
    hasArabic ||= chunk.arabic;
    previous = chunk;
    clauseSlot = false;
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
      // bracketed term "لـ" keeps it readable; between English words it
      // stays — English structure, so the card is partial.
      const prev = previous as ChunkResult | null;
      if (prev?.arabic) out.push(prev.bracketed ? "لـ" : "");
      else {
        out.push("of");
        partial = true;
      }
      i++;
      continue;
    }
    // A counted duration, with its temporal preposition when it has one.
    const preposition = longest(TEMPORAL, lows, i, 2);
    const time = timePhrase(lows, i + (preposition?.len ?? 0), preposition !== null);
    if (time) {
      out.push(preposition ? `${preposition.ar} ${time.ar}` : time.ar);
      hasArabic = true;
      previous = null;
      i += (preposition?.len ?? 0) + time.len;
      continue;
    }
    if (token.low === "within") {
      // Not a duration: داخل only before a recognised place; otherwise English, partial.
      if (placeAhead(lows, i + 1)) {
        out.push("داخل");
        hasArabic = true;
      } else {
        out.push(token.raw);
        partial = true;
      }
      previous = null;
      i++;
      continue;
    }
    if (token.low === "by" && !longest(CONNECTORS, lows, i, 4)) {
      // An agent or a means with no recognised verb: left in English.
      out.push(token.raw);
      partial = true;
      previous = null;
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
      clauseSlot = connector.len === 1 && RELATIVE.has(token.low);
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
      if (raws.length > 0 && !isNoun && (longest(CONNECTORS, lows, i, 4) || t.low === "within" || t.low === "by" || timeAhead(lows, i))) break;
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

/** Whether a counted duration starts here (with or without its preposition). */
function timeAhead(lows: readonly string[], i: number): boolean {
  const preposition = longest(TEMPORAL, lows, i, 2);
  return timePhrase(lows, i + (preposition?.len ?? 0), preposition !== null) !== null;
}

const coverage = (...parts: RenderedPhrase[]): Coverage => (parts.some((p) => p.partial) ? "partial" : "arabic");

/** A rendered card side with no Arabic word at all is not an Arabic sentence. */
const ARABIC_LETTER = /[\u0600-\u06FF]/;
function coverageOf(card: { prompt: string; explanation: string }, ...parts: RenderedPhrase[]): Coverage {
  if (!ARABIC_LETTER.test(card.prompt) || !ARABIC_LETTER.test(card.explanation)) return "partial";
  return coverage(...parts);
}

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
  return card(`ما هو ${head} لـ ${object.text}؟`, `${subj.text} هو ${head} لـ ${object.text}.`, object, subj);
}

/** A card with its coverage: partial when any part kept English structure, or a side has no Arabic at all. */
function card(prompt: string, explanation: string, ...parts: RenderedPhrase[]): RenderedArabic {
  return { prompt, explanation, coverage: coverageOf({ prompt, explanation }, ...parts) };
}

/**
 * A card whose answer is terms, not a sentence (a list, a figure's caption):
 * medical terms kept in English are the design, so only English sentence
 * structure in a term, or an English question, makes it partial.
 */
function termsCard(prompt: string, explanation: string, ...parts: RenderedPhrase[]): RenderedArabic {
  return { prompt, explanation, coverage: ARABIC_LETTER.test(prompt) ? coverage(...parts) : "partial" };
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
      ? card(`ما تعريف ${subj.text}؟`, `يُعرَّف ${subj.text} بأنه ${rest.text}.`, subj, rest)
      : card(`بماذا يُعرَّف ${subj.text}؟`, `يُعرَّف ${subj.text} بـ ${rest.text}.`, subj, rest);
  }
  const marked = /^(?:characteri[sz]ed|marked)\s+by\s+(.+)$/i.exec(body);
  if (marked) {
    const rest = renderPhrase(marked[1]!, mode);
    return card(`بماذا يتميز ${subj.text}؟`, `يتميز ${subj.text} بـ ${rest.text}.`, subj, rest);
  }
  if (NOT_A_DEFINITION.test(body)) return null;
  const pred = renderPhrase(body, mode);
  return card(`ما هو ${subj.text}؟`, `${subj.text} هو ${pred.text}.`, subj, pred);
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
  return card(form[1](c.text), form[2](c.text, e.text), c, e);
}

/**
 * A bullet list: Arabic instruction; items are terms. In `ar-en` each item
 * stays as the lecture wrote it; in `ar` known terms are written in Arabic
 * (an item joining two terms, "Chemical agents and drugs", is rendered
 * term by term).
 */
export function renderList(heading: string, items: readonly string[], mode: ArabicMode): RenderedArabic {
  const h = renderPhrase(heading, mode);
  const phrases = items.map((item) => renderPhrase(item, mode));
  const rendered = items.map((item, i) => (mode === "ar" ? phrases[i]!.text : item) || item);
  // The answer is a list of terms: Arabic structure is the instruction, so
  // only English sentence structure inside the heading or an item is partial.
  return termsCard(`اذكر ${h.text}.`, `${rendered.join("، ")}.`, h, ...phrases);
}

/** Any other sentence: an Arabic fill-in-the-blank; the sentence rendered by the same rules. */
export function renderCloze(sentence: string, subject: string, mode: ArabicMode): RenderedArabic {
  const idx = sentence.indexOf(subject);
  const blanked = idx >= 0 ? `${sentence.slice(0, idx)}___${sentence.slice(idx + subject.length)}` : `___ ${sentence}`;
  const full = renderPhrase(sentence, mode);
  const gap = renderPhrase(blanked, mode);
  const out = card(`أكمل الفراغ: ${gap.text}`, `${full.text}.`, full, gap);
  // The sentence's own verb (the word after the subject) left in English:
  // "Granulation tissue replaces …" is an English clause, not a term.
  const predicate = idx >= 0 ? sentence.slice(idx + subject.length).trim().replace(/^\([^)]*\)\s*/, "").toLowerCase().split(/\s+/).filter(Boolean) : [];
  const verbTranslated = predicate.length === 0 || longest(CONNECTORS, predicate, 0, 4) !== null || timeAhead(predicate, 0);
  return verbTranslated ? out : { ...out, coverage: "partial" };
}

/** An image card whose answer is the figure's caption (and the slide's heading, when it adds something). */
export function renderFigure(answer: string, heading: string | null, mode: ArabicMode): RenderedArabic {
  const a = renderPhrase(answer, mode);
  const h = heading ? renderPhrase(heading, mode) : null;
  const explanation = h ? `${a.text} — ${h.text}.` : `${a.text}.`;
  return h ? termsCard("ماذا تُظهر هذه الصورة؟", explanation, a, h) : termsCard("ماذا تُظهر هذه الصورة؟", explanation, a);
}
