"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useLearner } from "@/components/LearnerProvider";
import { Button, Card, SectionTitle, SourceRefLine } from "@/components/ui";

/**
 * The Concept Approval Gate, as a screen.
 *
 * Extraction produces candidates; a human decides what becomes teachable. The
 * gate itself lives in the domain layer — this page is one caller of it, not
 * the enforcement point.
 */
export default function ConceptReviewPage() {
  const { curriculum, updateConceptStatus, ready } = useLearner();
  const [filter, setFilter] = useState<"DRAFT" | "ACTIVE" | "DISCARDED">("DRAFT");

  const grouped = useMemo(() => {
    return {
      DRAFT: curriculum.concepts.filter((c) => c.status === "DRAFT"),
      ACTIVE: curriculum.concepts.filter((c) => c.status === "ACTIVE"),
      DISCARDED: curriculum.concepts.filter((c) => c.status === "DISCARDED"),
    };
  }, [curriculum]);

  const docsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const lecture of curriculum.course.lectures) {
      for (const doc of lecture.documents) map.set(doc.id, doc.title);
    }
    return map;
  }, [curriculum]);

  const shown = grouped[filter];

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
      <Link
        href="/"
        className="mb-6 inline-block text-sm font-bold uppercase tracking-[0.12em] text-clinical-700"
      >
        MedRecall
      </Link>

      <h1 className="text-3xl font-bold tracking-tight text-ink-800">
        Concept review
      </h1>
      <p className="mt-2 max-w-2xl text-ink-600">
        Extracted concepts start as <strong>DRAFT</strong>. Only concepts you
        approve can be taught, tested, scheduled or interleaved — the gate is
        enforced in the domain layer, so nothing bypasses it.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        {(["DRAFT", "ACTIVE", "DISCARDED"] as const).map((key) => (
          <button
            key={key}
            data-testid={`filter-${key}`}
            onClick={() => setFilter(key)}
            className={`min-h-[3rem] rounded-xl border px-5 text-sm font-semibold ${
              filter === key
                ? "border-clinical-600 bg-clinical-600 text-white"
                : "border-ink-300 bg-white text-ink-700"
            }`}
          >
            {key} ({grouped[key].length})
          </button>
        ))}
      </div>

      {!ready ? (
        <p className="mt-8 text-ink-500">Loading…</p>
      ) : (
        <div className="mt-8 space-y-5">
          {shown.length === 0 && (
            <Card>
              <p className="text-ink-500">Nothing in {filter}.</p>
            </Card>
          )}
          {shown.map((concept) => (
            <Card key={concept.id} data-testid={`concept-${concept.id}`}>
              <SectionTitle>
                {concept.importance} · {concept.status}
              </SectionTitle>
              <h2 className="mt-2 text-xl font-bold text-ink-800">
                {concept.title}
              </h2>
              <p className="mt-2 leading-relaxed text-ink-600">
                {concept.summary}
              </p>

              <SourceRefLine
                documentTitle={docsById.get(concept.source.documentId) ?? "Source"}
                pageNumber={concept.source.pageNumber}
                excerpt={concept.source.excerpt}
              />

              <div className="mt-6 flex flex-wrap gap-3">
                {concept.status !== "ACTIVE" && (
                  <Button
                    data-testid={`approve-${concept.id}`}
                    onClick={() => updateConceptStatus(concept.id, "ACTIVE")}
                  >
                    Approve
                  </Button>
                )}
                {concept.status !== "DRAFT" && (
                  <Button
                    variant="secondary"
                    data-testid={`draft-${concept.id}`}
                    onClick={() => updateConceptStatus(concept.id, "DRAFT")}
                  >
                    Return to draft
                  </Button>
                )}
                {concept.status !== "DISCARDED" && (
                  <Button
                    variant="danger"
                    data-testid={`discard-${concept.id}`}
                    onClick={() => updateConceptStatus(concept.id, "DISCARDED")}
                  >
                    Discard
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </main>
  );
}
