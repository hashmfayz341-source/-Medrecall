"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLearner } from "./LearnerProvider";
import { Button, ButtonLink, Card, MasteryBadge, SourceRefLine } from "./ui";
import {
  getNextStep,
  isLectureUnlocked,
  markChunkTaught,
  type SessionStep,
} from "@/lib/engine/tutor";
import type { Concept, RetrievalItem, RetrievalContext } from "@/lib/domain/types";
import type { GradeResult } from "@/lib/grading";
import { requestGrade } from "@/lib/grading/client";
import { GRADE_REQUEST_LIMITS } from "@/lib/grading/request";
import {
  STALE_MESSAGE,
  createSubmitGuard,
  submitAnswer,
} from "@/lib/session/submitAnswer";

/*
 * No AI provider is imported here. Answers are graded by POST /api/grade on
 * the server; this component only applies an already-validated grade through
 * the deterministic engine.
 */

interface Feedback {
  grade: GradeResult;
  concept: Concept;
  item: RetrievalItem;
  context: RetrievalContext;
  remediation: string;
  /** Mastery is WEAK even though this answer was right. */
  stillWeak: boolean;
}

export function LearnSession({ lectureId }: { lectureId: string }) {
  const { curriculum, learner, setLearner, snapshot, syncFromStorage, ready } = useLearner();
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [gradeError, setGradeError] = useState<{
    message: string;
    retryable: boolean;
    /** The question it belongs to, so it never shows against a different one. */
    itemId: string;
  } | null>(null);
  /** A grade arrived for a question that had changed; nothing was recorded. */
  const [stale, setStale] = useState(false);
  const guard = useRef(createSubmitGuard());
  // The state the learner is looking at. The attempt's precondition is
  // captured from this — what they actually answered — while the grade is
  // applied to the freshest persisted state via `snapshot()`.
  const latest = useRef({ curriculum, learner });
  useEffect(() => {
    latest.current = { curriculum, learner };
  }, [curriculum, learner]);

  const exists = curriculum.course.lectures.some((lecture) => lecture.id === lectureId);
  const unlocked = ready && exists && isLectureUnlocked(curriculum, learner, lectureId);

  const step = useMemo<SessionStep | null>(() => {
    if (!ready || !unlocked) return null;
    return getNextStep(curriculum, learner, lectureId, new Date());
  }, [curriculum, learner, lectureId, ready, unlocked]);

  if (!ready) {
    return (
      <Shell>
        <Card>
          <p className="text-ink-500">Loading your progress…</p>
        </Card>
      </Shell>
    );
  }

  if (!unlocked) {
    return (
      <Shell>
        <Card>
          <h1 className="text-2xl font-bold text-ink-800">{exists ? "Lecture locked" : "Lecture not found"}</h1>
          <p className="prose-teach mt-3 text-ink-600">
            {exists ? "Finish the previous lecture before starting this one. MedRecall unlocks material in order so prerequisites are in place first." : "This lecture is not available in this browser. Return to the dashboard to choose a lecture."}
          </p>
          <div className="mt-6">
            <ButtonLink href="/" variant="secondary">
              Back to dashboard
            </ButtonLink>
          </div>
        </Card>
      </Shell>
    );
  }

  const lectureForEmptyCheck = curriculum.course.lectures.find((l) => l.id === lectureId);
  if (lectureForEmptyCheck && lectureForEmptyCheck.chunks.length === 0) {
    return (
      <Shell>
        <Card data-testid="lecture-empty">
          <h1 className="text-2xl font-bold text-ink-800">
            {lectureForEmptyCheck.title} has no material yet
          </h1>
          <p className="prose-teach mt-3 text-ink-600">
            Upload a PDF for this lecture, then review and approve the candidate
            concepts. Teaching begins once at least one concept is approved.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <ButtonLink href="/ingest" data-testid="empty-add-material">
              Add material
            </ButtonLink>
            <ButtonLink href="/" variant="secondary">
              Back to dashboard
            </ButtonLink>
          </div>
        </Card>
      </Shell>
    );
  }

  if (!step) return null;

  async function submit(concept: Concept, item: RetrievalItem, context: RetrievalContext, chunkId?: string) {
    const submitted = answer;
    await guard.current.run(async () => {
      setSubmitting(true);
      setGradeError(null);
      try {
        const outcome = await submitAnswer({
          curriculum: latest.current.curriculum,
          learner: latest.current.learner,
          attempt: { conceptId: concept.id, itemId: item.id, context, chunkId, now: new Date() },
          answer: submitted,
          transport: (request) => requestGrade(request),
          latest: snapshot,
        });
        if (!outcome.ok && outcome.reason === "STALE") {
          // Not applied, not an error to retry: the question moved on.
          setStale(true);
          syncFromStorage();
          return;
        }
        if (!outcome.ok) {
          // Nothing was recorded: no mastery, schedule or progress change.
          setGradeError({
            message: outcome.message,
            retryable: outcome.retryable,
            itemId: item.id,
          });
          return;
        }
        const { result } = outcome;
        latest.current = { curriculum: latest.current.curriculum, learner: result.learner };
        setLearner(result.learner);
        setFeedback({
          grade: result.grade,
          concept,
          item,
          context,
          remediation: outcome.remediation ?? "",
          stillWeak: result.grade.correct && result.progress.mastery === "WEAK",
        });
      } finally {
        setSubmitting(false);
      }
    });
  }

  function next() {
    setFeedback(null);
    setAnswer("");
    setGradeError(null);
  }

  function continueAfterStale() {
    setStale(false);
    setGradeError(null);
    setAnswer("");
    syncFromStorage();
  }

  /* ---------------- Stale grade view ---------------- */
  if (stale) {
    return (
      <Shell>
        <Card data-testid="grade-stale" role="alert">
          <h1 className="text-2xl font-bold text-ink-800">This question has moved on</h1>
          <p className="prose-teach mt-3 text-ink-600">{STALE_MESSAGE}</p>
          <div className="mt-6">
            <Button data-testid="grade-stale-continue" onClick={continueAfterStale}>
              Continue to the current question
            </Button>
          </div>
        </Card>
      </Shell>
    );
  }

  /* ---------------- Feedback view ---------------- */
  if (feedback && curriculum.concepts.some((c) => c.id === feedback.concept.id && c.status === "ACTIVE" && c.summary === feedback.concept.summary && c.title === feedback.concept.title)) {
    const { grade, concept, item, stillWeak } = feedback;
    const doc = curriculum.course.lectures
      .flatMap((l) => l.documents)
      .find((d) => d.id === concept.source.documentId);

    return (
      <Shell>
        <Card
          data-testid="feedback"
          data-concept-id={concept.id}
          data-mastery={stillWeak ? "WEAK" : masteryOf(concept.id)}
          className={grade.correct ? "border-emerald-300" : "border-red-300"}
        >
          <div className="flex flex-wrap items-center gap-3">
            <h1
              data-testid={grade.correct ? "feedback-correct" : "feedback-incorrect"}
              className={`text-2xl font-bold ${
                grade.correct ? "text-emerald-700" : "text-red-700"
              }`}
            >
              {grade.correct ? "Correct" : "Not quite"}
            </h1>
            <MasteryBadge state={stillWeak ? "WEAK" : masteryOf(concept.id)} />
          </div>

          <p className="mt-4 text-sm font-semibold uppercase tracking-wide text-ink-500">
            {concept.title}
          </p>

          <p className="prose-teach mt-3 text-ink-700">{item.explanation}</p>

          {!grade.correct && (
            <div
              data-testid="remediation"
              className="mt-5 rounded-xl border border-red-200 bg-red-50 p-5"
            >
              <h3 className="text-sm font-bold uppercase tracking-wide text-red-700">
                Re-teaching this now
              </h3>
              <p className="mt-2 whitespace-pre-line text-[0.95rem] leading-relaxed text-ink-700">
                {feedback.remediation}
              </p>
            </div>
          )}

          {stillWeak && (
            <p
              data-testid="weakness-note"
              className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-5 text-[0.95rem] leading-relaxed text-amber-900"
            >
              Right answer — but this concept stays <strong>WEAK</strong>.
              Answering correctly straight after reading the explanation is
              recognition, not recall. MedRecall will bring it back later, and
              getting it right then is what clears the weakness.
            </p>
          )}

          {doc && (
            <SourceRefLine
              documentTitle={doc.title}
              pageNumber={concept.source.pageNumber}
              excerpt={concept.source.excerpt}
            />
          )}

          <div className="mt-7">
            <Button data-testid="continue-button" onClick={next}>
              Continue
            </Button>
          </div>
        </Card>
      </Shell>
    );
  }

  function masteryOf(conceptId: string) {
    return learner.progress[conceptId]?.mastery ?? "NEW";
  }

  /* ---------------- Step views ---------------- */
  if (step.kind === "LECTURE_COMPLETE") {
    return (
      <Shell>
        <Card data-testid="step-complete">
          <h1 className="text-3xl font-bold text-ink-800">
            {step.lecture.title} complete
          </h1>
          <p className="prose-teach mt-3 text-ink-600">
            Every concept in this lecture has been taught and tested. Weak
            concepts stay in the queue and will be interleaved into later
            lectures until you retrieve them cleanly.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <ButtonLink href="/">Back to dashboard</ButtonLink>
          </div>
        </Card>
      </Shell>
    );
  }

  if (step.kind === "AWAITING_APPROVAL") {
    return (
      <Shell>
        <Card data-testid="step-awaiting-approval">
          <h1 className="text-2xl font-bold text-ink-800">
            Waiting on your review
          </h1>
          <p className="prose-teach mt-3 text-ink-600">
            {step.draftCount > 0 ? (
              <>
                This part of the lecture has{" "}
                <strong data-testid="awaiting-count">{step.draftCount}</strong>{" "}
                candidate concept{step.draftCount === 1 ? "" : "s"} still in
                draft. Nothing here can be taught, tested or scheduled until you
                approve it.
              </>
            ) : (
              <>
                Every candidate in this part was discarded, so there is nothing
                approved left to teach here.
              </>
            )}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <ButtonLink href="/concepts" data-testid="go-to-review">
              Review drafts
            </ButtonLink>
            <ButtonLink href="/" variant="secondary">
              Back to dashboard
            </ButtonLink>
          </div>
        </Card>
      </Shell>
    );
  }

  if (step.kind === "TEACH") {
    const lecture = curriculum.course.lectures.find((l) => l.id === lectureId)!;
    const pages = step.pages;
    const doc = lecture.documents.find((d) => d.id === step.chunk.documentId);
    return (
      <Shell>
        <Card data-testid="step-teach">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-clinical-600">
            {lecture.title} · Part {step.chunk.order}
          </p>
          <h1 className="mt-2 text-3xl font-bold text-ink-800">
            {step.chunk.title}
          </h1>

          <p className="prose-teach mt-5 whitespace-pre-line text-ink-700">{step.chunk.explanation}</p>

          <div className="mt-7 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-500">
              Approved source excerpts · {doc?.title}
            </h2>
            {pages.map((page) => (
              <article
                key={page.number}
                className="rounded-xl border border-ink-200 bg-ink-50 p-5"
              >
                <h3 className="text-sm font-bold text-ink-700">
                  Page {page.number} — {page.title}
                </h3>
                <p className="mt-2 text-[0.95rem] leading-relaxed text-ink-600">
                  {page.text}
                </p>
              </article>
            ))}
          </div>

          <div className="mt-7">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-500">
              Concepts in this part
            </h2>
            <ul className="mt-3 space-y-2">
              {step.concepts.map((concept) => (
                <li
                  key={concept.id}
                  data-testid="teach-concept"
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 px-4 py-3"
                >
                  <span className="font-semibold text-ink-700">
                    {concept.title}
                  </span>
                  <MasteryBadge state={masteryOf(concept.id)} />
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-8">
            <Button
              data-testid="teach-continue"
              onClick={() => setLearner(markChunkTaught(curriculum, learner, step.chunk.id))}
            >
              I&apos;ve read this — test me
            </Button>
          </div>
        </Card>
      </Shell>
    );
  }

  // RETRIEVE, REMEDIATE and INTERLEAVE all render a question.
  const testId =
    step.kind === "RETRIEVE"
      ? "step-retrieve"
      : step.kind === "REMEDIATE"
        ? "step-remediate"
        : "step-interleave";

  return (
    <Shell>
      <Card
        data-testid={testId}
        data-concept-id={step.concept.id}
        data-item-id={step.item.id}
      >
        {step.kind === "INTERLEAVE" && (
          <div
            data-testid="interleave-banner"
            className="mb-5 rounded-xl border border-clinical-200 bg-clinical-50 p-5"
          >
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-clinical-700">
              Recall from an earlier lecture
            </p>
            <p className="mt-2 text-[0.95rem] leading-relaxed text-clinical-900">
              Before new material: this concept from{" "}
              <strong>{step.fromLecture.title}</strong> is still weak or due.
            </p>
          </div>
        )}

        {step.kind === "REMEDIATE" && (
          <div
            data-testid="reteach-panel"
            className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-5"
          >
            <p className="text-xs font-bold uppercase tracking-[0.12em] text-amber-800">
              Re-teach before retrying
            </p>
            <p className="prose-teach mt-2 text-amber-950">
              {step.concept.summary}
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <p
            data-testid="concept-title"
            className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-500"
          >
            {step.concept.title}
          </p>
          <MasteryBadge state={masteryOf(step.concept.id)} />
          <span className="rounded-full border border-ink-200 px-3 py-1 text-xs font-semibold text-ink-500">
            {step.item.kind.replace("_", " ")}
          </span>
        </div>

        <h1 className="prose-teach mt-4 font-semibold text-ink-800">
          {step.item.prompt}
        </h1>

        <label htmlFor="answer" className="sr-only">
          Your answer
        </label>
        <textarea
          id="answer"
          data-testid="answer-input"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          maxLength={GRADE_REQUEST_LIMITS.maxAnswerChars}
          readOnly={submitting}
          rows={5}
          placeholder="Write what you remember, in your own words…"
          className="mt-5 w-full rounded-xl border border-ink-300 bg-white p-5 text-lg leading-relaxed text-ink-800 outline-none focus:border-clinical-500 focus:ring-2 focus:ring-clinical-200"
        />

        {gradeError && gradeError.itemId === step.item.id && (
          <div
            role="alert"
            data-testid="grade-error"
            className="mt-5 rounded-xl border border-red-200 bg-red-50 p-5 text-[0.95rem] leading-relaxed text-red-800"
          >
            <p>{gradeError.message}</p>
            {gradeError.retryable && (
              <div className="mt-4">
                <Button
                  data-testid="grade-retry"
                  variant="secondary"
                  disabled={submitting || answer.trim().length === 0}
                  onClick={() =>
                    submit(step.concept, step.item, step.context, step.chunk.id)
                  }
                >
                  Try again
                </Button>
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            data-testid="submit-answer"
            disabled={submitting || answer.trim().length === 0}
            aria-busy={submitting}
            onClick={() =>
              submit(step.concept, step.item, step.context, step.chunk.id)
            }
          >
            {submitting ? "Grading…" : "Submit answer"}
          </Button>
          <Link
            href="/"
            className="inline-flex min-h-[44px] items-center text-sm font-semibold text-ink-500 underline"
          >
            Save and exit
          </Link>
        </div>
      </Card>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
      <Link
        href="/"
        className="mb-6 inline-flex min-h-[44px] items-center text-sm font-bold uppercase tracking-[0.12em] text-clinical-700"
      >
        MedRecall
      </Link>
      {children}
    </main>
  );
}
