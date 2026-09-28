"use client";

import { useMemo } from "react";
import { useLearner } from "@/components/LearnerProvider";
import { DemoDashboard } from "@/components/DemoDashboard";
import { ButtonLink, Card } from "@/components/ui";
import { useStudySettings } from "@/components/useStudySettings";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { lectureDecks } from "@/lib/engine/decks";
import { eligibleOldReviews } from "@/lib/engine/session";

/*
 * Home: the learner's own lectures first — upload a PDF, get cards, study.
 * The authored demo course and its guided Tutor stay available below.
 */

const DEMO_LECTURE_IDS = new Set(pathologyCurriculum.course.lectures.map((l) => l.id));

export default function Home() {
  const { curriculum, learner, ready } = useLearner();
  const { limits } = useStudySettings();

  const lectures = useMemo(() => {
    const now = new Date();
    const drafts = new Map<string, number>();
    for (const concept of curriculum.concepts) {
      if (concept.status === "DRAFT") drafts.set(concept.lectureId, (drafts.get(concept.lectureId) ?? 0) + 1);
    }
    return lectureDecks(curriculum, learner, now, limits)
      .filter((deck) => !DEMO_LECTURE_IDS.has(deck.lecture.id))
      .map((deck) => ({
        ...deck,
        drafts: drafts.get(deck.lecture.id) ?? 0,
        // Due or about to be due in this lecture: what FSRS would bring back.
        due: eligibleOldReviews(curriculum, learner, "__none__", now).filter((r) => r.lecture.id === deck.lecture.id && r.reason !== "near").length,
      }));
  }, [curriculum, learner, limits]);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.12em] text-clinical-700">MedRecall</p>
          <h1 className="mt-1 text-4xl font-bold tracking-tight text-ink-800">My lectures</h1>
          <p className="mt-2 max-w-xl text-ink-600">
            Upload a lecture PDF, get flashcards made from it, and study them Anki-style. Older cards
            come back when FSRS says they are due.
          </p>
        </div>
        <ButtonLink href="/upload" data-testid="upload-lecture">
          Upload lecture
        </ButtonLink>
      </header>

      {!ready ? (
        <p className="mt-10 text-ink-500">Loading your lectures…</p>
      ) : lectures.length === 0 ? (
        <Card className="mt-8 text-center" data-testid="library-empty">
          <h2 className="text-2xl font-bold text-ink-800">Start with your first lecture</h2>
          <p className="mx-auto mt-2 max-w-md text-ink-600">
            Upload Cell Injury.pdf, choose the card language and how many cards you want, and MedRecall
            builds them from the slides — figures included.
          </p>
          <div className="mt-6">
            <ButtonLink href="/upload" data-testid="upload-first-lecture">
              Upload a lecture PDF
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <ul className="mt-8 space-y-4" data-testid="lecture-library">
          {lectures.map(({ lecture, total, counts, drafts, due }) => (
            <li
              key={lecture.id}
              data-testid={`library-${lecture.id}`}
              className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-ink-200 bg-white px-6 py-5 shadow-sm"
            >
              <div className="min-w-0">
                <h2 dir="auto" className="text-2xl font-bold text-ink-800" data-testid={`library-title-${lecture.id}`}>
                  {lecture.title}
                </h2>
                <p className="mt-1 text-sm font-semibold tabular-nums text-ink-600" data-testid={`library-counts-${lecture.id}`}>
                  {total} {total === 1 ? "card" : "cards"}
                  <span className="text-ink-400"> · </span>
                  <span className="text-clinical-700">{counts.new} new</span>
                  <span className="text-ink-400"> · </span>
                  <span className="text-red-700">{counts.learning} learning</span>
                  <span className="text-ink-400"> · </span>
                  <span className="text-emerald-700">{counts.review} review</span>
                  {due > 0 && (
                    <>
                      <span className="text-ink-400"> · </span>
                      <span data-testid={`library-due-${lecture.id}`} className="text-amber-800">{due} due</span>
                    </>
                  )}
                </p>
                {drafts > 0 && (
                  <p className="mt-1 text-sm text-amber-800" data-testid={`library-drafts-${lecture.id}`}>
                    {drafts} {drafts === 1 ? "card" : "cards"} to review
                  </p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <ButtonLink href={`/lectures/${encodeURIComponent(lecture.id)}`} variant="secondary" data-testid={`lecture-cards-${lecture.id}`}>
                  Cards
                </ButtonLink>
                {total > 0 && (
                  <ButtonLink href={`/study/${encodeURIComponent(lecture.id)}`} data-testid={`study-${lecture.id}`}>
                    Study
                  </ButtonLink>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <DemoDashboard />
    </main>
  );
}
