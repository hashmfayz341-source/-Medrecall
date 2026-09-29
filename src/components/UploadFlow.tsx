"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useLearner } from "./LearnerProvider";
import { Button, ButtonLink, Card, SectionTitle } from "./ui";
import { ArabicCoverageNote, CountPicker, LanguagePicker } from "./GenerationOptions";
import { buildChunks, toSourceDocument } from "@/lib/ingestion/extractor";
import { nextLectureOrder } from "@/lib/domain/curriculum";
import { lectureIdFor, titleFromFileName } from "@/lib/domain/titles";
import { existingCardsOf, parseCount, requestCards } from "@/lib/generation/client";
import { PdfReadError, readLecturePdf, type ReadPdf } from "@/lib/generation/upload";
import type { CardLanguage, Lecture } from "@/lib/domain/types";

/*
 * The primary MedRecall flow: upload a lecture PDF → choose language and
 * card count → generate → review → study.
 *
 * Text extraction runs on the server (/api/ingest), page rendering in the
 * browser (the file is already here, and the images stay on the device),
 * card generation behind /api/generate. Everything is stored in ONE commit
 * at the end, so an interrupted upload leaves nothing half-made.
 */


type Stage = "idle" | "reading" | "visuals" | "generating" | "checking" | "done" | "error";

interface Progress {
  stage: Stage;
  message: string;
  done?: number;
  total?: number;
}

