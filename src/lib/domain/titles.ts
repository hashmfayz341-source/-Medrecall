/**
 * Lecture and document titles from file names. Browser-safe (no Node
 * imports): the upload screen names the lecture before anything is sent.
 */

/** Turn a file name into a readable title: "Cell Injury.pdf" → "Cell Injury". */
export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!base) return "Untitled document";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** A lecture id from its title, made unique by the moment it was created. */
export function lectureIdFor(title: string, at: number = Date.now()): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "lecture";
  return `lecture-${slug}-${at.toString(36)}`;
}
