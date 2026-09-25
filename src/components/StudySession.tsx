"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLearner } from "./LearnerProvider";
import { ButtonLink } from "./ui";
import {
  buildStudyQueue,
  captureCardPrecondition,
  formatInterval,
  recordCardRating,
  studyCardsForLecture,
  type CardRatingPrecondition,
  type StudyCard,
  type StudyQueueKind,
} from "@/lib/engine/study";
import { newSchedule, previewRatings } from "@/lib/engine/scheduler";
import { StaleAttemptError } from "@/lib/domain/errors";
import type { RetrievalKind, SelfRating } from "@/lib/domain/types";

/*
 * Anki-style study: front → Show Answer → back → Again / Hard / Good / Easy.
 *
 * Showing the answer changes nothing. Only a rating is recorded, through the
 * pure engine (`recordCardRating`), and it is applied to the freshest
 * persisted state. No grading request is made: the rating is the assessment.
 */

const KIND_LABEL: Record<RetrievalKind, string> = {
  BASIC: "Basic",
  CLOZE: "Cloze",
  MECHANISM: "Mechanism",
  FREE_RECALL: "Recall",
  CLINICAL: "Clinical",
  IMAGE: "Image",
};

const RATINGS: { rating: SelfRating; label: string; key: string; tone: string }[] = [
  { rating: "AGAIN", label: "Again", key: "1", tone: "border-red-300 text-red-700 hover:bg-red-50" },
  { rating: "HARD", label: "Hard", key: "2", tone: "border-ink-300 text-ink-700 hover:bg-ink-100" },
  { rating: "GOOD", label: "Good", key: "3", tone: "border-emerald-300 text-emerald-700 hover:bg-emerald-50" },
  { rating: "EASY", label: "Easy", key: "4", tone: "border-clinical-300 text-clinical-700 hover:bg-clinical-50" },
];

const COUNT_TONE: Record<StudyQueueKind, string> = {
  NEW: "text-clinical-700",
  LEARNING: "text-red-700",
  REVIEW: "text-emerald-700",
};