export function UploadFlow() {
  const { curriculum, ready, storeLectureUpload, lectureSettings } = useLearner();
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const lastLanguage = useMemo<CardLanguage>(() => {
    const languages = Object.values(lectureSettings).map((s) => s.language);
    return languages[languages.length - 1] ?? "en";
  }, [lectureSettings]);
  const [language, setLanguage] = useState<CardLanguage | null>(null);
  const [countChoice, setCountChoice] = useState("40");
  const [customCount, setCustomCount] = useState("150");
  const [progress, setProgress] = useState<Progress>({ stage: "idle", message: "" });
  const [result, setResult] = useState<{
    lectureId: string;
    produced: number;
    requested: string;
    shortfall: number;
    figures: number;
    visualsFailed: boolean;
    coverage: { arabic: number; partial: number };
    language: CardLanguage;
  } | null>(null);

  const chosenLanguage = language ?? lastLanguage;
  const count = parseCount(countChoice, customCount);
  const running = progress.stage !== "idle" && progress.stage !== "done" && progress.stage !== "error";

  function onFileChange() {
    const file = fileRef.current?.files?.[0] ?? null;
    setFileName(file?.name ?? null);
    if (file) setTitle(titleFromFileName(file.name));
    setResult(null);
    setProgress({ stage: "idle", message: "" });
  }

  async function generate() {
    const file = fileRef.current?.files?.[0];
    if (!file) return setProgress({ stage: "error", message: "Choose a PDF first." });
    const lectureTitle = title.trim();
    if (!lectureTitle) return setProgress({ stage: "error", message: "Give the lecture a title." });
    if (count === null) return setProgress({ stage: "error", message: "Enter a whole number of cards (1 to 500), or choose Auto." });

    const lecture: Lecture = {
      id: lectureIdFor(lectureTitle),
      courseId: curriculum.course.id,
      title: lectureTitle,
      order: nextLectureOrder(curriculum),
      documents: [],
      chunks: [],
    };

    try {
      let read: ReadPdf;
      try {
        read = await readLecturePdf(file, { courseId: curriculum.course.id, lectureId: lecture.id }, (p) =>
          setProgress(
            p.stage === "reading"
              ? { stage: "reading", message: "Reading the lecture…" }
              : { stage: "visuals", message: "Extracting visual material…", done: p.done, total: p.total },
          ),
        );
      } catch (cause) {
        setProgress({ stage: "error", message: cause instanceof PdfReadError ? cause.message : "Could not read the PDF." });
        return;
      }
      const { extracted, visuals, visualsFailed, figures } = read;

      setProgress({ stage: "generating", message: "Generating cards…" });
      const generated = await requestCards({
        courseId: curriculum.course.id,
        lectureId: lecture.id,
        documents: [{ id: extracted.id, title: extracted.title, pages: extracted.pages, visuals }],
        language: chosenLanguage,
        count,
        existing: existingCardsOf(curriculum, lecture.id),
      });

      setProgress({ stage: "checking", message: "Checking duplicates…" });
      const chunks = buildChunks(extracted, lecture.id, generated.concepts, 0);
      storeLectureUpload({
        lecture,
        ingested: {
          lectureId: lecture.id,
          document: toSourceDocument(extracted, lecture.id),
          chunks,
          ingestedAt: new Date().toISOString(),
          visuals,
        },
        concepts: generated.concepts,
        language: chosenLanguage,
      });
      setResult({
        lectureId: lecture.id,
        produced: generated.concepts.length,
        requested: count === "auto" ? "auto" : String(count),
        shortfall: generated.shortfall,
        figures,
        visualsFailed,
        coverage: generated.coverage,
        language: chosenLanguage,
      });
      setProgress({ stage: "done", message: `Ready — ${generated.concepts.length} ${generated.concepts.length === 1 ? "card" : "cards"}.` });
    } catch {
      setProgress({ stage: "error", message: "Could not reach MedRecall's servers. Check your connection and try again." });
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8 sm:py-12">
      <Link href="/" className="mb-6 inline-flex min-h-[44px] items-center text-sm font-bold uppercase tracking-[0.12em] text-clinical-700">
        MedRecall
      </Link>
      <h1 className="text-3xl font-bold tracking-tight text-ink-800">Upload a lecture</h1>
      <p className="mt-2 max-w-2xl text-ink-600">
        MedRecall reads the PDF, keeps its pages and figures, and generates flashcards from what the
        lecture actually says. You review them, then study.
      </p>

      {!ready ? (
        <p className="mt-8 text-ink-500">Loading…</p>
      ) : (
        <div className="mt-8 space-y-6">
          <Card data-testid="upload-step">
            <SectionTitle>1 · Lecture PDF</SectionTitle>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              data-testid="upload-file"
              onChange={onFileChange}
              disabled={running}
              className="mt-4 block w-full text-base text-ink-700 file:mr-4 file:min-h-[3rem] file:rounded-xl file:border-0 file:bg-clinical-600 file:px-6 file:text-base file:font-semibold file:text-white"
            />
            {fileName && (
              <div className="mt-5">
                <label htmlFor="lecture-title" className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Lecture title
                </label>
                <input
                  id="lecture-title"
                  data-testid="lecture-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  disabled={running}
                  dir="auto"
                  className="mt-2 min-h-[3.25rem] w-full rounded-xl border border-ink-300 bg-white px-4 text-lg font-semibold text-ink-800"
                />
              </div>
            )}
          </Card>

          <Card data-testid="options-step">
            <SectionTitle>2 · Cards</SectionTitle>
            <LanguagePicker value={chosenLanguage} onChange={setLanguage} disabled={running} prefix="lang" />
            <CountPicker choice={countChoice} custom={customCount} onChoice={setCountChoice} onCustom={setCustomCount} disabled={running} prefix="count" />
          </Card>

          <Card data-testid="generate-step">
            <SectionTitle>3 · Generate</SectionTitle>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <Button data-testid="generate-button" onClick={generate} disabled={running || !fileName || progress.stage === "done"}>
                {running ? "Working…" : "Generate flashcards"}
              </Button>
              <p className="text-sm text-ink-500">Cards are drafts until you approve them. Nothing is invented: every card cites its page.</p>
            </div>

            {running && (
              <div data-testid="progress" data-stage={progress.stage} role="status" className="mt-5 rounded-xl border border-clinical-200 bg-clinical-50 p-4 text-clinical-800">
                <p className="font-semibold">{progress.message}</p>
                {progress.total !== undefined && progress.total > 0 && (
                  <p className="mt-1 text-sm tabular-nums" data-testid="progress-count">
                    {progress.done ?? 0} / {progress.total} pages
                  </p>
                )}
                <ol className="mt-3 flex flex-wrap gap-3 text-xs text-clinical-700">
                  {(["reading", "visuals", "generating", "checking"] as const).map((stage) => (
                    <li key={stage} className={stage === progress.stage ? "font-bold" : "opacity-60"}>
                      {{ reading: "Reading", visuals: "Visual material", generating: "Generating", checking: "Duplicates" }[stage]}
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {progress.stage === "error" && (
              <p data-testid="upload-error" role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-4 text-[0.95rem] text-red-700">
                {progress.message}
              </p>
            )}

            {progress.stage === "done" && result && (
              <div
                data-testid="generation-done"
                data-lecture-id={result.lectureId}
                data-produced={result.produced}
                data-shortfall={result.shortfall}
                data-figures={result.figures}
                data-arabic={result.coverage.arabic}
                data-partial={result.coverage.partial}
                className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-5"
              >
                <p className="text-lg font-bold text-emerald-900">{progress.message}</p>
                <p className="mt-1 text-sm text-emerald-900">
                  {result.figures > 0
                    ? `${result.figures} ${result.figures === 1 ? "figure" : "figures"} from the PDF kept for visual cards.`
                    : result.visualsFailed
                      ? "Page images could not be rendered in this browser; cards were made from the text."
                      : "No usable figures were found in this PDF; cards were made from the text."}
                </p>
                <ArabicCoverageNote language={result.language} coverage={result.coverage} testId="coverage-note" />
                {result.shortfall > 0 && (
                  <p data-testid="shortfall-note" className="mt-2 text-sm text-emerald-900">
                    You asked for {result.requested}; this lecture supports {result.produced} distinct cards without repeating facts.
                  </p>
                )}
                <div className="mt-4 flex flex-wrap gap-3">
                  <ButtonLink href={`/lectures/${encodeURIComponent(result.lectureId)}?review=1`} data-testid="review-cards-link">
                    Review {result.produced} cards
                  </ButtonLink>
                </div>
              </div>
            )}
          </Card>

          <p className="text-sm text-ink-500">
            Adding a PDF to an existing lecture, or the guided Tutor? Use{" "}
            <Link href="/ingest" className="inline-flex min-h-[44px] items-center font-semibold text-clinical-700" data-testid="advanced-ingest-link">
              Add material
            </Link>
            .
          </p>
        </div>
      )}
    </main>
  );
}
