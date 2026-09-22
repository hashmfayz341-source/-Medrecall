"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useLearner } from "@/components/LearnerProvider";
import { Button, ButtonLink, Card, SectionTitle } from "@/components/ui";
import { buildChunks, toSourceDocument } from "@/lib/ingestion/extractor";
import { chunkOrderOffset, nextLectureOrder } from "@/lib/domain/curriculum";
import type { Concept, Lecture, Page } from "@/lib/domain/types";

interface IngestResponse {
  document: { id: string; title: string; lectureId: string; pageCount: number; pages: Page[] };
  concepts: Concept[];
  stats: { pages: number; pagesWithText: number; candidates: number; draft: number };
}

type Status =
  | { kind: "idle" }
  | { kind: "working"; message: string }
  | { kind: "done"; result: IngestResponse }
  | { kind: "error"; message: string };

export default function IngestPage() {
  const {
    curriculum,
    ready,
    createLecture,
    storeIngestedDocument,
  } = useLearner();

  const [lectureId, setLectureId] = useState("");
  const [newLectureTitle, setNewLectureTitle] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const fileRef = useRef<HTMLInputElement>(null);

  const lectures = useMemo(
    () => [...curriculum.course.lectures].sort((a, b) => a.order - b.order),
    [curriculum],
  );

  const selectedLectureId = lectureId || lectures[0]?.id || "";

  function handleCreateLecture() {
    const title = newLectureTitle.trim();
    if (!title) return;
    const lecture: Lecture = {
      id: `lecture-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`,
      courseId: curriculum.course.id,
      title,
      order: nextLectureOrder(curriculum),
      documents: [],
      chunks: [],
    };
    createLecture(lecture);
    setLectureId(lecture.id);
    setNewLectureTitle("");
  }

  async function handleUpload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setStatus({ kind: "error", message: "Choose a PDF first." });
      return;
    }
    if (!selectedLectureId) {
      setStatus({ kind: "error", message: "Choose a lecture first." });
      return;
    }

    setStatus({ kind: "working", message: `Extracting text from ${file.name}…` });

    const body = new FormData();
    body.set("file", file);
    body.set("courseId", curriculum.course.id);
    body.set("lectureId", selectedLectureId);

    try {
      const response = await fetch("/api/ingest", { method: "POST", body });
      const payload: unknown = await response.json();

      if (!response.ok) {
        const message =
          typeof payload === "object" && payload !== null && "error" in payload
            ? String((payload as { error: unknown }).error)
            : "Extraction failed.";
        setStatus({ kind: "error", message });
        return;
      }

      const result = payload as IngestResponse;
      const extracted = {
        id: result.document.id,
        title: result.document.title,
        pageCount: result.document.pageCount,
        pages: result.document.pages,
      };

      // Chunks are built client-side because the offset depends on what the
      // lecture already contains.
      const chunks = buildChunks(
        extracted,
        selectedLectureId,
        result.concepts,
        chunkOrderOffset(curriculum, selectedLectureId),
      );

      storeIngestedDocument(
        {
          lectureId: selectedLectureId,
          document: toSourceDocument(extracted, selectedLectureId),
          chunks,
          ingestedAt: new Date().toISOString(),
        },
        result.concepts,
      );

      setStatus({ kind: "done", result });
    } catch {
      setStatus({ kind: "error", message: "Could not reach the extraction service." });
    }
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
      <Link
        href="/"
        className="mb-6 inline-flex min-h-[44px] items-center text-sm font-bold uppercase tracking-[0.12em] text-clinical-700"
      >
        MedRecall
      </Link>

      <h1 className="text-3xl font-bold tracking-tight text-ink-800">Add material</h1>
      <p className="mt-2 max-w-2xl text-ink-600">
        Upload a PDF for a lecture. MedRecall extracts the text page by page and
        proposes candidate concepts. Nothing is taught until you review and
        approve them.
      </p>

      {!ready ? (
        <p className="mt-8 text-ink-500">Loading…</p>
      ) : (
        <div className="mt-8 space-y-6">
          <Card data-testid="lecture-picker">
            <SectionTitle>1 · Choose a lecture</SectionTitle>
            <label htmlFor="lecture" className="sr-only">
              Lecture
            </label>
            <select
              id="lecture"
              data-testid="lecture-select"
              value={selectedLectureId}
              onChange={(e) => setLectureId(e.target.value)}
              className="mt-3 min-h-[3.25rem] w-full rounded-xl border border-ink-300 bg-white px-4 text-base text-ink-800"
            >
              {lectures.map((lecture) => (
                <option key={lecture.id} value={lecture.id}>
                  {lecture.order}. {lecture.title}
                </option>
              ))}
            </select>

            <div className="mt-5 flex flex-wrap items-end gap-3">
              <div className="min-w-[14rem] flex-1">
                <label
                  htmlFor="new-lecture"
                  className="text-xs font-semibold uppercase tracking-wide text-ink-500"
                >
                  Or create a new lecture
                </label>
                <input
                  id="new-lecture"
                  data-testid="new-lecture-title"
                  value={newLectureTitle}
                  onChange={(e) => setNewLectureTitle(e.target.value)}
                  placeholder="e.g. Neoplasia"
                  className="mt-2 min-h-[3.25rem] w-full rounded-xl border border-ink-300 bg-white px-4 text-base text-ink-800"
                />
              </div>
              <Button
                variant="secondary"
                data-testid="create-lecture"
                disabled={newLectureTitle.trim().length === 0}
                onClick={handleCreateLecture}
              >
                Create lecture
              </Button>
            </div>
          </Card>

          <Card data-testid="upload-panel">
            <SectionTitle>2 · Upload a PDF</SectionTitle>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              data-testid="pdf-input"
              className="mt-4 block w-full text-base text-ink-700 file:mr-4 file:min-h-[3rem] file:rounded-xl file:border-0 file:bg-clinical-600 file:px-6 file:text-base file:font-semibold file:text-white"
            />
            <div className="mt-5">
              <Button
                data-testid="extract-button"
                disabled={status.kind === "working"}
                onClick={handleUpload}
              >
                {status.kind === "working" ? "Extracting…" : "Extract concepts"}
              </Button>
            </div>

            {status.kind === "error" && (
              <p
                data-testid="ingest-error"
                className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-[0.95rem] text-red-700"
              >
                {status.message}
              </p>
            )}
            {status.kind === "working" && (
              <p className="mt-5 text-ink-500">{status.message}</p>
            )}
          </Card>

          {status.kind === "done" && (
            <Card
              data-testid="ingest-result"
              data-document-id={status.result.document.id}
              className="border-clinical-300"
            >
              <SectionTitle>3 · Review the candidates</SectionTitle>
              <h2 className="mt-2 text-2xl font-bold text-ink-800">
                {status.result.document.title}
              </h2>
              <dl className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Pages
                  </dt>
                  <dd data-testid="stat-pages" className="text-2xl font-bold tabular-nums">
                    {status.result.stats.pages}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Candidates
                  </dt>
                  <dd
                    data-testid="stat-candidates"
                    className="text-2xl font-bold tabular-nums"
                  >
                    {status.result.stats.candidates}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                    Draft
                  </dt>
                  <dd data-testid="stat-draft" className="text-2xl font-bold tabular-nums">
                    {status.result.stats.draft}
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-ink-600">
                Every candidate is a <strong>DRAFT</strong>. None of them can be
                taught, tested or scheduled until you approve them.
              </p>
              <div className="mt-6">
                <ButtonLink
                  href={`/concepts?document=${encodeURIComponent(status.result.document.id)}`}
                  data-testid="go-review"
                >
                  Review {status.result.stats.draft} drafts
                </ButtonLink>
              </div>
            </Card>
          )}
        </div>
      )}
    </main>
  );
}
