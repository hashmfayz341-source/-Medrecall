"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useLearner } from "./LearnerProvider";
import { Button, ButtonLink, Card, SectionTitle } from "./ui";
import { browseCards, type BrowserFilter, type BrowserRow, type CardStudyStatus } from "@/lib/engine/decks";
import { buryCard, formatInterval, resumeCard, suspendCard, unburyCard } from "@/lib/engine/study";
import type { ConceptImportance, RetrievalKind } from "@/lib/domain/types";
import { displayExcerpt } from "@/lib/domain/text";

/*
 * The card browser: every studyable card (ACTIVE concepts only), with its
 * concept, lecture, source and Study status. Filters use existing metadata —
 * lecture, item kind, concept importance, FSRS status — never a second
 * tagging system. Suspend/bury act on the card's Study flags only; editing
 * changes the card's wording while keeping its id and FSRS history.
 */

const KINDS: RetrievalKind[] = ["BASIC", "CLOZE", "MECHANISM", "FREE_RECALL", "CLINICAL", "IMAGE"];
const IMPORTANCE: ConceptImportance[] = ["CORE", "SUPPORTING"];
const STATUSES: (CardStudyStatus | "DUE")[] = ["NEW", "LEARNING", "REVIEW", "DUE", "SUSPENDED", "BURIED"];

const STATUS_LABEL: Record<CardStudyStatus | "DUE", string> = {
  NEW: "New",
  LEARNING: "Learning",
  REVIEW: "Review",
  DUE: "Due now",
  SUSPENDED: "Suspended",
  BURIED: "Buried",
};

const STATUS_TONE: Record<CardStudyStatus, string> = {
  NEW: "border-clinical-200 bg-clinical-50 text-clinical-700",
  LEARNING: "border-red-200 bg-red-50 text-red-700",
  REVIEW: "border-emerald-200 bg-emerald-50 text-emerald-700",
  SUSPENDED: "border-ink-300 bg-ink-100 text-ink-600",
  BURIED: "border-amber-200 bg-amber-50 text-amber-800",
};

