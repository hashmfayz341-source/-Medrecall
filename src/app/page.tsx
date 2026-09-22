"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useLearner } from "@/components/LearnerProvider";
import { Button, ButtonLink, Card, MasteryBadge, SectionTitle, Stat } from "@/components/ui";
import { buildTodayQueue, weakConcepts } from "@/lib/engine/priority";
import { nextLecture, summarizeLectures } from "@/lib/engine/tutor";
import { draftConcepts } from "@/lib/domain/curriculum";

export default function Dashboard() {
  const { curriculum, learner, ready, resetAll } = useLearner();

  const view = useMemo(() => {
    const now = new Date();
    return {
      lectures: summarizeLectures(curriculum, learner),
      continueWith: nextLecture(curriculum, learner),
      due: buildTodayQueue(curriculum, learner, now),
      weak: weakConcepts(curriculum, learner),
      drafts: draftConcepts(curriculum),
    };
  }, [curriculum, learner]);

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-12">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.12em] text-clinical-700">
            MedRecall
          </p>
          <h1 className="mt-1 text-4xl font-bold tracking-tight text-ink-800">
            {curriculum.course.title}
          </h1>
          <p className="mt-2 max-w-xl text-ink-600">
            {curriculum.course.description}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
        <Link
          href="/ingest"
          data-testid="add-material-link"
          className="min-h-[3rem] rounded-xl border border-ink-300 bg-white px-5 py-3 text-sm font-semibold text-ink-700"
        >
          Add material
        </Link>
        <Link
          href="/concepts"
          data-testid="review-drafts-link"
          className="min-h-[3rem] rounded-xl border border-ink-300 bg-white px-5 py-3 text-sm font-semibold text-ink-700"
        >
          Review drafts
          {view.drafts.length > 0 && (
            <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">
              {view.drafts.length}
            </span>
          )}
        </Link>
        </div>
      </header>

      {!ready ? (
        <p className="mt-10 text-ink-500">Loading your progress…</p>
      ) : (
        <div className="mt-10 space-y-8">
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label="Due recall" value={view.due.length} />
            <Stat
              label="Weak concepts"
              value={view.weak.length}
              tone={view.weak.length > 0 ? "warn" : "default"}
            />
            <Stat
              label="Lectures done"
              value={`${learner.completedLectureIds.length}/${curriculum.course.lectures.length}`}
            />
            <Stat label="Drafts awaiting review" value={view.drafts.length} />
          </div>

          {/* Continue Learning */}
          <Card data-testid="continue-learning">
            <SectionTitle>Continue learning</SectionTitle>
            {view.continueWith ? (
              <>
                <h2 className="mt-2 text-2xl font-bold text-ink-800">
                  {view.continueWith.title}
                </h2>
                <p className="mt-2 text-ink-600">
                  MedRecall picks what comes next — new material, a weak concept
                  from an earlier lecture, or a scheduled review.
                </p>
                <div className="mt-6">
                  <ButtonLink
                    href={`/learn/${view.continueWith.id}`}
                    data-testid="continue-button"
                  >
                    Continue {view.continueWith.title}
                  </ButtonLink>
                </div>
              </>
            ) : (
              <p className="mt-2 text-ink-600">Nothing available yet.</p>
            )}
          </Card>

          {/* Lectures */}
          <Card>
            <SectionTitle>Lectures</SectionTitle>
            <ul className="mt-4 space-y-3">
              {view.lectures.map((summary) => (
                <li
                  key={summary.lecture.id}
                  data-testid={`lecture-${summary.lecture.id}`}
                  className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ink-200 px-5 py-4"
                >
                  <div>
                    <p className="text-lg font-semibold text-ink-800">
                      {summary.lecture.order}. {summary.lecture.title}
                    </p>
                    <p className="mt-1 text-sm text-ink-500">
                      {summary.attemptedConcepts}/{summary.totalConcepts} concepts
                      started
                      {summary.weakConcepts > 0 && (
                        <span className="text-red-600">
                          {" "}
                          · {summary.weakConcepts} weak
                        </span>
                      )}
                    </p>
                  </div>
                  {summary.complete ? (
                    <span
                      data-testid={`complete-${summary.lecture.id}`}
                      className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-2 text-xs font-bold uppercase tracking-wide text-emerald-700"
                    >
                      Complete
                    </span>
                  ) : summary.unlocked ? (
                    <ButtonLink
                      href={`/learn/${summary.lecture.id}`}
                      variant="secondary"
                      data-testid={`start-${summary.lecture.id}`}
                    >
                      {summary.attemptedConcepts > 0 ? "Resume" : "Start"}
                    </ButtonLink>
                  ) : (
                    <span
                      data-testid={`locked-${summary.lecture.id}`}
                      className="rounded-full border border-ink-200 bg-ink-100 px-4 py-2 text-xs font-bold uppercase tracking-wide text-ink-500"
                    >
                      Locked
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </Card>

          <div className="grid gap-8 lg:grid-cols-2">
            {/* Due recall */}
            <Card data-testid="due-recall">
              <SectionTitle>Due recall</SectionTitle>
              {view.due.length === 0 ? (
                <p className="mt-3 text-ink-500">
                  Nothing due. Reviews appear here when FSRS schedules them.
                </p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {view.due.slice(0, 6).map(({ concept, progress }) => (
                    <li
                      key={concept.id}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-200 px-4 py-3"
                    >
                      <span className="font-medium text-ink-700">
                        {concept.title}
                      </span>
                      <MasteryBadge state={progress.mastery} />
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* Weak concepts */}
            <Card data-testid="weak-concepts">
              <SectionTitle>Weak concepts</SectionTitle>
              {view.weak.length === 0 ? (
                <p className="mt-3 text-ink-500">No weak concepts right now.</p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {view.weak.map(({ concept }) => (
                    <li
                      key={concept.id}
                      data-testid={`weak-${concept.id}`}
                      className="rounded-xl border border-red-200 bg-red-50 px-4 py-3"
                    >
                      <p className="font-semibold text-ink-800">{concept.title}</p>
                      <p className="mt-1 text-sm text-ink-600">
                        From{" "}
                        {
                          curriculum.course.lectures.find(
                            (l) => l.id === concept.lectureId,
                          )?.title
                        }
                        {" · will be interleaved into later material"}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <div className="pt-2">
            <Button variant="danger" data-testid="reset-demo" onClick={resetAll}>
              Reset demo progress
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
