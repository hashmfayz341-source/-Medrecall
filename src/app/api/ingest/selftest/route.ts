import { NextResponse } from "next/server";
import { extractPdfPages } from "@/lib/ingestion/pdf";

/**
 * Proves the PDF pipeline actually runs in whatever runtime this is deployed
 * to, using a PDF built in memory.
 *
 * "Vercel says READY" is not evidence that extraction works: the worker file
 * was missing from the deployed function while every build and every local
 * server passed. This endpoint exercises the real parser in the real runtime
 * and can be opened with a plain GET.
 *
 * It reads no user data and returns no file contents — only page counts and
 * ordering.
 */
export const dynamic = "force-dynamic";

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Minimal multi-page PDF, built here so no fixture file need be deployed. */
function buildProbePdf(pageCount: number): Uint8Array {
  const objects: { num: number; body: string }[] = [];
  const pageNums: number[] = [];
  let next = 4;

  for (let i = 1; i <= pageCount; i++) {
    const contentNum = next++;
    const pageNum = next++;
    pageNums.push(pageNum);
    const stream = `BT\n/F1 12 Tf\n16 TL\n56 760 Td\n(${escapeText(
      `Probe page ${i} contains selectable text.`,
    )}) Tj\nET`;
    objects.push({
      num: contentNum,
      body: `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    });
    objects.push({
      num: pageNum,
      body:
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`,
    });
  }

  objects.unshift({
    num: 3,
    body: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  });
  objects.unshift({
    num: 2,
    body: `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`,
  });
  objects.unshift({ num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" });
  objects.sort((a, b) => a.num - b.num);

  let pdf = "%PDF-1.4\n";
  const offsets = new Map<number, number>();
  for (const obj of objects) {
    offsets.set(obj.num, Buffer.byteLength(pdf, "latin1"));
    pdf += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  const max = objects[objects.length - 1]!.num;
  pdf += `xref\n0 ${max + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= max; n++) {
    pdf += `${String(offsets.get(n) ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${max + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

export async function GET() {
  const pageCount = 12;
  try {
    const doc = await extractPdfPages(buildProbePdf(pageCount), "selftest.pdf", {
      courseId: "selftest",
      lectureId: "selftest",
    });

    const order = doc.pages.map((p) => p.number);
    const ordered = order.every((n, i) => n === i + 1);
    const everyPageHasText = doc.pages.every((p) => p.text.includes("selectable text"));

    return NextResponse.json({
      pdfExtraction: ordered && everyPageHasText && doc.pageCount === pageCount ? "ok" : "degraded",
      pageCount: doc.pageCount,
      expectedPageCount: pageCount,
      pageOrderPreserved: ordered,
      everyPageHasText,
    });
  } catch (cause) {
    console.error("[ingest/selftest] extraction failed", cause);
    return NextResponse.json(
      {
        pdfExtraction: "failed",
        // A short reason, never a stack trace.
        reason: cause instanceof Error ? cause.name : "UnknownError",
      },
      { status: 500 },
    );
  }
}
