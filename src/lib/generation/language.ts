import type { CardLanguage } from "@/lib/domain/types";

/**
 * Question wording per card language.
 *
 * The deterministic generator never translates SOURCE content — the answer
 * side of every card is the lecture's own verbatim text — so what a
 * language chooses is the question scaffolding: Arabic prompts around the
 * lecture's own terms. Medical terminology therefore stays exactly as the
 * lecture wrote it in every mode, which is what `ar-en` asks for; `ar` uses
 * the same Arabic scaffolding and is the mode a translating provider can
 * later honour in full (see `CardGenerationProvider`).
 */

export interface LanguageOption {
  id: CardLanguage;
  /** Label in the UI's language. */
  label: string;
  /** The same label in the target language, for the picker. */
  native: string;
  /** Text direction of the generated question. */
  dir: "ltr" | "rtl";
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { id: "en", label: "English", native: "English", dir: "ltr" },
  { id: "ar", label: "Arabic", native: "العربية", dir: "rtl" },
  { id: "ar-en", label: "Arabic + English medical terms", native: "عربي + مصطلحات طبية بالإنجليزية", dir: "rtl" },
];

export function languageOption(language: CardLanguage): LanguageOption {
  return LANGUAGE_OPTIONS.find((o) => o.id === language) ?? LANGUAGE_OPTIONS[0]!;
}

export interface PromptTemplates {
  /** "What is X?" */
  definition: (term: string) => string;
  /** "What is the most common cause of Y?" — asks for the subject of a superlative statement. */
  superlative: (rest: string) => string;
  /** The cause is given, the consequence is blanked. */
  mechanism: (blanked: string) => string;
  /** The key term is blanked. */
  cloze: (blanked: string) => string;
  /** "List: the heading" */
  list: (heading: string) => string;
  /** A visual card: the picture is the question, its caption the answer. */
  figure: () => string;
  /** A fact without a definition or mechanism shape. */
  statement: (term: string) => string;
  /** Label shown before an answer that lists items. */
  answerListLabel: string;
}

const EN: PromptTemplates = {
  definition: (term) => `What is ${term}?`,
  superlative: (rest) => `What is ${rest}?`,
  mechanism: (blanked) => `Complete the mechanism: ${blanked}`,
  cloze: (blanked) => `Fill in the blank: ${blanked}`,
  list: (heading) => `List: ${heading}`,
  figure: () => "What is shown in this image?",
  statement: (term) => `What does the lecture state about ${term}?`,
  answerListLabel: "",
};

/**
 * Fallback Arabic wording only. Cards in the Arabic modes are rendered from
 * the fact's structure by `./arabic.ts`; these are not used to wrap English
 * sentences.
 */
const AR: PromptTemplates = {
  definition: (term) => `ما هو ${term}؟`,
  superlative: (rest) => `ما هو ${rest.replace(/^the\s+/i, "")}؟`,
  mechanism: (blanked) => `أكمل الآلية: ${blanked}`,
  cloze: (blanked) => `أكمل الفراغ: ${blanked}`,
  list: (heading) => `عدّد: ${heading}`,
  figure: () => "ماذا تُظهر هذه الصورة؟",
  statement: (term) => `ماذا تذكر المحاضرة عن ${term}؟`,
  answerListLabel: "",
};

export function templatesFor(language: CardLanguage): PromptTemplates {
  return language === "en" ? EN : AR;
}

/** True when the text contains Arabic script (so it is laid out right-to-left). */
export function hasArabic(text: string): boolean {
  return /[؀-ۿݐ-ݿ]/.test(text);
}
