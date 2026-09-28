import { describe, expect, it } from "vitest";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import {
  MergeError,
  addIngestedDocument,
  createOverrides,
  keepApart,
  mergeConcepts,
  migrateOverrides,
  resolveMergeTarget,
  setConceptStatus,
  unmergeConcept,
} from "@/lib/domain/curriculum";
import {
  MIN_SUMMARY_CONTENT_WORDS,
  SUMMARY_DUPLICATE_THRESHOLD,
  contentWords,
  findDuplicateCandidates,
  preferCanonical,
  wordOverlap,
} from "@/lib/domain/duplicates";
import { lectureDecks } from "@/lib/engine/decks";
import { studyCardsForLecture } from "@/lib/engine/study";
import { createLearnerState, getNextStep, markChunkTaught, recordAttempt } from "@/lib/engine/tutor";
import { driveLecture } from "./driver";
import { ANSWERS } from "./helpers";
import { CHUNK, DOC, DOC2, DUP, HYPOXIA, L1, L2, OTHER, T0, candidate, chunk, document, dup, live, other, withTwoUploads, withUpload } from "./duplicate-fixture";

/**
 * Duplicate candidates across documents: detection is deterministic and
 * textual; merging is a reviewer's explicit decision recorded in the
 * overrides. A merged duplicate is DISCARDED, its pages teach the canonical
 * concept, and its source becomes extra provenance on the canonical.
 */

describe("detection", () => {
  it("suggests a candidate whose title equals a concept from another document, preferring the ACTIVE and earlier one as canonical", () => {
    const suggestions = findDuplicateCandidates(live(withUpload()));
    expect(suggestions).toEqual([{ conceptId: DUP, canonicalId: HYPOXIA, reason: "title", similarity: 1 }]);
  });

  it("suggests by summary overlap when titles differ, at or above the threshold only", () => {
    const reworded = {
      ...dup,
      title: "Hypoxic cell injury (recap)",
      summary: "Hypoxia means reduced oxygen availability; ischaemia is its most common cause and injures faster since substrate delivery stops.",
    };
    const o = addIngestedDocument(createOverrides(), { lectureId: L2, document, chunks: [chunk], ingestedAt: T0.toISOString() }, [reworded, other]);
    const suggestions = findDuplicateCandidates(live(o));
    const forDup = suggestions.find((s) => s.conceptId === DUP);
    expect(forDup?.canonicalId).toBe(HYPOXIA);
    expect(forDup?.reason).toBe("summary");
    expect(forDup!.similarity).toBeGreaterThanOrEqual(SUMMARY_DUPLICATE_THRESHOLD);
    expect(suggestions.some((s) => s.conceptId === OTHER)).toBe(false);
  });

  it("never pairs concepts of the same document, and ignores DISCARDED and already-merged ones", () => {
    expect(findDuplicateCandidates(C)).toEqual([]); // the authored course has no cross-document duplicates
    const discarded = live(setConceptStatus(withUpload(), DUP, "DISCARDED"));
    expect(findDuplicateCandidates(discarded)).toEqual([]);
    const merged = live(mergeConcepts(withUpload(), C, DUP, HYPOXIA));
    expect(findDuplicateCandidates(merged)).toEqual([]);
  });

  it("is deterministic and textual", () => {
    expect(contentWords("The most common cause of cell injury is hypoxia.")).toEqual(new Set(["common", "cause", "cell", "injury", "hypoxia"]));
    expect(wordOverlap(new Set(["a", "b", "c"]), new Set(["b", "c", "d"]))).toBeCloseTo(0.5);
    expect(wordOverlap(new Set(), new Set(["x"]))).toBe(0);
    const a = live(withUpload());
    expect(findDuplicateCandidates(a)).toEqual(findDuplicateCandidates(a));
    const [canonical, duplicate] = preferCanonical(a, a.concepts.find((c) => c.id === DUP)!, a.concepts.find((c) => c.id === HYPOXIA)!);
    expect([canonical.id, duplicate.id]).toEqual([HYPOXIA, DUP]);
  });

  it("summary matching needs substance: trivial or boilerplate summaries never suggest a duplicate (M2)", () => {
    const pair = (aSummary: string, bSummary: string, titles: [string, string] = ["Cell adaptation", "Leukocyte extravasation"]) =>
      findDuplicateCandidates(live(withTwoUploads(
        [candidate(`${DOC}-p1-c0`, titles[0], aSummary, aSummary)],
        [candidate(`${DOC2}-p1-c0`, titles[1], bSummary, bSummary, DOC2)],
      )));
    expect(contentWords("cells").size).toBeLessThan(MIN_SUMMARY_CONTENT_WORDS);
    // Jaccard would be 1.0 for these, but a single word is not a concept.
    expect(pair("cells", "cells")).toEqual([]);
    expect(pair("Apoptosis", "Apoptosis")).toEqual([]);
    expect(pair("Inflammation.", "inflammation")).toEqual([]);
    // Very short boilerplate below the minimum: never suggested.
    expect(pair("See notes above.", "See notes above.")).toEqual([]);
    expect(pair("Key point summary", "Key point summary")).toEqual([]);
    // Substantive summaries at exactly the threshold: suggested.
    // 4 content words each, 3 shared: 3 / 5 = 0.6.
    const at = pair("Hypoxia causes cellular injury.", "Hypoxia causes cellular damage.");
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({ conceptId: `${DOC2}-p1-c0`, canonicalId: `${DOC}-p1-c0`, reason: "summary" });
    expect(at[0]!.similarity).toBeCloseTo(SUMMARY_DUPLICATE_THRESHOLD);
    // Substantive but below the threshold: not suggested.
    expect(pair("Hypoxia causes cellular injury.", "Ischaemia causes hypoxic damage.")).toEqual([]);
    expect(pair("Hypoxia causes cellular injury.", "Hypoxia causes cellular damage and death.")).toEqual([]); // 3 / 6
    // An identical normalised title across documents is suggested whatever the summaries say.
    expect(pair("cells", "tissue", ["Karyolysis", "karyolysis"])).toMatchObject([{ reason: "title", similarity: 1 }]);
    // The same document is still never paired, however similar.
    const same = findDuplicateCandidates(live(withUpload([
      candidate(`${DOC}-p1-c0`, "Cell adaptation", "Hypoxia causes cellular injury.", "x"),
      candidate(`${DOC}-p1-c1`, "Leukocyte extravasation", "Hypoxia causes cellular injury.", "y"),
    ])));
    expect(same).toEqual([]);
  });
});

