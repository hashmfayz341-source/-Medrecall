import { describe, expect, it } from "vitest";
import { applyOverrides, migrateOverrides, setConceptStatus } from "@/lib/domain/curriculum";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { createLearnerState, getNextStep } from "@/lib/engine/tutor";
import {
  LEGACY_CONCEPTS,
  LEGACY_LECTURE,
  LEGACY_PAGE_HEADING,
  LEGACY_SENTENCES,
  legacyV2Payload,
} from "./legacy-v2";
import type { Curriculum } from "@/lib/domain/types";

const T0 = new Date("2026-04-01T09:00:00.000Z");

/** Migrate a real v2 store, then approve exactly one concept. */
function migratedCurriculum(): Curriculum {
  const migrated = migrateOverrides(legacyV2Payload({ "legacy-c0": "ACTIVE" }));
  expect(migrated, "legacy payload must survive migration").not.toBeNull();

  // The legacy identity is untrusted, so migration returns it to DRAFT.
  expect(migrated!.statusById["legacy-c0"]).toBe("DRAFT");

  // The reviewer re-approves the one concept, and discards another.
  let overrides = setConceptStatus(migrated!, "legacy-c0", "ACTIVE");
  overrides = setConceptStatus(overrides, "legacy-c1", "DISCARDED");
  return applyOverrides(pathologyCurriculum, overrides);
}

describe("C1 path 1: legacy chunks stored before `generated` existed", () => {
  it("classifies an ingested legacy chunk as generated despite the missing flag", () => {
    const curriculum = migratedCurriculum();
    const lecture = curriculum.course.lectures.find((l) => l.id === LEGACY_LECTURE)!;
    const chunk = lecture.chunks[0]!;
    expect(
      chunk.generated,
      "a chunk that came from an ingested document is generated, whatever the stored flag says",
    ).toBe(true);
  });

  it("never serves the stored pre-review prose", () => {
    const curriculum = migratedCurriculum();
    const step = getNextStep(curriculum, createLearnerState(), LEGACY_LECTURE, T0);
    expect(step.kind).toBe("TEACH");
    if (step.kind !== "TEACH") return;

    const payload = JSON.stringify(step);
    expect(payload).toContain(LEGACY_SENTENCES.approved);
    expect(payload, "DISCARDED sentence leaked").not.toContain(LEGACY_SENTENCES.discarded);
    expect(payload, "DRAFT sentence leaked").not.toContain(LEGACY_SENTENCES.draftA);
    expect(payload, "DRAFT sentence leaked").not.toContain(LEGACY_SENTENCES.draftB);
  });

  it("rebuilds the rendered page from ACTIVE excerpts only", () => {
    const curriculum = migratedCurriculum();
    const step = getNextStep(curriculum, createLearnerState(), LEGACY_LECTURE, T0);
    if (step.kind !== "TEACH") throw new Error("expected TEACH");

    const text = step.pages.map((p) => p.text).join("\n");
    expect(text).toContain(LEGACY_SENTENCES.approved);
    for (const leaked of [
      LEGACY_SENTENCES.discarded,
      LEGACY_SENTENCES.draftA,
      LEGACY_SENTENCES.draftB,
    ]) {
      expect(text).not.toContain(leaked);
    }
  });

  it("teaches only the one approved concept", () => {
    const curriculum = migratedCurriculum();
    const step = getNextStep(curriculum, createLearnerState(), LEGACY_LECTURE, T0);
    if (step.kind !== "TEACH") throw new Error("expected TEACH");
    expect(step.concepts.map((c) => c.id)).toEqual(["legacy-c0"]);
  });
});

describe("C1 path 2: raw PDF headings are not approved teaching content", () => {
  it("does not put an unreviewed heading in the teaching title", () => {
    const curriculum = migratedCurriculum();
    const step = getNextStep(curriculum, createLearnerState(), LEGACY_LECTURE, T0);
    if (step.kind !== "TEACH") throw new Error("expected TEACH");

    // The heading names the concept the reviewer DISCARDED.
    expect(LEGACY_PAGE_HEADING).toContain("Karyorrhexis");
    expect(step.chunk.title, "raw heading became the teaching title").not.toContain(
      "Karyorrhexis",
    );
  });

  it("does not put an unreviewed heading anywhere in the TEACH payload", () => {
    const curriculum = migratedCurriculum();
    const step = getNextStep(curriculum, createLearnerState(), LEGACY_LECTURE, T0);
    if (step.kind !== "TEACH") throw new Error("expected TEACH");
    expect(JSON.stringify(step)).not.toContain(LEGACY_PAGE_HEADING);
  });

  it("the raw heading is still available for source review", () => {
    const curriculum = migratedCurriculum();
    const lecture = curriculum.course.lectures.find((l) => l.id === LEGACY_LECTURE)!;
    const stored = lecture.documents.find((d) => d.pages.length > 0)!;
    // Review UI reads the document, not the teaching payload.
    expect(stored.pages[0]!.title).toBe(LEGACY_PAGE_HEADING);
  });

  it("all four candidates exist, so the test is exercising a real mix", () => {
    const curriculum = migratedCurriculum();
    const statuses = LEGACY_CONCEPTS.map(
      (c) => curriculum.concepts.find((x) => x.id === c.id)!.status,
    );
    expect(statuses).toEqual(["ACTIVE", "DISCARDED", "DRAFT", "DRAFT"]);
  });
});
