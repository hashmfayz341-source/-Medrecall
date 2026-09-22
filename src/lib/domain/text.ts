/** Keep medically meaningful letters and canonicalise superscript/subscript notation. */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase()
    .replace(/[‘’“”]/g, "\'")
    .replace(/[^\p{L}\p{N}+/\s-]/gu, " ")
    .replace(/\s+/g, " ").trim();
}
