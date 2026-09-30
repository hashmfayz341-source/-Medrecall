"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useLearner } from "./LearnerProvider";
import { Button, ButtonLink, Card, SectionTitle } from "./ui";
import { CardImage } from "./CardImage";
import { ArabicCoverageNote, CountPicker, LanguagePicker } from "./GenerationOptions";
import { useStudySettings } from "./useStudySettings";
import { pathologyCurriculum } from "@/lib/content/pathology";
import { DEFAULT_CARD_LANGUAGE, chunkOrderOffset } from "@/lib/domain/curriculum";
import { buildChunks, toSourceDocument } from "@/lib/ingestion/extractor";
import { PdfReadError, readLecturePdf } from "@/lib/generation/upload";
import { buildStudyQueue, studyCardsForLecture } from "@/lib/engine/study";
import { eligibleOldReviews } from "@/lib/engine/session";
import { existingCardsOf, parseCount, requestCards, shortfallReasonText } from "@/lib/generation/client";
import type { GeneratedCards } from "@/lib/generation/generate";
import { pageAssetId } from "@/lib/visuals/analyze";
import type { CardLanguage, Concept, ConceptStatus, RetrievalKind } from "@/lib/domain/types";
import { displayExcerpt } from "@/lib/domain/text";

/*
 * One lecture: its cards to review, edit, approve or discard; Study; the
 * source PDF's pages; and "Generate more". The internal Concept lifecycle
 * (DRAFT → ACTIVE / DISCARDED) is exactly what runs underneath — a card is
 * its concept's retrieval item — but the screen speaks in cards.
 */

const KIND_LABEL: Record<RetrievalKind, string> = {
  BASIC: "Basic",
  CLOZE: "Cloze",
  MECHANISM: "Mechanism",
  FREE_RECALL: "Recall",
  CLINICAL: "Clinical",
  IMAGE: "Image",
};

type Filter = ConceptStatus | "ALL";
const STATUS_LABEL: Record<ConceptStatus, string> = { DRAFT: "To review", ACTIVE: "Approved", DISCARDED: "Discarded" };
const STATUS_TONE: Record<ConceptStatus, string> = {
  DRAFT: "bg-amber-50 text-amber-800 border-amber-200",
  ACTIVE: "bg-emerald-50 text-emerald-800 border-emerald-200",
  DISCARDED: "bg-ink-100 text-ink-600 border-ink-200",
};

