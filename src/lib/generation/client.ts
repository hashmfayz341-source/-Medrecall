import type { CardLanguage, Concept, Curriculum } from "@/lib/domain/types";
import type { PageVisuals } from "@/lib/visuals/analyze";
import type { CardCount, ExistingCard, GeneratedCards } from "./generate";

/**
 * Browser side of card generation: what the upload screen and "Generate
 * more" send to POST /api/generate. Keeps the request shape in one place.
 */

export const COUNT_PRESETS = [20, 40, 60, 100] as const;

export interface GenerationRequest {
  courseId: string;
  lectureId: string;
  document: { id: string; title: string; pages: { number: number; title: string; text: string }[] };
  visuals: readonly PageVisuals[];
  language: CardLanguage;
  count: CardCount;
  existing: readonly ExistingCard[];
}

/** The lecture's cards as the generator sees them, every status included, so nothing returns twice. */
export function existingCardsOf(curriculum: Curriculum, lectureId: string): ExistingCard[] {
  return curriculum.concepts
    .filter((c) => c.lectureId === lectureId)
    .map((c) => ({ id: c.id, title: c.title, summary: c.summary }));
}

export async function requestCards(request: GenerationRequest): Promise<GeneratedCards> {
  const response = await fetch("/api/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String((payload as { error: unknown }).error)
        : "Card generation failed.";
    throw new Error(message);
  }
  const result = payload as GeneratedCards;
  // Whatever came back, it enters as DRAFT.
  return { ...result, concepts: result.concepts.map((c: Concept) => ({ ...c, status: "DRAFT" as const })) };
}

/** Parse the count control: a preset, a custom whole number, or AUTO. */
export function parseCount(choice: string, custom: string): CardCount | null {
  if (choice === "auto") return "auto";
  if (choice === "custom") {
    const n = Number(custom);
    return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null;
  }
  const n = Number(choice);
  return Number.isInteger(n) && n >= 1 ? n : null;
}
