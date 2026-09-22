import { describe, expect, it } from "vitest";
import {
  applyOverrides,
  migrateOverrides,
  setConceptStatus,
  CURRICULUM_OVERRIDES_VERSION,
} from "@/lib/domain/curriculum";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { LEGACY_CONCEPTS, PDF_B_CONCEPTS, legacyV2Payload } from "./legacy-v2";

const EDIT_FROM_A = {
  title: "EDIT FROM PDF A",
  summary: "SUMMARY FROM PDF A",
};

/**
 * A v2 store as PDF A left it: an edited and approved concept, a discarded
 * one — and `concepts` already replaced by PDF B's content, because the
 * colliding identity let B overwrite A's material under the same ids.
 */
function collidedStore(version = 2) {
  return legacyV2Payload(
    { "legacy-c0": "ACTIVE", "legacy-c1": "DISCARDED", "c-draft-lysosomal": "ACTIVE" },
    {
      version,
      edits: {
        "legacy-c0": EDIT_FROM_A,
        // An authored Milestone 1 edit, whose id never collided.
        "c-hypoxia": { title: "Authored edit worth keeping" },
      },
      concepts: PDF_B_CONCEPTS,
    },
  );
}

describe("legacy review decisions are not carried across a collision", () => {
  it("removes the edit made under the colliding identity", () => {
    const migrated = migrateOverrides(collidedStore())!;
    expect(migrated).not.toBeNull();
    expect(migrated.edits["legacy-c0"]).toBeUndefined();
  });

  it("resets a legacy ACTIVE decision to DRAFT", () => {
    const migrated = migrateOverrides(collidedStore())!;
    expect(migrated.statusById["legacy-c0"]).toBe("DRAFT");
  });

  it("resets a legacy DISCARDED decision to DRAFT as well", () => {
    // A discard is a review decision about content that may have been replaced,
    // so it is exactly as untrustworthy as an approval.
    const migrated = migrateOverrides(collidedStore())!;
    expect(migrated.statusById["legacy-c1"]).toBe("DRAFT");
  });

  it("resets every legacy concept, not only the ones with a stored decision", () => {
    const migrated = migrateOverrides(collidedStore())!;
    for (const concept of LEGACY_CONCEPTS) {
      expect(migrated.statusById[concept.id], concept.id).toBe("DRAFT");
    }
  });

  it("preserves authored Milestone 1 edits and approvals", () => {
    const migrated = migrateOverrides(collidedStore())!;
    expect(migrated.edits["c-hypoxia"]).toEqual({ title: "Authored edit worth keeping" });
    expect(migrated.statusById["c-draft-lysosomal"]).toBe("ACTIVE");
  });

  it("re-approving uses PDF B's own content, never PDF A's edit", () => {
    const migrated = migrateOverrides(collidedStore())!;
    const reapproved = setConceptStatus(migrated, "legacy-c0", "ACTIVE");
    const curriculum = applyOverrides(pathologyCurriculum, reapproved);
    const concept = curriculum.concepts.find((c) => c.id === "legacy-c0")!;

    expect(concept.status).toBe("ACTIVE");
    expect(concept.title).toBe(PDF_B_CONCEPTS[0]!.title);
    expect(concept.summary).toBe(PDF_B_CONCEPTS[0]!.summary);
    expect(concept.title).not.toBe(EDIT_FROM_A.title);
    expect(JSON.stringify(concept)).not.toContain("PDF A");
  });

  it("cleans a store that was already migrated by the earlier, incomplete v3", () => {
    // v3 reset ACTIVE only and kept edits, so those stores are still unsafe.
    const migrated = migrateOverrides(collidedStore(3))!;
    expect(migrated.version).toBe(CURRICULUM_OVERRIDES_VERSION);
    expect(migrated.edits["legacy-c0"]).toBeUndefined();
    expect(migrated.statusById["legacy-c0"]).toBe("DRAFT");
    expect(migrated.statusById["legacy-c1"]).toBe("DRAFT");
    expect(migrated.edits["c-hypoxia"]).toBeDefined();
  });

  it("leaves a store with no legacy identities completely alone", () => {
    const modern = legacyV2Payload(
      { "c-draft-lysosomal": "ACTIVE" },
      { edits: { "c-hypoxia": { title: "Keep me" } }, concepts: [] },
    );
    modern.ingested = [];
    const migrated = migrateOverrides(modern)!;
    expect(migrated.statusById["c-draft-lysosomal"]).toBe("ACTIVE");
    expect(migrated.edits["c-hypoxia"]).toEqual({ title: "Keep me" });
  });
});