export function LectureView({ lectureId }: { lectureId: string }) {
  const {
    curriculum,
    learner,
    ready,
    updateConceptStatus,
    updateConceptStatuses,
    updateCardText,
    appendGeneratedConcepts,
    storeIngestedDocument,
    renameUserLecture,
    setLectureCardLanguage,
    lectureSettings,
    ingested,
  } = useLearner();
  const { limits } = useStudySettings();
  const params = useSearchParams();
  const lecture = curriculum.course.lectures.find((l) => l.id === lectureId) ?? null;
  const isUserLecture = !pathologyCurriculum.course.lectures.some((l) => l.id === lectureId);
  const concepts = useMemo(() => curriculum.concepts.filter((c) => c.lectureId === lectureId), [curriculum, lectureId]);
  const drafts = concepts.filter((c) => c.status === "DRAFT");

  const [filter, setFilter] = useState<Filter>(() => (params.get("review") ? "DRAFT" : "ALL"));
  const [editing, setEditing] = useState<{ id: string; prompt: string; explanation: string } | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [moreLanguage, setMoreLanguage] = useState<CardLanguage | null>(null);
  const [moreChoice, setMoreChoice] = useState("20");
  const [moreCustom, setMoreCustom] = useState("30");
  const [moreState, setMoreState] = useState<
    | { kind: "idle" }
    | { kind: "working" }
    | { kind: "done"; produced: number; shortfall: number; shortfallReason: GeneratedCards["shortfallReason"]; coverage: { arabic: number; partial: number }; language: CardLanguage }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  /** Which lecture material Generate more reads: every document ("all"), or one. */
  const [moreSource, setMoreSource] = useState<string>("all");
  const [showAdd, setShowAdd] = useState(false);
  const [addState, setAddState] = useState<
    | { kind: "idle" }
    | { kind: "working"; message: string }
    | { kind: "done"; title: string; pages: number; documentId: string; figures: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Once the drafts are all decided, the review filter shows everything.
  const effectiveFilter: Filter = filter === "DRAFT" && concepts.length > 0 && drafts.length === 0 ? "ALL" : filter;

  const stats = useMemo(() => {
    if (!lecture) return null;
    const now = new Date();
    const queue = buildStudyQueue(curriculum, learner, lecture.id, now, { limits });
    const due = eligibleOldReviews(curriculum, learner, "__none__", now).filter((r) => r.lecture.id === lecture.id && r.reason !== "near").length;
    return { total: studyCardsForLecture(curriculum, lecture.id).length, counts: queue.counts, due };
  }, [curriculum, learner, lecture, limits]);

  const language: CardLanguage = lectureSettings[lectureId]?.language ?? DEFAULT_CARD_LANGUAGE;
  const documents = lecture?.documents ?? [];
  const visible = concepts.filter((c) => effectiveFilter === "ALL" || c.status === effectiveFilter);

  if (!ready) {
    return (
      <Shell>
        <p className="text-ink-500">Loading…</p>
      </Shell>
    );
  }
  if (!lecture) {
    return (
      <Shell>
        <Card>
          <h1 className="text-2xl font-bold text-ink-800">Lecture not found</h1>
          <p className="mt-2 text-ink-600">This lecture is not available in this browser.</p>
          <div className="mt-6">
            <ButtonLink href="/" variant="secondary">Back to my lectures</ButtonLink>
          </div>
        </Card>
      </Shell>
    );
  }

  function saveTitle() {
    if (titleDraft !== null && titleDraft.trim()) renameUserLecture(lectureId, titleDraft);
    setTitleDraft(null);
  }

  function startEdit(concept: Concept) {
    const item = concept.retrievalItems[0]!;
    setEditing({ id: concept.id, prompt: item.prompt, explanation: item.explanation });
  }

  function saveEdit(concept: Concept) {
    if (!editing || editing.id !== concept.id) return;
    const prompt = editing.prompt.trim();
    const explanation = editing.explanation.trim();
    if (!prompt || !explanation) return;
    updateCardText(concept.retrievalItems[0]!.id, { prompt, explanation });
    setEditing(null);
  }

  async function generateMore() {
    // The chosen document, or every document of the lecture. Duplicates are
    // avoided across the whole lecture either way (`existing` is lecture-wide).
    const sources = moreSource === "all" ? documents : documents.filter((d) => d.id === moreSource);
    const count = parseCount(moreChoice, moreCustom);
    if (sources.length === 0) return setMoreState({ kind: "error", message: "This lecture has no uploaded PDF to generate from." });
    if (count === null) return setMoreState({ kind: "error", message: "Enter a whole number of cards (1 to 500), or choose Auto." });
    const chosen = moreLanguage ?? language;
    setMoreState({ kind: "working" });
    try {
      const generated = await requestCards({
        courseId: curriculum.course.id,
        lectureId,
        documents: sources.map((document) => ({
          id: document.id,
          title: document.title,
          pages: document.pages,
          // Figure metadata stored with the upload (older uploads have none).
          visuals: ingested.find((entry) => entry.document.id === document.id)?.visuals ?? [],
        })),
        language: chosen,
        count,
        existing: existingCardsOf(curriculum, lectureId),
      });
      appendGeneratedConcepts(sources.map((d) => d.id), generated.concepts);
      if (chosen !== language) setLectureCardLanguage(lectureId, chosen);
      setMoreState({ kind: "done", produced: generated.concepts.length, shortfall: generated.shortfall, shortfallReason: generated.shortfallReason ?? null, coverage: generated.coverage, language: chosen });
      if (generated.concepts.length > 0) setFilter("DRAFT");
    } catch (cause) {
      setMoreState({ kind: "error", message: cause instanceof Error ? cause.message : "Card generation failed." });
    }
  }

  /** Add another PDF to this lecture: read and store it; its cards come from Generate more. */
  async function addPdf(file: File | undefined) {
    if (!file || !lecture) return setAddState({ kind: "error", message: "Choose a PDF first." });
    setAddState({ kind: "working", message: "Reading the PDF…" });
    try {
      const read = await readLecturePdf(file, { courseId: curriculum.course.id, lectureId }, (p) =>
        setAddState({ kind: "working", message: p.stage === "reading" ? "Reading the PDF…" : `Extracting visual material… ${p.done} / ${p.total} pages` }),
      );
      storeIngestedDocument(
        {
          lectureId,
          document: toSourceDocument(read.extracted, lectureId),
          chunks: buildChunks(read.extracted, lectureId, [], chunkOrderOffset(curriculum, lectureId)),
          ingestedAt: new Date().toISOString(),
          visuals: read.visuals,
        },
        [],
      );
      setAddState({ kind: "done", title: read.extracted.title, pages: read.extracted.pageCount, documentId: read.extracted.id, figures: read.figures });
      // Generate more now points at the new document.
      setMoreSource(read.extracted.id);
      setShowMore(true);
    } catch (cause) {
      setAddState({ kind: "error", message: cause instanceof PdfReadError ? cause.message : "Could not read the PDF." });
    }
  }

  return (
    <Shell>
      <div data-testid="lecture-view" data-lecture-id={lecture.id}>
        {/*
          The title keeps a readable column (at least 24rem, the whole row when
          the actions do not fit beside it): the actions wrap onto their own
          line below instead of overlapping a long lecture title.
        */}
        <header data-testid="lecture-header" className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div data-testid="lecture-title-block" className="min-w-0 flex-[1_1_24rem]">
            {titleDraft === null ? (
              <h1 dir="auto" data-testid="lecture-heading" className="text-3xl font-bold tracking-tight text-ink-800 [overflow-wrap:anywhere]">
                {lecture.title}
              </h1>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  data-testid="lecture-title-input"
                  value={titleDraft}
                  dir="auto"
                  onChange={(e) => setTitleDraft(e.target.value)}
                  className="min-h-[3.25rem] min-w-[16rem] flex-1 rounded-xl border border-ink-300 bg-white px-4 text-2xl font-bold text-ink-800"
                />
                <Button variant="secondary" data-testid="save-title" onClick={saveTitle}>Save</Button>
                <Button variant="secondary" onClick={() => setTitleDraft(null)}>Cancel</Button>
              </div>
            )}
            {stats && (
              <p className="mt-2 text-sm font-semibold tabular-nums text-ink-600" data-testid="lecture-stats">
                {stats.total} {stats.total === 1 ? "card" : "cards"}
                <span className="text-ink-400"> · </span>
                <span className="text-clinical-700">{stats.counts.new} new</span>
                <span className="text-ink-400"> · </span>
                <span className="text-red-700">{stats.counts.learning} learning</span>
                <span className="text-ink-400"> · </span>
                <span className="text-emerald-700">{stats.counts.review} review</span>
                {stats.due > 0 && (
                  <>
                    <span className="text-ink-400"> · </span>
                    <span className="text-amber-800">{stats.due} due</span>
                  </>
                )}
                {drafts.length > 0 && (
                  <>
                    <span className="text-ink-400"> · </span>
                    <span className="text-amber-800" data-testid="lecture-drafts">{drafts.length} to review</span>
                  </>
                )}
              </p>
            )}
          </div>
          <div data-testid="lecture-actions" className="flex flex-wrap gap-3">
            {isUserLecture && titleDraft === null && (
              <Button variant="secondary" data-testid="rename-lecture" onClick={() => setTitleDraft(lecture.title)}>
                Rename
              </Button>
            )}
            {documents.length > 0 && (
              <Button variant="secondary" data-testid="source-toggle" onClick={() => setShowSource((v) => !v)}>
                {showSource ? "Hide source PDF" : "Source PDF"}
              </Button>
            )}
            {isUserLecture && (
              <Button variant="secondary" data-testid="add-pdf-open" onClick={() => setShowAdd((v) => !v)}>
                Add a PDF
              </Button>
            )}
            {documents.length > 0 && (
              <Button variant="secondary" data-testid="generate-more-open" onClick={() => setShowMore((v) => !v)}>
                Generate more cards
              </Button>
            )}
            {stats && stats.total > 0 && (
              <ButtonLink href={`/study/${encodeURIComponent(lecture.id)}`} data-testid="study-link">
                Study
              </ButtonLink>
            )}
          </div>
        </header>

        {showAdd && (
          <Card className="mt-6" data-testid="add-pdf-panel">
            <SectionTitle>Add a PDF to this lecture</SectionTitle>
            <p className="mt-2 text-sm text-ink-600">
              Another deck or chapter for {lecture.title}. Its pages and figures are kept; generate its cards with Generate more.
            </p>
            <input
              type="file"
              accept="application/pdf,.pdf"
              data-testid="add-pdf-file"
              disabled={addState.kind === "working"}
              onChange={(e) => void addPdf(e.target.files?.[0])}
              className="mt-4 block w-full text-base text-ink-700 file:mr-4 file:min-h-[3rem] file:rounded-xl file:border-0 file:bg-clinical-600 file:px-6 file:text-base file:font-semibold file:text-white"
            />
            {addState.kind === "working" && (
              <p role="status" data-testid="add-pdf-progress" className="mt-3 text-sm text-clinical-800">{addState.message}</p>
            )}
            {addState.kind === "done" && (
              <p data-testid="add-pdf-done" data-document-id={addState.documentId} className="mt-3 text-sm text-emerald-900">
                Added {addState.title} ({addState.pages} pages{addState.figures > 0 ? `, ${addState.figures} figures` : ""}). Choose how many cards to generate from it below.
              </p>
            )}
            {addState.kind === "error" && (
              <p role="alert" data-testid="add-pdf-error" className="mt-3 text-sm text-red-700">{addState.message}</p>
            )}
          </Card>
        )}

        {showMore && (
          <Card className="mt-6" data-testid="generate-more-panel">
            <SectionTitle>Generate more cards</SectionTitle>
            <p className="mt-2 text-sm text-ink-600">
              New cards only: facts already covered anywhere in this lecture are skipped, and your existing cards keep their progress.
            </p>
            {documents.length > 1 && (
              <label className="mt-4 flex flex-col gap-1 text-xs font-semibold uppercase tracking-wide text-ink-500">
                From
                <select
                  data-testid="gm-source"
                  value={moreSource}
                  disabled={moreState.kind === "working"}
                  onChange={(e) => setMoreSource(e.target.value)}
                  className="min-h-[3.25rem] rounded-xl border border-ink-300 bg-white px-4 text-base font-normal normal-case tracking-normal text-ink-800"
                >
                  <option value="all">All lecture material ({documents.length} PDFs)</option>
                  {documents.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <LanguagePicker value={moreLanguage ?? language} onChange={setMoreLanguage} disabled={moreState.kind === "working"} prefix="gm-lang" />
            <CountPicker choice={moreChoice} custom={moreCustom} onChoice={setMoreChoice} onCustom={setMoreCustom} disabled={moreState.kind === "working"} prefix="gm-count" />
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button data-testid="generate-more-button" onClick={generateMore} disabled={moreState.kind === "working"}>
                {moreState.kind === "working" ? "Generating…" : "Generate"}
              </Button>
              {moreState.kind === "done" && (
                <p data-testid="generate-more-result" data-produced={moreState.produced} data-shortfall={moreState.shortfall} className="text-sm text-emerald-900">
                  {moreState.produced === 0
                    ? "Nothing new: this lecture's distinct facts are already covered."
                    : `${moreState.produced} new ${moreState.produced === 1 ? "card" : "cards"} added as drafts.`}
                  {moreState.shortfall > 0 && ` Asked for ${moreState.produced + moreState.shortfall}; only ${moreState.produced} more distinct facts were available.${shortfallReasonText(moreState.shortfallReason)}`}
                </p>
              )}
              {moreState.kind === "done" && moreState.produced > 0 && (
                <ArabicCoverageNote language={moreState.language} coverage={moreState.coverage} testId="generate-more-coverage" />
              )}
              {moreState.kind === "error" && (
                <p role="alert" data-testid="generate-more-error" className="text-sm text-red-700">{moreState.message}</p>
              )}
            </div>
          </Card>
        )}

        {showSource && (
          <Card className="mt-6" data-testid="source-pages">
            <SectionTitle>Source PDF</SectionTitle>
            {documents.map((document) => (
              <div key={document.id} className="mt-3">
                <p className="font-semibold text-ink-800">{document.title} · {document.pages.length} pages</p>
                <ul className="mt-3 grid gap-4 sm:grid-cols-2">
                  {document.pages.map((page) => (
                    <li key={page.number} data-testid={`source-page-${page.number}`} className="rounded-xl border border-ink-200 p-3">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-500">Page {page.number}</p>
                      <div className="mt-2">
                        <CardImage image={{ assetId: pageAssetId(document.id, page.number), documentId: document.id, pageNumber: page.number, placement: "back" }} alt={`Page ${page.number}`} size="card" />
                      </div>
                      <p dir="auto" className="mt-2 line-clamp-3 text-sm text-ink-600">{page.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </Card>
        )}

        <Card className="mt-6" id="cards">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <SectionTitle>Cards</SectionTitle>
            {drafts.length > 0 && (
              <Button variant="secondary" data-testid="approve-all" onClick={() => updateConceptStatuses(drafts.map((c) => c.id), "ACTIVE")}>
                Approve all {drafts.length} drafts
              </Button>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {(["DRAFT", "ACTIVE", "DISCARDED", "ALL"] as Filter[]).map((key) => {
              const count = key === "ALL" ? concepts.length : concepts.filter((c) => c.status === key).length;
              return (
                <button
                  key={key}
                  type="button"
                  data-testid={`cards-filter-${key}`}
                  onClick={() => setFilter(key)}
                  className={`min-h-[44px] rounded-full border px-4 text-sm font-semibold ${effectiveFilter === key ? "border-clinical-500 bg-clinical-50 text-clinical-800" : "border-ink-200 bg-white text-ink-600"}`}
                >
                  {key === "ALL" ? "All" : STATUS_LABEL[key]} · {count}
                </button>
              );
            })}
          </div>

          {concepts.length === 0 ? (
            <p className="mt-6 text-ink-600" data-testid="cards-empty">No cards yet. Generate some from the lecture PDF.</p>
          ) : visible.length === 0 ? (
            <p className="mt-6 text-ink-600" data-testid="cards-filter-empty">Nothing here.</p>
          ) : (
            <ul className="mt-5 space-y-4">
              {visible.map((concept) => {
                const item = concept.retrievalItems[0]!;
                const document = documents.find((d) => d.id === concept.source.documentId);
                const isEditing = editing?.id === concept.id;
                const image = item.image;
                return (
                  <li
                    key={concept.id}
                    data-testid={`card-${concept.id}`}
                    data-status={concept.status}
                    data-kind={item.kind}
                    data-page={concept.source.pageNumber}
                    data-document={concept.source.documentId}
                    data-has-image={image ? "true" : "false"}
                    className="rounded-2xl border border-ink-200 bg-white p-5"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
                      <span className={`rounded-full border px-2.5 py-0.5 ${STATUS_TONE[concept.status]}`}>{STATUS_LABEL[concept.status]}</span>
                      <span>{KIND_LABEL[item.kind]}</span>
                      <span>· page {concept.source.pageNumber}</span>
                    </div>
                    {image && image.placement === "front" && (
                      <div className="mt-3">
                        <CardImage image={image} alt={`Figure from page ${image.pageNumber}`} testId={`card-image-${concept.id}`} />
                      </div>
                    )}
                    {isEditing ? (
                      <div className="mt-3 space-y-3">
                        <label className="block text-xs font-semibold uppercase tracking-wide text-ink-500">
                          Front
                          <textarea data-testid={`edit-front-${concept.id}`} dir="auto" rows={2} value={editing.prompt} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} className="mt-1 w-full rounded-xl border border-ink-300 px-3 py-2 text-base font-normal normal-case tracking-normal text-ink-800" />
                        </label>
                        <label className="block text-xs font-semibold uppercase tracking-wide text-ink-500">
                          Back
                          <textarea data-testid={`edit-back-${concept.id}`} dir="auto" rows={3} value={editing.explanation} onChange={(e) => setEditing({ ...editing, explanation: e.target.value })} className="mt-1 w-full rounded-xl border border-ink-300 px-3 py-2 text-base font-normal normal-case tracking-normal text-ink-800" />
                        </label>
                        <div className="flex flex-wrap gap-2">
                          <Button variant="secondary" data-testid={`save-card-${concept.id}`} onClick={() => saveEdit(concept)} disabled={!editing.prompt.trim() || !editing.explanation.trim()}>Save</Button>
                          <Button variant="secondary" data-testid={`cancel-card-${concept.id}`} onClick={() => setEditing(null)}>Cancel</Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p dir="auto" data-testid={`card-front-${concept.id}`} className="mt-3 text-lg font-semibold leading-snug text-ink-800">{item.prompt}</p>
                        <p dir="auto" data-testid={`card-back-${concept.id}`} className="mt-2 whitespace-pre-line text-ink-700">{item.explanation}</p>
                        {image && image.placement === "back" && (
                          <div className="mt-3">
                            <CardImage image={image} alt={`Figure from page ${image.pageNumber}`} testId={`card-image-${concept.id}`} size="thumb" />
                          </div>
                        )}
                      </>
                    )}
                    <details className="mt-3 rounded-xl border border-ink-200 bg-ink-50 p-3" data-testid={`view-source-${concept.id}`}>
                      <summary className="min-h-[2.75rem] cursor-pointer list-none text-sm font-semibold text-clinical-700">
                        View source · {document?.title ?? lecture.title}, page {concept.source.pageNumber}
                      </summary>
                      <blockquote dir="auto" data-testid={`source-excerpt-${concept.id}`} className="mt-2 whitespace-pre-line border-l-4 border-clinical-300 pl-4 text-[0.95rem] leading-relaxed text-ink-600">
                        {displayExcerpt(concept.source.excerpt)}
                      </blockquote>
                      <div className="mt-3">
                        <CardImage image={{ assetId: pageAssetId(concept.source.documentId, concept.source.pageNumber), documentId: concept.source.documentId, pageNumber: concept.source.pageNumber, placement: "back" }} alt={`Page ${concept.source.pageNumber}`} size="page" testId={`source-page-image-${concept.id}`} hideWhenMissing />
                      </div>
                    </details>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {concept.status !== "ACTIVE" && (
                        <Button data-testid={`approve-card-${concept.id}`} onClick={() => updateConceptStatus(concept.id, "ACTIVE")} disabled={isEditing}>
                          Approve
                        </Button>
                      )}
                      {!isEditing && (
                        <Button variant="secondary" data-testid={`edit-card-${concept.id}`} onClick={() => startEdit(concept)}>
                          Edit
                        </Button>
                      )}
                      {concept.status !== "DISCARDED" ? (
                        <Button variant="danger" data-testid={`discard-card-${concept.id}`} onClick={() => updateConceptStatus(concept.id, "DISCARDED")} disabled={isEditing}>
                          Discard
                        </Button>
                      ) : (
                        <Button variant="secondary" data-testid={`restore-card-${concept.id}`} onClick={() => updateConceptStatus(concept.id, "DRAFT")}>
                          Restore as draft
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8 sm:py-12">
      <Link href="/" className="mb-6 inline-flex min-h-[44px] items-center text-sm font-bold uppercase tracking-[0.12em] text-clinical-700">
        MedRecall
      </Link>
      {children}
    </main>
  );
}
