/**
 * Generates the PDF fixtures used by the ingestion tests.
 *
 * Hand-rolled rather than pulled from a PDF library: the fixtures must have
 * exactly known text on exactly known pages, so the page-order and
 * page-number assertions mean something. Uncompressed content streams keep
 * the output diffable.
 *
 *   node scripts/make-fixture-pdf.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function escapeText(text) {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Build a content stream that draws each line at 16pt leading. */
function contentStream(lines) {
  const body = lines
    .map((line, i) =>
      i === 0
        ? `(${escapeText(line)}) Tj`
        : `T* (${escapeText(line)}) Tj`,
    )
    .join("\n");
  return `BT\n/F1 12 Tf\n16 TL\n56 760 Td\n${body}\nET`;
}

function buildPdf(pages) {
  const objects = [];
  const pageObjNumbers = [];

  // 1 = catalog, 2 = pages tree, 3 = font. Page objects follow in pairs.
  let next = 4;
  for (const page of pages) {
    const contentNum = next++;
    const pageNum = next++;
    pageObjNumbers.push(pageNum);
    const stream = contentStream(page);
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
    body:
      `<< /Type /Pages /Kids [${pageObjNumbers.map((n) => `${n} 0 R`).join(" ")}] ` +
      `/Count ${pageObjNumbers.length} >>`,
  });
  objects.unshift({ num: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" });

  objects.sort((a, b) => a.num - b.num);

  let pdf = "%PDF-1.4\n";
  const offsets = new Map();
  for (const obj of objects) {
    offsets.set(obj.num, Buffer.byteLength(pdf, "latin1"));
    pdf += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "latin1");
  const maxNum = objects[objects.length - 1].num;
  pdf += `xref\n0 ${maxNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxNum; n++) {
    const off = offsets.get(n) ?? 0;
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${maxNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "latin1");
}

/* ------------------------------------------------------------------ */

const cellInjuryPages = [
  [
    "Cell Injury: Overview",
    "Cell injury is the result of stress that exceeds the adaptive capacity of the cell.",
    "Hypoxia is the most common cause of cell injury in clinical practice.",
    "Reversible injury is characterised by cellular swelling and fatty change.",
  ],
  [
    "The ATP Depletion Cascade",
    "ATP depletion is the central event that follows a sustained fall in oxygen delivery.",
    "The sodium potassium pump consumes a large share of the cellular ATP budget.",
    "Pump failure causes intracellular sodium and water to accumulate inside the cell.",
  ],
  [
    "Morphology of Reversible Injury",
    "Cellular swelling is the earliest morphological change of reversible cell injury.",
    "Hydropic change refers to the accumulation of water within the injured cell.",
    "Membrane blebbing occurs when the cytoskeleton detaches from the plasma membrane.",
  ],
  [
    "Irreversible Injury",
    "Severe membrane damage marks the transition to irreversible cell injury.",
    "Mitochondrial dysfunction leads to the permanent loss of ATP generation.",
    "Necrosis is the pattern of cell death that follows irreversible injury in living tissue.",
  ],
];

const shortPages = [
  ["Renal Physiology", "The glomerulus is the filtering unit of the nephron."],
  ["Tubular Function", "The proximal tubule reabsorbs most of the filtered sodium."],
];

/**
 * A lecture-sized document: 25 pages of ordinary selectable text, each with a
 * heading and several sentences, plus a unique marker so page ordering can be
 * asserted exactly. The tiny fixtures exercise parsing; this one exercises the
 * shape of real teaching material.
 */
const lecturePages = Array.from({ length: 25 }, (_, i) => {
  const n = i + 1;
  return [
    `Cell Adaptive Responses - Section ${n}`,
    `Marker ${n} identifies this page uniquely within the lecture.`,
    `Hypertrophy is an increase in the size of individual cells in section ${n}.`,
    `Hyperplasia is an increase in the number of cells within a tissue.`,
    `Atrophy is a reduction in cell size caused by reduced workload or supply.`,
    `Metaplasia is a reversible change from one differentiated cell type to another.`,
    `Adaptation fails when the stress exceeds the capacity of the cell to respond.`,
    `Persistent stress in section ${n} leads to injury rather than adaptation.`,
  ];
});

mkdirSync(resolve(here, "../tests/fixtures"), { recursive: true });
writeFileSync(
  resolve(here, "../tests/fixtures/lecture-25-pages.pdf"),
  buildPdf(lecturePages),
);
console.log("wrote tests/fixtures/lecture-25-pages.pdf (25 pages)");
writeFileSync(
  resolve(here, "../tests/fixtures/cell-injury.pdf"),
  buildPdf(cellInjuryPages),
);
writeFileSync(
  resolve(here, "../tests/fixtures/renal-short.pdf"),
  buildPdf(shortPages),
);
console.log("wrote tests/fixtures/cell-injury.pdf (4 pages)");
console.log("wrote tests/fixtures/renal-short.pdf (2 pages)");