export function StudySession({ lectureId }: { lectureId: string }) {
  const { curriculum, learner, setLearner, snapshot, syncFromStorage, ready } = useLearner();
  const [now, setNow] = useState(() => new Date());
  /** The card whose answer is showing. Pinned so a background update cannot swap it. */
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const precondition = useRef<CardRatingPrecondition | null>(null);
  /** Precondition keys already rated from this screen: a second tap is ignored. */
  const rated = useRef(new Set<string>());

  // Learning cards come due within minutes; keep "now" moving.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const lecture = curriculum.course.lectures.find((l) => l.id === lectureId);

  const study = useMemo(() => {
    if (!ready || !lecture) return null;
    return {
      total: studyCardsForLecture(curriculum, lectureId).length,
      ...buildStudyQueue(curriculum, learner, lectureId, now),
    };
  }, [ready, lecture, curriculum, learner, lectureId, now]);

  const current: StudyCard | null =
    (study && (study.queue.find((c) => c.item.id === revealedId) ?? study.next)) || null;
  const revealed = current !== null && revealedId === current.item.id;

  const previews = useMemo(() => {
    if (!current || !revealed) return null;
    const schedule = current.progress?.schedule ?? newSchedule(now);
    const at = new Date();
    const due = previewRatings(schedule, at);
    return Object.fromEntries(
      RATINGS.map(({ rating }) => [rating, formatInterval(due[rating].getTime() - at.getTime())]),
    ) as Record<SelfRating, string>;
  }, [current, revealed, now]);

  function reveal() {
    if (!current || revealed) return;
    // Nothing is recorded by revealing. The precondition captured here is what
    // makes a double-tapped or cross-tab rating detectable later.
    precondition.current = captureCardPrecondition(learner, current.concept, current.item);
    setRevealedId(current.item.id);
    setNotice(null);
  }

  function rate(rating: SelfRating) {
    if (!current || !revealed) return;
    const pre = precondition.current;
    if (!pre || pre.itemId !== current.item.id) return;
    const key = `${pre.itemId}|${pre.reviews}|${pre.lastReviewedAt ?? ""}`;
    if (rated.current.has(key)) return;
    rated.current.add(key);

    const latest = snapshot();
    try {
      const result = recordCardRating(
        latest.curriculum,
        latest.learner,
        { conceptId: current.concept.id, itemId: current.item.id, rating, now: new Date() },
        pre,
      );
      setLearner(result.learner);
    } catch (cause) {
      setNotice(
        cause instanceof StaleAttemptError && cause.reason === "TARGET_CHANGED"
          ? "This card was changed while you were studying it, so this rating was not recorded. Here it is again."
          : cause instanceof StaleAttemptError
            ? "This card was already reviewed in another tab, so this rating was not recorded."
            : "This card can no longer be studied — it may have been changed or removed.",
      );
      syncFromStorage();
    }
    precondition.current = null;
    setRevealedId(null);
    setNow(new Date());
  }

  // Keyboard, as in Anki: Space/Enter shows the answer, 1–4 rate it.
  const handlers = useRef({ reveal, rate, revealed });
  useEffect(() => {
    handlers.current = { reveal, rate, revealed };
  });
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const h = handlers.current;
      if (!h.revealed && (event.key === " " || event.key === "Enter")) {
        event.preventDefault();
        h.reveal();
        return;
      }
      if (h.revealed) {
        const choice = RATINGS.find((r) => r.key === event.key);
        if (choice) {
          event.preventDefault();
          h.rate(choice.rating);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!ready) {
    return (
      <Shell title="Study">
        <p className="text-ink-500">Loading your cards…</p>
      </Shell>
    );
  }

  if (!lecture || !study) {
    return (
      <Shell title="Study">
        <p className="text-ink-600">This lecture is not available in this browser.</p>
        <div className="mt-6">
          <ButtonLink href="/" variant="secondary">
            Back to dashboard
          </ButtonLink>
        </div>
      </Shell>
    );
  }

  const counts = (
    <div
      data-testid="study-counts"
      className="flex items-center justify-center gap-6 text-sm font-semibold tabular-nums"
    >
      {(
        [
          ["NEW", "New", study.counts.new, "count-new"],
          ["LEARNING", "Learning", study.counts.learning, "count-learning"],
          ["REVIEW", "Review", study.counts.review, "count-review"],
        ] as const
      ).map(([kind, label, value, testId]) => (
        <span key={kind} className="flex items-baseline gap-1.5">
          <span className="text-ink-500">{label}</span>
          <span
            data-testid={testId}
            className={`${COUNT_TONE[kind]} ${current?.queue === kind ? "underline underline-offset-4" : ""}`}
          >
            {value}
          </span>
        </span>
      ))}
    </div>
  );

  if (study.total === 0) {
    return (
      <Shell title={lecture.title}>
        <div data-testid="study-empty" className="rounded-2xl border border-ink-200 bg-white p-8 text-center">
          <h1 className="text-2xl font-bold text-ink-800">No cards to study yet</h1>
          <p className="mt-3 text-ink-600">
            Add material for this lecture and approve its cards, then come back to study.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <ButtonLink href="/concepts" variant="secondary">
              Review drafts
            </ButtonLink>
            <ButtonLink href="/" variant="secondary">
              Back to dashboard
            </ButtonLink>
          </div>
        </div>
      </Shell>
    );
  }

  if (!current) {
    return (
      <Shell title={lecture.title}>
        {counts}
        <div data-testid="study-done" className="mt-6 rounded-2xl border border-ink-200 bg-white p-8 text-center">
          <h1 className="text-2xl font-bold text-ink-800">Congratulations! You have finished this lecture for now.</h1>
          <p className="mt-3 text-ink-600">
            {study.nextDueAt
              ? `The next card is due in ${formatInterval(study.nextDueAt.getTime() - now.getTime())}.`
              : "There is nothing scheduled yet."}
          </p>
          {notice && (
            <p data-testid="study-notice" className="mt-4 text-sm text-amber-800">
              {notice}
            </p>
          )}
          <div className="mt-6">
            <ButtonLink href="/" variant="secondary">
              Back to dashboard
            </ButtonLink>
          </div>
        </div>
      </Shell>
    );
  }

  const { concept, item } = current;
  const document = curriculum.course.lectures
    .flatMap((l) => l.documents)
    .find((d) => d.id === concept.source.documentId);

  return (
    <Shell title={lecture.title}>
      {counts}

      {notice && (
        <p
          data-testid="study-notice"
          role="status"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm text-amber-900"
        >
          {notice}
        </p>
      )}

      <article
        data-testid="study-card"
        data-item-id={item.id}
        data-concept-id={concept.id}
        data-queue={current.queue}
        className="mt-6 flex min-h-[22rem] flex-col rounded-2xl border border-ink-200 bg-white px-6 py-8 shadow-sm sm:px-10 sm:py-12"
      >
        <p className="text-center text-xs font-semibold uppercase tracking-[0.14em] text-ink-400">
          {KIND_LABEL[item.kind]}
        </p>
        <div
          data-testid="card-front"
          className="mt-4 text-center text-2xl font-semibold leading-snug text-ink-800 sm:text-[1.75rem]"
        >
          {item.prompt}
        </div>

        {revealed && (
          <div data-testid="card-back" className="mt-8 border-t border-ink-200 pt-8">
            <p className="text-center text-xl leading-relaxed text-ink-700">{item.explanation}</p>
            <div className="mt-8 text-center text-sm text-ink-500">
              <span data-testid="card-source">
                {document?.title ?? concept.source.documentId} · page {concept.source.pageNumber}
              </span>
              <details className="mx-auto mt-2 max-w-xl text-left">
                <summary
                  data-testid="view-source"
                  className="flex min-h-[2.75rem] cursor-pointer list-none items-center justify-center font-semibold text-clinical-700 marker:hidden"
                >
                  View source
                </summary>
                <blockquote
                  data-testid="source-excerpt"
                  className="mt-2 border-l-4 border-clinical-300 pl-4 text-[0.95rem] leading-relaxed text-ink-600"
                >
                  “{concept.source.excerpt}”
                </blockquote>
              </details>
            </div>
          </div>
        )}
      </article>

      <div className="mt-6">
        {!revealed ? (
          <button
            type="button"
            data-testid="show-answer"
            onClick={reveal}
            className="flex min-h-[3.75rem] w-full items-center justify-center rounded-2xl bg-clinical-600 text-lg font-semibold text-white hover:bg-clinical-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-clinical-600"
          >
            Show Answer
          </button>
        ) : (
          <div data-testid="rating-buttons" className="grid grid-cols-4 gap-3">
            {RATINGS.map(({ rating, label, tone }) => (
              <button
                key={rating}
                type="button"
                data-testid={`rate-${rating.toLowerCase()}`}
                onClick={() => rate(rating)}
                className={`flex min-h-[4rem] flex-col items-center justify-center rounded-2xl border bg-white px-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-clinical-600 ${tone}`}
              >
                <span className="text-xs font-medium text-ink-500 tabular-nums">
                  {previews?.[rating]}
                </span>
                <span className="text-base">{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-6 sm:px-8 sm:py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/"
          className="inline-flex min-h-[44px] items-center text-sm font-bold uppercase tracking-[0.12em] text-clinical-700"
        >
          MedRecall
        </Link>
        <span data-testid="study-title" className="text-sm font-semibold text-ink-500">
          {title}
        </span>
      </div>
      {children}
    </main>
  );
}