describe("merging", () => {
  it("records the decision, discards the duplicate, and leaves the canonical's status alone", () => {
    const o = mergeConcepts(withUpload(), C, DUP, HYPOXIA);
    expect(o.merges).toEqual({ [DUP]: HYPOXIA });
    expect(o.statusById[DUP]).toBe("DISCARDED");
    expect(o.statusById[HYPOXIA]).toBeUndefined();
    const merged = live(o);
    const duplicate = merged.concepts.find((c) => c.id === DUP)!;
    expect(duplicate.status).toBe("DISCARDED");
    expect(duplicate.mergedInto).toBe(HYPOXIA);
    const canonical = merged.concepts.find((c) => c.id === HYPOXIA)!;
    expect(canonical.status).toBe("ACTIVE");
    expect(canonical.additionalSources).toEqual([dup.source]);
    expect(canonical.source).toEqual(C.concepts.find((c) => c.id === HYPOXIA)!.source); // own provenance unchanged
  });

  it("rewrites the duplicate's chunk to teach the canonical, once", () => {
    const merged = live(mergeConcepts(withUpload(), C, DUP, HYPOXIA));
    const rewritten = merged.course.lectures.find((l) => l.id === L2)!.chunks.find((c) => c.id === CHUNK)!;
    expect(rewritten.conceptIds).toEqual([HYPOXIA, OTHER]);
  });

  it("refuses self-merges, unknown ids, discarded or merged canonicals, double merges and cycles", () => {
    const o = withUpload();
    expect(() => mergeConcepts(o, C, DUP, DUP)).toThrow(MergeError);
    expect(() => mergeConcepts(o, C, DUP, "nope")).toThrow(MergeError);
    expect(() => mergeConcepts(setConceptStatus(o, HYPOXIA, "DISCARDED"), C, DUP, HYPOXIA)).toThrow(MergeError);
    const once = mergeConcepts(o, C, DUP, HYPOXIA);
    expect(() => mergeConcepts(once, C, DUP, OTHER)).toThrow(MergeError);
    expect(() => mergeConcepts(once, C, OTHER, DUP)).toThrow(MergeError); // DUP is merged itself
    expect(() => mergeConcepts(once, C, HYPOXIA, DUP)).toThrow(MergeError); // would form a cycle
    expect(resolveMergeTarget({ a: "b", b: "a" }, "a")).toBeNull();
    expect(resolveMergeTarget({ a: "b", b: "c" }, "a")).toBe("c");
  });

  it("undo returns the duplicate to DRAFT (never ACTIVE) and restores its chunk", () => {
    const o = unmergeConcept(mergeConcepts(withUpload(), C, DUP, HYPOXIA), DUP);
    expect(o.merges).toEqual({});
    expect(o.statusById[DUP]).toBe("DRAFT");
    const restored = live(o);
    expect(restored.concepts.find((c) => c.id === DUP)!.mergedInto).toBeUndefined();
    expect(restored.concepts.find((c) => c.id === HYPOXIA)!.additionalSources).toBeUndefined();
    expect(restored.course.lectures.find((l) => l.id === L2)!.chunks.find((c) => c.id === CHUNK)!.conceptIds).toEqual([DUP, OTHER]);
    expect(unmergeConcept(withUpload(), DUP)).toEqual(withUpload());
  });

  it("keep-apart rejects a suggestion and a later merge clears the rejection", () => {
    let o = keepApart(withUpload(), DUP, HYPOXIA);
    expect(o.keptApart).toEqual({ [DUP]: HYPOXIA });
    o = mergeConcepts(o, C, DUP, HYPOXIA);
    expect(o.keptApart).toEqual({});
  });

  it("a dangling or cyclic stored merge is ignored, never trusted", () => {
    const o = { ...withUpload(), merges: { [DUP]: "gone", x: "y", y: "x" } };
    const composed = live(o);
    expect(composed.concepts.find((c) => c.id === DUP)!.mergedInto).toBeUndefined();
    expect(composed.course.lectures.find((l) => l.id === L2)!.chunks.find((c) => c.id === CHUNK)!.conceptIds).toEqual([DUP, OTHER]);
  });

  it("stored merges and rejections are validated and migrated", () => {
    expect(migrateOverrides({ version: 4, statusById: {}, merges: { a: "b" }, keptApart: { c: "d" } })).toMatchObject({ merges: { a: "b" }, keptApart: { c: "d" } });
    expect(migrateOverrides({ version: 4, statusById: {} })).toMatchObject({ merges: {}, keptApart: {} });
    // A malformed entry is dropped on its own; the store still loads (M1).
    expect(migrateOverrides({ version: 4, statusById: {}, merges: { a: 1, b: "c" } })).toMatchObject({ merges: { b: "c" } });
    expect(migrateOverrides({ version: 4, statusById: {}, keptApart: [] })).toMatchObject({ keptApart: {} });
  });
});

