"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useLearner } from "./LearnerProvider";
import { Button, ButtonLink, Card, MasteryBadge, SourceRefLine } from "./ui";
import {
  getNextStep,
  isLectureUnlocked,
  markChunkTaught,
  pagesForChunk,
  recordAttempt,
  type SessionStep,
} from "@/lib/engine/tutor";
import { DeterministicProvider } from "@/lib/ai";
import type { Concept, RetrievalItem, RetrievalContext } from "@/lib/domain/types";
import type { GradeResult } from "@/lib/grading";

const provider = new DeterministicProvider();

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
  const { curriculum, learner, setLearner, ready } = useLearner();
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const unlocked = ready && isLectureUnlocked(curriculum, learner, lectureId);

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
          <h1 className="text-2xl font-bold text-ink-800">Lecture locked</h1>
          <p className="prose-teach mt-3 text-ink-600">
            Finish the previous lecture before starting this one. MedRecall
            unlocks material in order so prerequisites are in place first.
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
    const result = recordAttempt(curriculum, learner, {
      conceptId: concept.id,
      itemId: item.id,
      answer,
      context,
      chunkId,
      now: new Date(),
    });
    const remediation = await provider.generateRemediation({
      concept,
      item,
      grade: result.grade,
      learnerAnswer: answer,
    });
    setLearner(result.learner);
    setFeedback({
      grade: result.grade,
      concept,
      item,
      context,
      remediation,
      stillWeak: result.grade.correct && result.progress.mastery === "WEAK",
    });
  }

  function next() {
    setFeedback(null);
    setAnswer("");
  }

  /* ---------------- Feedback view ---------------- */
  if (feedback) {
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

  if (step.kind === "TEACH") {
    const lecture = curriculum.course.lectures.find((l) => l.id === lectureId)!;
    const pages = pagesForChunk(lecture, step.chunk);
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

          <p className="prose-teach mt-5 text-ink-700">{step.chunk.explanation}</p>

          <div className="mt-7 space-y-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-ink-500">
              From the source · {doc?.title}
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
          rows={5}
          placeholder="Write what you remember, in your own words…"
          className="mt-5 w-full rounded-xl border border-ink-300 bg-white p-5 text-lg leading-relaxed text-ink-800 outline-none focus:border-clinical-500 focus:ring-2 focus:ring-clinical-200"
        />

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            data-testid="submit-answer"
            disabled={answer.trim().length === 0}
            onClick={() =>
              submit(step.concept, step.item, step.context, step.chunk.id)
            }
          >
            Submit answer
          </Button>
          <Link href="/" className="text-sm font-semibold text-ink-500 underline">
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
        className="mb-6 inline-block text-sm font-bold uppercase tracking-[0.12em] text-clinical-700"
      >
        MedRecall
      </Link>
      {children}
    </main>
  );
}
