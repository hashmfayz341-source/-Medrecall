/** Keep medically meaningful letters and canonicalise superscript/subscript notation. */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/[‘’“”]/g, "\'")
    .replace(/[^\p{L}\p{N}+/\s-]/gu, " ")
    .replace(/\s+/g, " ").trim();
}

/** A source excerpt as shown to the learner: table cells (stored tab-separated, verbatim) read "A | B | C". */
export function displayExcerpt(excerpt: string): string {
  return excerpt.replace(/\t/g, " | ");
}
