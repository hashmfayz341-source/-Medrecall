import { NextResponse } from "next/server";
import {
  PdfExtractionError,
  classifyExtractionError,
  extractPdfPages,
} from "@/lib/ingestion/pdf";
import { ingestErrorResponse } from "@/lib/ingestion/ingestErrors";
import { getProvider } from "@/lib/ai";
import type { Concept } from "@/lib/domain/types";

/**
 * PDF ingestion endpoint.
 *
 * Parsing runs server-side: it keeps a megabyte-scale dependency off the
 * client bundle, and it is where a hosted extraction provider will run later
 * so its API key never reaches the browser.
 *
 * The response is candidate material only. Nothing here is teachable until a
 * human approves it — every concept comes back as DRAFT.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 12 * 1024 * 1024;

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "Expected multipart/form-data with a 'file' field." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  const courseId = String(form.get("courseId") ?? "");
  const lectureId = String(form.get("lectureId") ?? "");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No file uploaded." }, { status: 400 });
  }
  if (!courseId || !lectureId) {
    return NextResponse.json(
      { error: "courseId and lectureId are required." },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json({ error: "The uploaded file is empty." }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: `File is larger than ${MAX_BYTES / (1024 * 1024)}MB.` },
      { status: 413 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  let document;
  try {
    document = await extractPdfPages(bytes, file.name, { courseId, lectureId });
  } catch (cause) {
    const reason =
      cause instanceof PdfExtractionError
        ? cause.reason
        : classifyExtractionError(cause);

    // Enough detail server-side to tell a bad file from a broken deployment;
    // never a stack trace in the response.
    console.error(
      `[ingest] extraction failed reason=${reason} file=${file.name} bytes=${file.size}`,
      cause,
    );

    // Fixed messages only; see ingestErrors.ts for why UNKNOWN is a 500.
    const { status, error } = ingestErrorResponse(reason);
    return NextResponse.json({ error }, { status });
  }

  const withText = document.pages.filter((p) => p.text.trim().length > 0);
  if (withText.length === 0) {
    return NextResponse.json(
      {
        error:
          "No text could be extracted. This PDF is probably a scan; OCR is not supported yet.",
      },
      { status: 422 },
    );
  }

  // Extraction goes through the provider abstraction, so a hosted model can
  // replace the deterministic implementation without touching this route.
  const concepts: Concept[] = await getProvider().extractConcepts({
    courseId,
    lectureId,
    document: { id: document.id, lectureId, title: document.title, pages: document.pages },
  });

  if (concepts.length === 0) {
    return NextResponse.json(
      { error: "No candidate concepts could be extracted from this PDF's text. Try a text-based PDF with complete explanatory sentences." },
      { status: 422 },
    );
  }

  return NextResponse.json({
    document: {
      id: document.id,
      title: document.title,
      lectureId,
      pageCount: document.pageCount,
      pages: document.pages,
    },
    concepts,
    stats: {
      pages: document.pageCount,
      pagesWithText: withText.length,
      candidates: concepts.length,
      draft: concepts.filter((c) => c.status === "DRAFT").length,
    },
  });
}
