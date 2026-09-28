"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useLearner } from "./LearnerProvider";
import { StudySession } from "./StudySession";
import { useStudySettings } from "./useStudySettings";
import { Button, Card, SectionTitle } from "./ui";
import {
  resolveStudySelection,
  selectionFromParams,
  selectionToParams,
  type StudySelection,
} from "@/lib/engine/decks";
import { buildStudyQueueFor } from "@/lib/engine/study";
import type { ConceptImportance, RetrievalKind } from "@/lib/domain/types";

/*
 * Custom study: choose WHICH cards, then study them with the normal engine.
 * Scheduling is always FSRS, through the same rating path as a lecture
 * session; the only options are the selection and whether today's limits
 * apply. The choice lives in the URL, so a refresh resumes the same session.
 */

const KINDS: RetrievalKind[] = ["BASIC", "CLOZE", "MECHANISM", "FREE_RECALL", "CLINICAL", "IMAGE"];
const selectClass = "min-h-[44px] rounded-xl border border-ink-300 bg-white px-3 text-sm font-semibold text-ink-700";

export function CustomStudy() {
  const params = useSearchParams();
  const router = useRouter();
  const { curriculum, learner, ready } = useLearner();
  const { limits } = useStudySettings();
  const started = params.get("start") === "1";
  const ignoreLimitsParam = params.get("ignoreLimits") === "1";
  const fromUrl = useMemo(() => selectionFromParams(params), [params]);

  const [selection, setSelection] = useState<StudySelection>(fromUrl);
  const [ignoreLimits, setIgnoreLimits] = useState(ignoreLimitsParam);

  if (started) {
    return <StudySession key={params.toString()} selection={fromUrl} ignoreLimits={ignoreLimitsParam} />;
  }

  const lectures = [...curriculum.course.lectures].sort((a, b) => a.order - b.order);
  const preview = ready
    ? (() => {
        const resolved = resolveStudySelection(curriculum, learner, new Date(), selection);
        const queue = buildStudyQueueFor(curriculum, learner, resolved.cards, new Date(), {
          limits: ignoreLimits ? undefined : limits,
          dueOnly: resolved.dueOnly,
        });
        return { total: resolved.cards.length, available: queue.queue.length, counts: queue.counts };
      })()
    : null;

  const filter = selection.kind === "filter" ? selection.filter : {};
  const setFilter = (patch: Partial<typeof filter>) => setSelection({ kind: "filter", filter: { ...filter, ...patch } });

  function start() {
    const next = selectionToParams(selection, ignoreLimits);
    next.set("start", "1");
    router.push(`/study/custom?${next.toString()}`);
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
      <Link href="/study" className="mb-6 inline-flex min-h-[44px] items-center text-sm font-bold uppercase tracking-[0.12em] text-clinical-700">
        ← Study decks
      </Link>
      <h1 className="text-3xl font-bold tracking-tight text-ink-800">Custom study</h1>
      <p className="mt-2 max-w-2xl text-ink-600">
        Pick which cards to study. Ratings schedule cards exactly as in a normal session — custom study never changes how FSRS works.
      </p>

      <Card className="mt-8">
        <SectionTitle>What to study</SectionTitle>
        <div className="mt-4 space-y-3">
          <label className="flex min-h-[44px] items-center gap-3 text-base text-ink-700">
            <input type="radio" name="scope" data-testid="scope-due" checked={selection.kind === "due"} onChange={() => setSelection({ kind: "due" })} className="h-5 w-5" />
            All cards due now, across the course (no new cards)
          </label>
          <label className="flex min-h-[44px] items-center gap-3 text-base text-ink-700">
            <input type="radio" name="scope" data-testid="scope-filter" checked={selection.kind === "filter"} onChange={() => setSelection({ kind: "filter", filter: {} })} className="h-5 w-5" />
            A selection of cards
          </label>
        </div>
        {selection.kind === "filter" && (
          <div className="mt-4 flex flex-wrap gap-3" data-testid="custom-filters">
            <select data-testid="custom-lecture" aria-label="Lecture" className={selectClass} value={filter.lectureId ?? ""} onChange={(e) => setFilter({ lectureId: e.target.value || undefined })}>
              <option value="">All lectures</option>
              {lectures.map((l) => (
                <option key={l.id} value={l.id}>{l.order}. {l.title}</option>
              ))}
            </select>
            <select data-testid="custom-kind" aria-label="Card type" className={selectClass} value={filter.kind ?? ""} onChange={(e) => setFilter({ kind: (e.target.value || undefined) as RetrievalKind | undefined })}>
              <option value="">All types</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>{k.replace("_", " ")}</option>
              ))}
            </select>
            <select data-testid="custom-importance" aria-label="Importance" className={selectClass} value={filter.importance ?? ""} onChange={(e) => setFilter({ importance: (e.target.value || undefined) as ConceptImportance | undefined })}>
              <option value="">Any importance</option>
              <option value="CORE">CORE</option>
              <option value="SUPPORTING">SUPPORTING</option>
            </select>
            <select data-testid="custom-status" aria-label="Status" className={selectClass} value={filter.status ?? ""} onChange={(e) => setFilter({ status: (e.target.value || undefined) as typeof filter.status })}>
              <option value="">Any status</option>
              <option value="NEW">New</option>
              <option value="LEARNING">Learning</option>
              <option value="REVIEW">Review</option>
              <option value="DUE">Due now</option>
            </select>
          </div>
        )}
        <label className="mt-5 flex min-h-[44px] items-center gap-3 text-base text-ink-700">
          <input type="checkbox" data-testid="ignore-limits" checked={ignoreLimits} onChange={(e) => setIgnoreLimits(e.target.checked)} className="h-5 w-5" />
          Ignore today&apos;s daily limits ({limits.newPerDay} new · {limits.reviewsPerDay} reviews)
        </label>

        <p data-testid="custom-preview" className="mt-5 text-sm text-ink-600">
          {preview
            ? `${preview.available} of ${preview.total} ${preview.total === 1 ? "card" : "cards"} available now · ${preview.counts.new} new · ${preview.counts.learning} learning · ${preview.counts.review} review`
            : "Loading your cards…"}
        </p>
        <div className="mt-5">
          <Button data-testid="start-custom" onClick={start} disabled={!preview || preview.available === 0}>
            Start studying
          </Button>
        </div>
      </Card>
    </main>
  );
}
