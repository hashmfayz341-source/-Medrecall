import { describe, expect, it } from "vitest";
import { pathologyCurriculum as C } from "@/lib/content/pathology";
import {
  applyOverrides,
  createOverrides,
  editConcept,
  keepApart,
  mergeConcepts,
  setConceptStatus,
  setConceptStatuses,
  unmergeConcept,
  type CurriculumOverrides,
} from "@/lib/domain/curriculum";
import {
  InMemoryCurriculumRepository,
  commitOverrides,
  type CurriculumOverridesRepository,
} from "@/lib/persistence/curriculumStore";
import { DUP, HYPOXIA, OTHER, withUpload } from "./duplicate-fixture";

/**
 * H1 — a stale tab must never overwrite a newer merge / Keep both / Undo.
 *
 * Two tabs share one curriculum store. Each holds its own in-memory snapshot
 * (what `LearnerProvider` keeps in `overridesRef`), which goes stale the
 * moment the other tab writes. Every mutation is therefore applied to what
 * is stored NOW (`commitOverrides`), never to the snapshot: an operation is
 * an id-keyed decision, so rebasing it is safe, while serialising the
 * snapshot would silently drop the other tab's decisions.
 */

class Tab {
  snapshot: CurriculumOverrides;
  constructor(private readonly repo: CurriculumOverridesRepository) {
    this.snapshot = repo.load() ?? createOverrides();
  }
  /** What `LearnerProvider.mutate` does. */
  mutate(fn: (current: CurriculumOverrides) => CurriculumOverrides) {
    const { next } = commitOverrides(this.repo, this.snapshot, fn);
    this.snapshot = next;
  }
  live() {
    return applyOverrides(C, this.snapshot);
  }
  status(id: string) {
    return this.live().concepts.find((c) => c.id === id)!.status;
  }
}

/** A fresh store in which the duplicate has already been approved, as in the report. */
function sharedStore() {
  const repo = new InMemoryCurriculumRepository();
  repo.save(setConceptStatus(withUpload(), DUP, "ACTIVE"));
  return repo;
}
const reload = (repo: CurriculumOverridesRepository) => applyOverrides(C, repo.load());
const conceptOf = (repo: CurriculumOverridesRepository, id: string) => reload(repo).concepts.find((c) => c.id === id)!;

