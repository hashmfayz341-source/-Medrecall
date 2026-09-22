"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useLearner } from "@/components/LearnerProvider";
import { Button, ButtonLink, Card, SectionTitle } from "@/components/ui";
import type { Concept, ConceptStatus } from "@/lib/domain/types";

/**
 * The Concept Approval Gate, as a screen.
 *
 * Extraction produces candidates; a human decides what becomes teachable. The
 * gate itself lives in the domain layer — this page is one caller of it, not
 * the enforcement point.
 *
 * Editing and approving are deliberately separate actions: saving a correction
 * to a draft leaves it a draft.
 */
function ConceptReview() {
  const {
    curriculum,
    ready,
    updateConceptStatus,
    updateConceptStatuses,
    updateConceptText,
  } = useLearner();

  const params = useSearchParams();
  const documentFilterFromUrl = params.get("document") ?? "";

  const [statusFilter, setStatusFilter] = useState<ConceptStatus>("DRAFT");
  const [documentFilter, setDocumentFilter] = useState(documentFilterFromUrl);
  const [pageFilter, setPageFilter] = useState<string>("");
  const [editing, setEditing] = useState<Record<string, { title: string; summary: string }>>({});

  const documents = useMemo(() => {
    const map = new Map<string, string>();
    for (const lecture of curriculum.course.lectures) {
      for (const doc of lecture.documents) map.set(doc.id, `${lecture.title} · ${doc.title}`);
    }
    return map;
  }, [curriculum]);

  const grouped = useMemo(
    () => ({
      DRAFT: curriculum.concepts.filter((c) => c.status === "DRAFT"),
      ACTIVE: curriculum.concepts.filter((c) => c.status === "ACTIVE"),
      DISCARDED: curriculum.concepts.filter((c) => c.status === "DISCARDED"),
    }),
    [curriculum],
  );

  const shown = useMemo(() => {
    return grouped[statusFilter].filter((concept) => {
      if (documentFilter && concept.source.documentId !== documentFilter) return false;
      if (pageFilter && String(concept.source.pageNumber) !== pageFilter) return false;
      return true;
    });
  }, [grouped, statusFilter, documentFilter, pageFilter]);

  const pagesInScope = useMemo(() => {
    const set = new Set<number>();
    for (const concept of grouped[statusFilter]) {
      if (!documentFilter || concept.source.documentId === documentFilter) {
        set.add(concept.source.pageNumber);
      }
    }
    return [...set].sort((a, b) => a - b);
  }, [grouped, statusFilter, documentFilter]);

  function draftOf(concept: Concept) {
    return editing[concept.id] ?? { title: concept.title, summary: concept.summary };
  }

  function setDraft(conceptId: string, patch: Partial<{ title: string; summary: string }>) {
    setEditing((current) => {
      const concept = curriculum.concepts.find((c) => c.id === conceptId)!;
      const base = current[conceptId] ?? { title: concept.title, summary: concept.summary };
      return { ...current, [conceptId]: { ...base, ...patch } };
    });
  }

  /** Save an edit WITHOUT approving — the two decisions stay separate. */
  function saveEdit(concept: Concept) {
    const draft = draftOf(concept);
    updateConceptText(concept.id, { title: draft.title, summary: draft.summary });
    setEditing((current) => {
      const next = { ...current };
      delete next[concept.id];
      return next;
    });
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
      <Link
        href="/"
        className="mb-6 inline-flex min-h-[44px] items-center text-sm font-bold uppercase tracking-[0.12em] text-clinical-700"
      >
        MedRecall
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink-800">
            Concept review
          </h1>
          <p className="mt-2 max-w-2xl text-ink-600">
            Extracted concepts start as <strong>DRAFT</strong>. Only concepts you
            approve can be taught, tested, scheduled or interleaved — the gate is
            enforced in the domain layer, so nothing bypasses it.
          </p>
        </div>
        <ButtonLink href="/ingest" variant="secondary" data-testid="add-material">
          Add material
        </ButtonLink>
      </div>

      <div className="mt-6 flex flex-wrap gap-3">
        {(["DRAFT", "ACTIVE", "DISCARDED"] as const).map((key) => (
          <button
            key={key}
            data-testid={`filter-${key}`}
            onClick={() => { setStatusFilter(key); setPageFilter(""); }}
            className={`min-h-[3rem] rounded-xl border px-5 text-sm font-semibold ${
              statusFilter === key
                ? "border-clinical-600 bg-clinical-600 text-white"
                : "border-ink-300 bg-white text-ink-700"
            }`}
          >
            {key} ({grouped[key].length})
          </button>
        ))}
      </div>

      {(documents.size > 0 || pagesInScope.length > 1) && (
        <div className="mt-4 flex flex-wrap gap-3">
          <select
            data-testid="document-filter"
            aria-label="Filter by document and lecture"
            value={documentFilter}
            onChange={(e) => {
              setDocumentFilter(e.target.value);
              setPageFilter("");
            }}
            className="min-h-[3rem] max-w-full rounded-xl border border-ink-300 bg-white px-4 text-sm text-ink-700"
          >
            <option value="">All documents</option>
            {[...documents.entries()].map(([id, title]) => (
              <option key={id} value={id}>
                {title}
              </option>
            ))}
          </select>

          <select
            data-testid="page-filter"
            aria-label="Filter by source page"
            value={pageFilter}
            onChange={(e) => setPageFilter(e.target.value)}
            className="min-h-[3rem] rounded-xl border border-ink-300 bg-white px-4 text-sm text-ink-700"
          >
            <option value="">All pages</option>
            {pagesInScope.map((n) => (
              <option key={n} value={String(n)}>
                Page {n}
              </option>
            ))}
          </select>
        </div>
      )}

      {statusFilter === "DRAFT" && shown.length > 0 && (
        <div className="mt-4">
          <Button
            variant="secondary"
            data-testid="bulk-approve"
            disabled={!ready || shown.some((c) => editing[c.id] !== undefined)}
            onClick={() => updateConceptStatuses(shown.map((c) => c.id), "ACTIVE")}
          >
            Approve all {shown.length} shown
          </Button>
        </div>
      )}

      {!ready ? (
        <p className="mt-8 text-ink-500">Loading…</p>
      ) : (
        <div className="mt-8 space-y-5">
          {shown.length === 0 && (
            <Card data-testid="empty-state">
              <p className="text-ink-500">
                Nothing in {statusFilter}
                {documentFilter || pageFilter ? " for this filter" : ""}.
              </p>
            </Card>
          )}

          {shown.map((concept) => {
            const draft = draftOf(concept);
            const isEditing = editing[concept.id] !== undefined;
            const docTitle = documents.get(concept.source.documentId) ?? concept.source.documentId;

            return (
              <Card
                key={concept.id}
                data-testid={`concept-${concept.id}`}
                data-status={concept.status}
                data-page={concept.source.pageNumber}
              >
                <SectionTitle>
                  {concept.importance} · {concept.status}
                </SectionTitle>

                <label className="sr-only" htmlFor={`title-${concept.id}`}>
                  Concept title
                </label>
                <input
                  id={`title-${concept.id}`}
                  data-testid={`title-input-${concept.id}`}
                  value={draft.title}
                  onChange={(e) => setDraft(concept.id, { title: e.target.value })}
                  className="mt-2 w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-xl font-bold text-ink-800 focus:border-clinical-500 focus:outline-none"
                />

                <label className="sr-only" htmlFor={`summary-${concept.id}`}>
                  Concept explanation
                </label>
                <textarea
                  id={`summary-${concept.id}`}
                  data-testid={`summary-input-${concept.id}`}
                  value={draft.summary}
                  rows={3}
                  onChange={(e) => setDraft(concept.id, { summary: e.target.value })}
                  className="mt-3 w-full rounded-xl border border-ink-200 bg-white px-4 py-3 leading-relaxed text-ink-700 focus:border-clinical-500 focus:outline-none"
                />

                {/* View Source: document, page and the verbatim excerpt. */}
                <details
                  data-testid={`source-${concept.id}`}
                  className="mt-4 rounded-xl border border-ink-200 bg-ink-50 p-4"
                >
                  <summary className="min-h-[2.75rem] cursor-pointer list-none text-sm font-semibold text-clinical-700">
                    View source · {docTitle}, page {concept.source.pageNumber}
                  </summary>
                  <blockquote
                    data-testid={`excerpt-${concept.id}`}
                    className="mt-3 border-l-4 border-clinical-300 pl-4 text-[0.95rem] leading-relaxed text-ink-600"
                  >
                    {concept.source.excerpt}
                  </blockquote>
                </details>

                <div className="mt-6 flex flex-wrap gap-3">
                  {isEditing && (
                    <p className="w-full text-sm text-ink-600" role="status">Save your edit before approving.</p>
                  )}
                  {isEditing && (
                    <Button
                      variant="secondary"
                      data-testid={`save-${concept.id}`}
                      disabled={!draft.title.trim() || !draft.summary.trim()}
                      onClick={() => saveEdit(concept)}
                    >
                      Save edit
                    </Button>
                  )}
                  {concept.status !== "ACTIVE" && (
                    <Button
                      data-testid={`approve-${concept.id}`}
                      disabled={isEditing}
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
            );
          })}
        </div>
      )}
    </main>
  );
}

export default function ConceptReviewPage() {
  return (
    <Suspense fallback={<main className="p-8 text-ink-500">Loading…</main>}>
      <ConceptReview />
    </Suspense>
  );
}