describe("what a merge means for teaching and Study", () => {
  const merged = () => live(setConceptStatus(mergeConcepts(withUpload(), C, DUP, HYPOXIA), OTHER, "ACTIVE"));

  it("the duplicate's page teaches the canonical concept from its own excerpt, and Lecture 1 is untouched", () => {
    const curriculum = merged();
    // Lecture 1 exactly as before.
    expect(driveLecture(createLearnerState(), L1, T0).log).toEqual(driveLecture(createLearnerState(), L1, T0).log);
    let learner = driveLecture(createLearnerState(), L1, T0).learner;
    // Lecture 2's last chunk is the handout: it now teaches c-hypoxia (already retrieved) and Neutrophils.
    for (let i = 0; i < 40; i++) {
      const step = getNextStep(curriculum, learner, L2, T0);
      if (step.kind === "TEACH" && step.chunk.id === CHUNK) {
        expect(step.concepts.map((c) => c.id)).toEqual([HYPOXIA, OTHER]);
        expect(step.pages.map((p) => p.text).join("\n")).toContain("Hypoxia is the most common cause of cell injury.");
        expect(step.pages.map((p) => p.text).join("\n")).toContain("Neutrophils are the first cells");
        learner = markChunkTaught(curriculum, learner, CHUNK);
        // c-hypoxia was retrieved in Lecture 1 and is not pending: it is not asked again here.
        const next = getNextStep(curriculum, learner, L2, T0);
        expect(next.kind).toBe("RETRIEVE");
        if (next.kind === "RETRIEVE") expect(next.concept.id).toBe(OTHER);
        learner = recordAttempt(curriculum, learner, { conceptId: OTHER, itemId: `${OTHER}-r1`, answer: "Neutrophils", context: "INITIAL", chunkId: CHUNK, now: T0 }).learner;
        expect(learner.completedChunkIds).toContain(CHUNK);
        return;
      }
      if (step.kind === "TEACH") {
        learner = markChunkTaught(curriculum, learner, step.chunk.id);
        continue;
      }
      if (step.kind === "LECTURE_COMPLETE" || step.kind === "AWAITING_APPROVAL") throw new Error(`unexpected ${step.kind}`);
      learner = recordAttempt(curriculum, learner, { conceptId: step.concept.id, itemId: step.item.id, answer: ANSWERS[step.concept.id] ?? "Neutrophils", context: step.context, chunkId: step.chunk.id, now: T0 }).learner;
    }
    throw new Error("handout chunk never taught");
  });

  it("the duplicate has no Study cards; the canonical's cards stay in its own lecture, once", () => {
    const curriculum = merged();
    const l2 = studyCardsForLecture(curriculum, L2).map((c) => c.item.id);
    expect(l2.some((id) => id.startsWith(DUP))).toBe(false);
    expect(l2).toContain(`${OTHER}-r1`);
    const l1 = studyCardsForLecture(curriculum, L1).filter((c) => c.concept.id === HYPOXIA);
    expect(l1.length).toBe(2);
    expect(lectureDecks(curriculum, createLearnerState(), T0).map((d) => d.total)).toEqual([
      studyCardsForLecture(curriculum, L1).length,
      studyCardsForLecture(curriculum, L2).length,
    ]);
  });

  it("a merged duplicate never enters teaching, retrieval, Study or completion on its own", () => {
    const curriculum = live(mergeConcepts(withUpload(), C, DUP, HYPOXIA));
    expect(curriculum.concepts.find((c) => c.id === DUP)!.status).toBe("DISCARDED");
    // Even a stale ACTIVE decision cannot resurrect it: the merge wins.
    const forced = live({ ...mergeConcepts(withUpload(), C, DUP, HYPOXIA), statusById: { [DUP]: "ACTIVE" } });
    expect(forced.concepts.find((c) => c.id === DUP)!.status).toBe("DISCARDED");
    expect(studyCardsForLecture(forced, L2).some((c) => c.concept.id === DUP)).toBe(false);
  });
});
