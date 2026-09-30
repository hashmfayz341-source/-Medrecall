"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLearner } from "./LearnerProvider";
import { ButtonLink } from "./ui";
import {
  buildStudyQueueFor,
  captureCardPrecondition,
  studyDayCounts,
  formatInterval,
  recordCardRating,
  type CardRatingPrecondition,
  type StudyQueueKind,
} from "@/lib/engine/study";
import { resolveStudySelection, type StudySelection } from "@/lib/engine/decks";
import { composeSession, eligibleOldReviews, type SessionCard } from "@/lib/engine/session";
import { useStudySettings } from "./useStudySettings";
import { CardImage } from "./CardImage";
import { newSchedule, previewRatings } from "@/lib/engine/scheduler";
import { StaleAttemptError } from "@/lib/domain/errors";
import { pageAssetId } from "@/lib/visuals/analyze";
import type { RetrievalKind, SelfRating } from "@/lib/domain/types";
import { displayExcerpt } from "@/lib/domain/text";

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

export function StudySession({
  selection,
  ignoreLimits = false,
}: {
  selection: StudySelection;
  /** Custom study may ignore the daily limits; scheduling is normal FSRS either way. */
  ignoreLimits?: boolean;
}) {
  const { curriculum, learner, setLearner, snapshot, syncFromStorage, ready } = useLearner();
  const { limits } = useStudySettings();
  const [now, setNow] = useState(() => new Date());
  /** The card whose answer is showing. Pinned so a background update cannot swap it. */
  const [revealedId, setRevealedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const precondition = useRef<CardRatingPrecondition | null>(null);
  /**
   * Current-lecture cards rated since the last inserted old review. The
   * session composer is stateless; this count keeps the "one old review
   * after every four current cards" cadence as the queue shifts.
   */
  const [currentSinceReview, setCurrentSinceReview] = useState(0);
  /** Precondition keys already rated from this screen: a second tap is ignored. */
  const rated = useRef(new Set<string>());
  // The keys describe card versions. Once the learner state has moved on —
  // this rating was applied, another tab rated, or the learner was Reset (a
  // fresh card then has exactly the key its earlier first rating had) — they
  // are stale, and keeping them would swallow a legitimate rating. A double
  // tap is still caught: both taps run before React re-renders.
  useEffect(() => {
    rated.current.clear();
  }, [learner]);

  // Learning cards come due within minutes; keep "now" moving.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);

  const resolved = useMemo(
    () => resolveStudySelection(curriculum, learner, now, selection),
    [curriculum, learner, now, selection],
  );
  const missingLecture = selection.kind === "lecture" && resolved.lecture === null;

  const study = useMemo(() => {
    if (!ready || missingLecture) return null;
    return {
      total: resolved.cards.length,
      ...buildStudyQueueFor(curriculum, learner, resolved.cards, now, {
        limits: ignoreLimits ? undefined : limits,
        dueOnly: resolved.dueOnly,
      }),
    };
  }, [ready, missingLecture, resolved, curriculum, learner, now, limits, ignoreLimits]);

  // What appears next: the lecture's own queue with older cards that FSRS
  // says are overdue, due or about to come due mixed in (session composer).
  // FSRS decides WHEN a card is due; the composer only orders the session.
  const session = useMemo<SessionCard[]>(() => {
    if (!study) return [];
    if (selection.kind !== "lecture" || !resolved.lecture) {
      return study.queue.map((card) => ({ ...card, origin: "current" as const, lecture: resolved.lecture ?? curriculum.course.lectures[0]! }));
    }
    const old = eligibleOldReviews(curriculum, learner, resolved.lecture.id, now);
    // The existing reviews-per-day limit covers inserted old reviews too:
    // what is left after today's reviews and this lecture's own shown ones.
    const maxReviews = ignoreLimits
      ? undefined
      : Math.max(0, limits.reviewsPerDay - studyDayCounts(learner, now).reviews - study.counts.review);
    return composeSession(study.queue, resolved.lecture, old, { currentSinceReview, maxReviews });
  }, [study, selection.kind, resolved.lecture, curriculum, learner, now, currentSinceReview, ignoreLimits, limits]);

  const current: SessionCard | null =
    (session.length > 0 && (session.find((c) => c.item.id === revealedId) ?? session[0])) || null;
  const revealed = current !== null && revealedId === current.item.id;
  const pendingReviews = session.filter((c) => c.origin === "review").length;

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
    // Content-aware: the same card id with updated content is a new key.
    const key = `${pre.itemId}|${pre.reviews}|${pre.lastReviewedAt ?? ""}|${pre.target}`;
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
      // An inserted old review resets the cadence; a current card advances it.
      setCurrentSinceReview((n) => (current.origin === "review" ? 0 : n + 1));
    } catch (cause) {
      // Nothing was recorded, so this showing must not stay marked as rated:
      // otherwise a legitimate rating after the card reappears is ignored.
      rated.current.delete(key);
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
      // Never hijack a focused control: Enter on a link or button, typing in a
      // field, etc. keep their native behaviour.
      if (isInteractiveTarget(event.target)) return;
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

  if (!study) {
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

  const held = study.heldByLimits.new + study.heldByLimits.review;
  const limitNote =
    held > 0 ? (
      <p data-testid="limit-note" className="mt-3 text-sm text-ink-500">
        {study.heldByLimits.new > 0 && `${study.heldByLimits.new} new ${study.heldByLimits.new === 1 ? "card" : "cards"}`}
        {study.heldByLimits.new > 0 && study.heldByLimits.review > 0 && " and "}
        {study.heldByLimits.review > 0 && `${study.heldByLimits.review} ${study.heldByLimits.review === 1 ? "review" : "reviews"}`}
        {" "}held back by today&apos;s limits.
      </p>
    ) : null;

  if (study.total === 0 && pendingReviews === 0) {
    const lectureHref = resolved.lecture ? `/lectures/${encodeURIComponent(resolved.lecture.id)}` : "/concepts";
    return (
      <Shell title={resolved.title}>
        <div data-testid="study-empty" className="rounded-2xl border border-ink-200 bg-white p-8 text-center">
          <h1 className="text-2xl font-bold text-ink-800">No cards to study yet</h1>
          <p className="mt-3 text-ink-600">
            Generate cards for this lecture and approve them, then come back to study.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-3">
            <ButtonLink href={lectureHref} variant="secondary" data-testid="study-empty-review">
              Review cards
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
      <Shell title={resolved.title}>
        {counts}
        <div data-testid="study-done" className="mt-6 rounded-2xl border border-ink-200 bg-white p-8 text-center">
          <h1 className="text-2xl font-bold text-ink-800">
            {selection.kind === "lecture" ? "Congratulations! You have finished this lecture for now." : "Nothing more to study in this selection for now."}
          </h1>
          <p className="mt-3 text-ink-600">
            {study.nextDueAt
              ? `The next card is due in ${formatInterval(study.nextDueAt.getTime() - now.getTime())}.`
              : "There is nothing scheduled yet."}
          </p>
          {limitNote}
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
  const isReview = current.origin === "review";
  const frontImage = item.image?.placement === "front" ? item.image : null;
  const backImage = item.image?.placement === "back" ? item.image : null;
  const pageImage = { assetId: pageAssetId(concept.source.documentId, concept.source.pageNumber), documentId: concept.source.documentId, pageNumber: concept.source.pageNumber, placement: "back" as const };

  return (
    <Shell title={resolved.title}>
      {counts}
      {pendingReviews > 0 && (
        <p data-testid="review-note" className="mt-2 text-center text-xs font-semibold uppercase tracking-wide text-ink-500">
          {pendingReviews} {pendingReviews === 1 ? "review" : "reviews"} from earlier lectures mixed in
        </p>
      )}
      {limitNote}

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
        data-origin={current.origin}
        data-lecture-id={current.lecture.id}
        className="mt-6 flex min-h-[22rem] flex-col rounded-2xl border border-ink-200 bg-white px-6 py-8 shadow-sm sm:px-10 sm:py-12"
      >
        <p className="text-center text-xs font-semibold uppercase tracking-[0.14em] text-ink-400">
          {KIND_LABEL[item.kind]}
          {isReview && (
            // The lecture is named only after the answer: its title could give the answer away.
            <span data-testid="card-review-chip" className="ml-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.65rem] normal-case tracking-normal text-amber-800">
              Review
            </span>
          )}
        </p>
        {frontImage && (
          <div className="mt-4">
            <CardImage image={frontImage} alt={`Figure from page ${frontImage.pageNumber}`} testId="card-image-front" />
          </div>
        )}
        <div
          data-testid="card-front"
          dir="auto"
          className="mt-4 text-center text-2xl font-semibold leading-snug text-ink-800 sm:text-[1.75rem]"
        >
          {item.prompt}
        </div>

        {revealed && (
          <div data-testid="card-back" className="mt-8 border-t border-ink-200 pt-8">
            <p dir="auto" className="whitespace-pre-line text-center text-xl leading-relaxed text-ink-700">{item.explanation}</p>
            {backImage && (
              <div className="mt-6">
                <CardImage image={backImage} alt={`Figure from page ${backImage.pageNumber}`} testId="card-image-back" />
              </div>
            )}
            <div className="mt-8 text-center text-sm text-ink-500">
              {isReview && (
                <p data-testid="card-origin" className="mb-1 font-semibold text-amber-800">
                  From {current.lecture.title}
                </p>
              )}
              <span data-testid="card-source">
                {document?.title ?? concept.source.documentId} · page {concept.source.pageNumber}
              </span>
              {concept.additionalSources && concept.additionalSources.length > 0 && (
                <p data-testid="card-also-sources" className="mt-1 text-xs text-ink-400">
                  Also in{" "}
                  {concept.additionalSources
                    .map((s) => `${curriculum.course.lectures.flatMap((l) => l.documents).find((d) => d.id === s.documentId)?.title ?? s.documentId} · page ${s.pageNumber}`)
                    .join("; ")}
                </p>
              )}
              <details className="mx-auto mt-2 max-w-xl text-left">
                <summary
                  data-testid="view-source"
                  className="flex min-h-[2.75rem] cursor-pointer list-none items-center justify-center font-semibold text-clinical-700 marker:hidden"
                >
                  View source
                </summary>
                <blockquote
                  data-testid="source-excerpt"
                  dir="auto"
                  className="mt-2 whitespace-pre-line border-l-4 border-clinical-300 pl-4 text-[0.95rem] leading-relaxed text-ink-600"
                >
                  “{displayExcerpt(concept.source.excerpt)}”
                </blockquote>
                <div className="mt-3">
                  <CardImage image={pageImage} alt={`Page ${concept.source.pageNumber} of ${document?.title ?? "the source"}`} size="page" testId="source-page-image" hideWhenMissing />
                </div>
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

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return (
    target.closest(
      'input, textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"]',
    ) !== null
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