function statusText(row: BrowserRow, now: Date): string {
  if (row.status === "BURIED" && row.buriedUntil) return `Buried until ${row.buriedUntil.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  if (row.status === "SUSPENDED") return "Suspended";
  if (row.status === "NEW") return "New";
  if (!row.due) return STATUS_LABEL[row.status];
  const ms = row.due.getTime() - now.getTime();
  return `${STATUS_LABEL[row.status]} · ${ms <= 0 ? "due now" : `due in ${formatInterval(ms)}`}`;
}

const selectClass = "min-h-[44px] rounded-xl border border-ink-300 bg-white px-3 text-sm font-semibold text-ink-700";

export function CardBrowser() {
  const { curriculum, learner, ready, setLearner, snapshot, updateCardText } = useLearner();
  const params = useSearchParams();
  // `?lecture=` from the deck list preselects that deck.
  const [filter, setFilter] = useState<BrowserFilter>(() => ({ lectureId: params.get("lecture") ?? undefined }));
  const [editing, setEditing] = useState<{ itemId: string; prompt: string; explanation: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const rows = useMemo(() => (ready ? browseCards(curriculum, learner, now, filter) : []), [ready, curriculum, learner, now, filter]);
  const lectures = useMemo(() => [...curriculum.course.lectures].sort((a, b) => a.order - b.order), [curriculum]);

  function apply(mutate: (state: typeof learner) => typeof learner) {
    // Like a rating: act on the freshest persisted state, not a stale render.
    const latest = snapshot();
    try {
      setLearner(mutate(latest.learner));
      setNotice(null);
    } catch {
      setNotice("This card can no longer be changed — it may have been un-approved or removed.");
    }
    setNow(new Date());
  }

  function saveEdit() {
    if (!editing) return;
    const prompt = editing.prompt.trim();
    const explanation = editing.explanation.trim();
    if (!prompt || !explanation) {
      setNotice("A card needs both a front and a back.");
      return;
    }
    updateCardText(editing.itemId, { prompt, explanation });
    setEditing(null);
    setNotice(null);
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-8 sm:px-8 sm:py-12">
      <Link href="/study" className="mb-6 inline-flex min-h-[44px] items-center text-sm font-bold uppercase tracking-[0.12em] text-clinical-700">
        ← Study decks
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-ink-800">Card browser</h1>
          <p className="mt-2 max-w-2xl text-ink-600">
            Every approved card, with its concept, lecture and source. Suspend or bury a card to keep it out of Study; edit its wording without losing its schedule.
          </p>
        </div>
        <ButtonLink href="/study/custom" variant="secondary" data-testid="browser-custom-study">
          Custom study
        </ButtonLink>
      </div>

      <div className="mt-6 flex flex-wrap gap-3" data-testid="browser-filters">
        <select data-testid="filter-lecture" aria-label="Lecture" className={selectClass} value={filter.lectureId ?? ""} onChange={(e) => setFilter({ ...filter, lectureId: e.target.value || undefined })}>
          <option value="">All lectures</option>
          {lectures.map((l) => (
            <option key={l.id} value={l.id}>{l.order}. {l.title}</option>
          ))}
        </select>
        <select data-testid="filter-kind" aria-label="Card type" className={selectClass} value={filter.kind ?? ""} onChange={(e) => setFilter({ ...filter, kind: (e.target.value || undefined) as RetrievalKind | undefined })}>
          <option value="">All types</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>{k.replace("_", " ")}</option>
          ))}
        </select>
        <select data-testid="filter-importance" aria-label="Importance" className={selectClass} value={filter.importance ?? ""} onChange={(e) => setFilter({ ...filter, importance: (e.target.value || undefined) as ConceptImportance | undefined })}>
          <option value="">Any importance</option>
          {IMPORTANCE.map((i) => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
        <select data-testid="filter-status" aria-label="Status" className={selectClass} value={filter.status ?? ""} onChange={(e) => setFilter({ ...filter, status: (e.target.value || undefined) as BrowserFilter["status"] })}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABEL[s]}</option>
          ))}
        </select>
        <input
          data-testid="filter-text"
          type="search"
          aria-label="Search cards"
          placeholder="Search front, back or concept"
          value={filter.text ?? ""}
          onChange={(e) => setFilter({ ...filter, text: e.target.value || undefined })}
          className="min-h-[44px] flex-1 rounded-xl border border-ink-300 px-3 text-sm"
        />
      </div>

      {notice && (
        <p role="status" data-testid="browser-notice" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {notice}
        </p>
      )}

      {!ready ? (
        <p className="mt-8 text-ink-500">Loading your cards…</p>
      ) : (
        <Card className="mt-6">
          <SectionTitle>
            <span data-testid="browser-count">{rows.length}</span> {rows.length === 1 ? "card" : "cards"}
          </SectionTitle>
          {rows.length === 0 ? (
            <p data-testid="browser-empty" className="mt-4 text-ink-600">No cards match. Approve concepts in Review drafts, or widen the filters.</p>
          ) : (
            <ul className="mt-4 divide-y divide-ink-200">
              {rows.map((row) => {
                const isEditing = editing?.itemId === row.item.id;
                return (
                  <li key={row.item.id} data-testid={`card-row-${row.item.id}`} data-status={row.status} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        {isEditing ? (
                          <div className="space-y-2">
                            <label className="block text-xs font-semibold uppercase tracking-wide text-ink-500">
                              Front
                              <textarea data-testid={`edit-prompt-${row.item.id}`} value={editing.prompt} onChange={(e) => setEditing({ ...editing, prompt: e.target.value })} rows={2} className="mt-1 w-full rounded-xl border border-ink-300 p-3 text-base text-ink-800" />
                            </label>
                            <label className="block text-xs font-semibold uppercase tracking-wide text-ink-500">
                              Back
                              <textarea data-testid={`edit-explanation-${row.item.id}`} value={editing.explanation} onChange={(e) => setEditing({ ...editing, explanation: e.target.value })} rows={2} className="mt-1 w-full rounded-xl border border-ink-300 p-3 text-base text-ink-800" />
                            </label>
                          </div>
                        ) : (
                          <>
                            <p data-testid={`card-front-${row.item.id}`} className="text-base font-semibold text-ink-800">{row.item.prompt}</p>
                            <p data-testid={`card-back-${row.item.id}`} className="mt-1 text-sm text-ink-600">{row.item.explanation}</p>
                          </>
                        )}
                        <p className="mt-2 text-xs text-ink-500">
                          <span data-testid={`card-concept-${row.item.id}`} className="font-semibold text-ink-700">{row.concept.title}</span>
                          {" · "}
                          <span data-testid={`card-lecture-${row.item.id}`}>{row.lecture.title}</span>
                          {" · "}
                          <span>{row.item.kind.replace("_", " ")}</span>
                          {" · "}
                          <span>{row.concept.importance}</span>
                        </p>
                        <details className="mt-1 text-xs text-ink-500">
                          <summary data-testid={`card-source-${row.item.id}`} className="flex min-h-[44px] cursor-pointer list-none items-center font-semibold text-clinical-700">
                            Source: {row.document?.title ?? row.concept.source.documentId} · page {row.concept.source.pageNumber}
                          </summary>
                          <blockquote data-testid={`card-excerpt-${row.item.id}`} className="mt-1 border-l-4 border-clinical-300 pl-3 text-sm text-ink-600">
                            “{displayExcerpt(row.concept.source.excerpt)}”
                          </blockquote>
                          <Link href={`/concepts?document=${encodeURIComponent(row.concept.source.documentId)}`} data-testid={`card-open-source-${row.item.id}`} className="mt-1 inline-flex min-h-[44px] items-center font-semibold text-clinical-700">
                            Open in concept review
                          </Link>
                        </details>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span data-testid={`card-status-${row.item.id}`} className={`rounded-full border px-3 py-1 text-xs font-bold ${STATUS_TONE[row.status]}`}>
                          {statusText(row, now)}
                        </span>
                        {isEditing ? (
                          <>
                            <Button data-testid={`save-card-${row.item.id}`} onClick={saveEdit} className="min-h-[44px] px-4 text-sm">Save</Button>
                            <Button variant="secondary" data-testid={`cancel-card-${row.item.id}`} onClick={() => setEditing(null)} className="min-h-[44px] px-4 text-sm">Cancel</Button>
                          </>
                        ) : (
                          <>
                            <Button variant="secondary" data-testid={`edit-card-${row.item.id}`} onClick={() => setEditing({ itemId: row.item.id, prompt: row.item.prompt, explanation: row.item.explanation })} className="min-h-[44px] px-4 text-sm">Edit</Button>
                            {row.status === "SUSPENDED" ? (
                              <Button variant="secondary" data-testid={`resume-card-${row.item.id}`} onClick={() => apply((s) => resumeCard(curriculum, s, row.concept.id, row.item.id))} className="min-h-[44px] px-4 text-sm">Resume</Button>
                            ) : (
                              <Button variant="secondary" data-testid={`suspend-card-${row.item.id}`} onClick={() => apply((s) => suspendCard(curriculum, s, row.concept.id, row.item.id))} className="min-h-[44px] px-4 text-sm">Suspend</Button>
                            )}
                            {row.status === "BURIED" ? (
                              <Button variant="secondary" data-testid={`unbury-card-${row.item.id}`} onClick={() => apply((s) => unburyCard(curriculum, s, row.concept.id, row.item.id))} className="min-h-[44px] px-4 text-sm">Unbury</Button>
                            ) : row.status !== "SUSPENDED" ? (
                              <Button variant="secondary" data-testid={`bury-card-${row.item.id}`} onClick={() => apply((s) => buryCard(curriculum, s, row.concept.id, row.item.id, new Date()))} className="min-h-[44px] px-4 text-sm">Bury</Button>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}
    </main>
  );
}
