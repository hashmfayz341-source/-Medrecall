"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useLearner } from "./LearnerProvider";
import { useStudySettings } from "./useStudySettings";
import { Button, ButtonLink, Card, SectionTitle } from "./ui";
import { courseDeck } from "@/lib/engine/decks";
import { STUDY_LIMIT_MAX } from "@/lib/persistence/studySettings";

/*
 * The Study browser: the course as decks.
 *
 * Decks are the lectures — derived from Course → Lecture → Concept every
 * render, never stored. Counts come from each card's own FSRS state (with the
 * daily limits applied, as the session will apply them), not from concept
 * mastery.
 */

function Counts({ counts, testId }: { counts: { new: number; learning: number; review: number; suspended: number; buried: number }; testId: string }) {
  return (
    <p data-testid={testId} className="mt-1 text-sm font-semibold tabular-nums">
      <span className="text-clinical-700">{counts.new} new</span>
      <span className="text-ink-400"> · </span>
      <span className="text-red-700">{counts.learning} learning</span>
      <span className="text-ink-400"> · </span>
      <span className="text-emerald-700">{counts.review} review</span>
      {(counts.suspended > 0 || counts.buried > 0) && (
        <span className="text-ink-500">
          {" "}
          · {counts.suspended > 0 && <span data-testid={`${testId}-suspended`}>{counts.suspended} suspended</span>}
          {counts.suspended > 0 && counts.buried > 0 && " · "}
          {counts.buried > 0 && <span data-testid={`${testId}-buried`}>{counts.buried} buried</span>}
        </span>
      )}
    </p>
  );
}

export function StudyBrowser() {
  const { curriculum, learner, ready } = useLearner();
  const { limits, setLimits } = useStudySettings();
  const [draft, setDraft] = useState<{ newPerDay: string; reviewsPerDay: string } | null>(null);
  const [saveError, setSaveError] = useState(false);

  const deck = useMemo(() => courseDeck(curriculum, learner, new Date(), limits), [curriculum, learner, limits]);

  const form = draft ?? { newPerDay: String(limits.newPerDay), reviewsPerDay: String(limits.reviewsPerDay) };

  function saveLimits() {
    const next = { newPerDay: Number(form.newPerDay), reviewsPerDay: Number(form.reviewsPerDay) };
    const ok =
      Number.isInteger(next.newPerDay) && next.newPerDay >= 0 && next.newPerDay <= STUDY_LIMIT_MAX &&
      Number.isInteger(next.reviewsPerDay) && next.reviewsPerDay >= 0 && next.reviewsPerDay <= STUDY_LIMIT_MAX &&
      setLimits(next);
    setSaveError(!ok);
    if (ok) setDraft(null);
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
      <Link href="/" className="mb-6 inline-flex min-h-[44px] items-center text-sm font-bold uppercase tracking-[0.12em] text-clinical-700">
        MedRecall
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink-800">Study</h1>
          <p className="mt-2 max-w-2xl text-ink-600">
            Each lecture is a deck of its approved concepts&apos; cards. Counts follow each card&apos;s own schedule.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href="/study/browse" variant="secondary" data-testid="open-card-browser">
            Card browser
          </ButtonLink>
          <ButtonLink href="/study/custom" variant="secondary" data-testid="open-custom-study">
            Custom study
          </ButtonLink>
        </div>
      </div>

      {!ready ? (
        <p className="mt-8 text-ink-500">Loading your cards…</p>
      ) : (
        <>
          <Card className="mt-8" data-testid="course-deck">
            <SectionTitle>{curriculum.course.title}</SectionTitle>
            <p className="mt-2 text-lg font-semibold text-ink-800">
              {deck.total} cards across {deck.lectures.length} lectures
            </p>
            <Counts counts={deck.counts} testId="course-counts" />
            {deck.counts.learning + deck.counts.review > 0 && (
              <div className="mt-4">
                <ButtonLink href="/study/custom?scope=due&start=1" data-testid="study-due-course">
                  Study all due cards
                </ButtonLink>
              </div>
            )}
          </Card>

          <Card className="mt-6">
            <SectionTitle>Decks</SectionTitle>
            <ul className="mt-4 space-y-3">
              {deck.lectures.map(({ lecture, total, counts }) => (
                <li
                  key={lecture.id}
                  data-testid={`deck-${lecture.id}`}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ink-200 px-5 py-4"
                >
                  <div>
                    <p className="text-lg font-semibold text-ink-800">
                      {lecture.order}. {lecture.title}
                    </p>
                    <p className="mt-1 text-sm text-ink-500" data-testid={`deck-total-${lecture.id}`}>
                      {total} {total === 1 ? "card" : "cards"}
                    </p>
                    {total > 0 && <Counts counts={counts} testId={`deck-counts-${lecture.id}`} />}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <ButtonLink
                      href={`/study/browse?lecture=${encodeURIComponent(lecture.id)}`}
                      variant="secondary"
                      data-testid={`browse-${lecture.id}`}
                    >
                      Browse
                    </ButtonLink>
                    {total > 0 && (
                      <ButtonLink href={`/study/${lecture.id}`} data-testid={`study-${lecture.id}`}>
                        Study
                      </ButtonLink>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="mt-6" data-testid="study-options">
            <SectionTitle>Options</SectionTitle>
            <p className="mt-2 text-sm text-ink-600">
              Daily limits, in Anki&apos;s terms. Learning cards are never limited. Custom study can ignore them.
            </p>
            <div className="mt-4 flex flex-wrap items-end gap-4">
              <label className="flex flex-col gap-1 text-sm font-semibold text-ink-700">
                New cards per day
                <input
                  data-testid="limit-new"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={STUDY_LIMIT_MAX}
                  value={form.newPerDay}
                  onChange={(e) => setDraft({ ...form, newPerDay: e.target.value })}
                  className="min-h-[44px] w-32 rounded-xl border border-ink-300 px-3 text-base"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm font-semibold text-ink-700">
                Reviews per day
                <input
                  data-testid="limit-reviews"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={STUDY_LIMIT_MAX}
                  value={form.reviewsPerDay}
                  onChange={(e) => setDraft({ ...form, reviewsPerDay: e.target.value })}
                  className="min-h-[44px] w-32 rounded-xl border border-ink-300 px-3 text-base"
                />
              </label>
              <Button variant="secondary" data-testid="save-limits" onClick={saveLimits} disabled={draft === null}>
                Save
              </Button>
            </div>
            {saveError && (
              <p role="alert" data-testid="limits-error" className="mt-3 text-sm text-red-700">
                Enter whole numbers from 0 to {STUDY_LIMIT_MAX}. Nothing was saved.
              </p>
            )}
          </Card>
        </>
      )}
    </main>
  );
}