describe("H1: stale curriculum writes cannot undo newer merge decisions", () => {
  it("H1-A: an unrelated title edit from a stale tab keeps the merge, and the edit survives", () => {
    const repo = sharedStore();
    const a = new Tab(repo);
    const b = new Tab(repo);
    expect(b.status(DUP)).toBe("ACTIVE");

    a.mutate((o) => mergeConcepts(o, C, DUP, HYPOXIA));
    expect(conceptOf(repo, DUP).status).toBe("DISCARDED");
    // B still shows the pre-merge world…
    expect(b.status(DUP)).toBe("ACTIVE");
    // …and edits something else from that stale snapshot.
    b.mutate((o) => editConcept(o, OTHER, { title: "Neutrophils (edited in tab B)" }));

    const merged = conceptOf(repo, DUP);
    expect(repo.load()!.merges).toEqual({ [DUP]: HYPOXIA });
    expect(merged.status).toBe("DISCARDED");
    expect(merged.mergedInto).toBe(HYPOXIA);
    expect(conceptOf(repo, OTHER).title).toBe("Neutrophils (edited in tab B)");
    // Tab B's own view converged on the stored state.
    expect(b.status(DUP)).toBe("DISCARDED");
  });

  it("H1-B: a stale edit of the duplicate itself does not resurrect it", () => {
    const repo = sharedStore();
    const a = new Tab(repo);
    const b = new Tab(repo);
    a.mutate((o) => mergeConcepts(o, C, DUP, HYPOXIA));
    b.mutate((o) => editConcept(o, DUP, { title: "Hypoxia (stale edit)", summary: "Stale summary." }));

    expect(repo.load()!.merges).toEqual({ [DUP]: HYPOXIA });
    expect(conceptOf(repo, DUP).status).toBe("DISCARDED");
    expect(conceptOf(repo, DUP).mergedInto).toBe(HYPOXIA);
  });

  it("H1-C: a stale approval (single or bulk) of a merged duplicate does not resurrect it", () => {
    const repo = sharedStore();
    const a = new Tab(repo);
    const b = new Tab(repo);
    a.mutate((o) => mergeConcepts(o, C, DUP, HYPOXIA));

    b.mutate((o) => setConceptStatus(o, DUP, "ACTIVE"));
    expect(conceptOf(repo, DUP).status).toBe("DISCARDED");
    expect(repo.load()!.statusById[DUP]).toBe("DISCARDED"); // the stored decision is not even recorded as ACTIVE

    b.mutate((o) => setConceptStatuses(o, [DUP, OTHER], "ACTIVE"));
    expect(conceptOf(repo, DUP).status).toBe("DISCARDED");
    expect(conceptOf(repo, OTHER).status).toBe("ACTIVE"); // the unrelated approval in the same batch lands
    expect(repo.load()!.merges).toEqual({ [DUP]: HYPOXIA });
  });

  it("H1-D: a stale Keep both does not remove a newer merge", () => {
    const repo = sharedStore();
    const a = new Tab(repo);
    const b = new Tab(repo);
    a.mutate((o) => mergeConcepts(o, C, DUP, HYPOXIA));
    b.mutate((o) => keepApart(o, DUP, HYPOXIA));

    const stored = repo.load()!;
    expect(stored.merges).toEqual({ [DUP]: HYPOXIA });
    expect(stored.keptApart[DUP]).toBeUndefined();
    expect(conceptOf(repo, DUP).status).toBe("DISCARDED");
  });

  it("H1-E: after a fresh Undo, a stale tab that still holds the merge cannot recreate it", () => {
    const repo = sharedStore();
    const a = new Tab(repo);
    const before = new Tab(repo); // opened before the merge
    a.mutate((o) => mergeConcepts(o, C, DUP, HYPOXIA));
    const during = new Tab(repo); // opened while the merge existed
    expect(during.snapshot.merges).toEqual({ [DUP]: HYPOXIA });
    a.mutate((o) => unmergeConcept(o, DUP));
    expect(conceptOf(repo, DUP).status).toBe("DRAFT");

    during.mutate((o) => editConcept(o, OTHER, { summary: "Neutrophils arrive first (edited)." }));
    before.mutate((o) => setConceptStatus(o, OTHER, "ACTIVE"));

    const stored = repo.load()!;
    expect(stored.merges).toEqual({});
    expect(conceptOf(repo, DUP).status).toBe("DRAFT");
    expect(conceptOf(repo, DUP).mergedInto).toBeUndefined();
    expect(conceptOf(repo, HYPOXIA).additionalSources).toBeUndefined();
    expect(conceptOf(repo, OTHER).summary).toBe("Neutrophils arrive first (edited).");
    expect(conceptOf(repo, OTHER).status).toBe("ACTIVE");
  });

  it("H1-F: ordinary two-tab edits and approvals of different concepts both survive", () => {
    const repo = sharedStore();
    const a = new Tab(repo);
    const b = new Tab(repo);
    a.mutate((o) => editConcept(o, OTHER, { title: "Neutrophils (A)" }));
    b.mutate((o) => editConcept(o, DUP, { summary: "Hypoxia (B)." }));
    a.mutate((o) => setConceptStatus(o, "c-draft-lysosomal", "ACTIVE"));
    b.mutate((o) => setConceptStatus(o, OTHER, "DISCARDED"));

    expect(conceptOf(repo, OTHER).title).toBe("Neutrophils (A)");
    expect(conceptOf(repo, DUP).summary).toBe("Hypoxia (B).");
    expect(conceptOf(repo, "c-draft-lysosomal").status).toBe("ACTIVE");
    expect(conceptOf(repo, OTHER).status).toBe("DISCARDED");
    // Both tabs converge on the same stored state after their own write.
    expect(b.snapshot).toEqual(repo.load());
  });

  it("a mutation never serialises the tab's snapshot: even a no-op keeps what the store holds", () => {
    const repo = sharedStore();
    const a = new Tab(repo);
    const b = new Tab(repo);
    a.mutate((o) => mergeConcepts(o, C, DUP, HYPOXIA));
    b.mutate((o) => o);
    expect(repo.load()!.merges).toEqual({ [DUP]: HYPOXIA });
  });

  it("without a store (write failed or storage unavailable) the tab's own snapshot is the base", () => {
    const repo = new InMemoryCurriculumRepository();
    const fallback = withUpload();
    const { next, saved } = commitOverrides(repo, fallback, (o) => setConceptStatus(o, OTHER, "ACTIVE"));
    expect(saved).toBe(true);
    expect(next.statusById[OTHER]).toBe("ACTIVE");
    expect(next.ingested).toHaveLength(1);
  });
});
