/**
 * Generates the realistic lecture fixtures used by the lecture-to-flashcards
 * tests: slide decks with headings, bullet lists, mechanism sentences, a
 * repeated logo on every slide (decorative), an embedded raster "histology"
 * image and a vector flowchart.
 *
 *   node scripts/make-lecture-fixtures.mjs
 *
 * Hand-rolled, uncompressed PDFs (like make-fixture-pdf.mjs) so the text on
 * every page is exactly known and the files stay diffable.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "tests", "fixtures");

const esc = (t) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Deterministic pseudo-random bytes for a synthetic RGB image. */
function syntheticImage(width, height, seed) {
  const bytes = Buffer.alloc(width * height * 3);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const blobs = Array.from({ length: 14 }, () => [rnd() * width, rnd() * height, 8 + rnd() * 22]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 235, g = 200, b = 215; // eosin-like background
      for (const [cx, cy, rad] of blobs) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < rad) { r = 90 + d; g = 60 + d / 2; b = 140 + d; } // haematoxylin-like nuclei
      }
      const i = (y * width + x) * 3;
      bytes[i] = r & 255; bytes[i + 1] = g & 255; bytes[i + 2] = b & 255;
    }
  }
  return bytes;
}

function logoImage() {
  const w = 24, h = 24, bytes = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3; const on = (x + y) % 6 < 3;
    bytes[i] = on ? 20 : 220; bytes[i + 1] = on ? 90 : 220; bytes[i + 2] = on ? 160 : 220;
  }
  return { w, h, bytes };
}

/**
 * A slide: heading + lines, optional figure ("raster" draws the histology
 * image, "vector" draws a flowchart with boxes and arrows). Every slide draws
 * the small logo top-right.
 */
function slideContent(slide) {
  const parts = [];
  parts.push(`BT\n/F1 22 Tf\n56 730 Td\n(${esc(slide.heading)}) Tj\nET`);
  const lines = slide.lines ?? [];
  if (lines.length) {
    parts.push(`BT\n/F1 13 Tf\n18 TL\n56 690 Td\n${lines.map((l, i) => `${i ? "T* " : ""}(${esc(l)}) Tj`).join("\n")}\nET`);
  }
  // Logo: 26x26 pt top-right on every slide (decorative, repeated).
  parts.push(`q 26 0 0 26 560 750 cm /Logo Do Q`);
  if (slide.figure === "raster") {
    // A 300x225 pt image in the lower half of the slide.
    parts.push(`q 300 0 0 225 156 120 cm /${slide.image ?? "Hist"} Do Q`);
    parts.push(`BT\n/F1 11 Tf\n156 104 Td\n(${esc(slide.caption ?? "Figure")}) Tj\nET`);
  }
  if (slide.figure === "vector") {
    // Flowchart: three boxes with arrows, drawn with paths (no image object).
    const boxes = [[60, 200], [236, 200], [412, 200]];
    for (const [x, y] of boxes) {
      parts.push(`q 0.2 0.5 0.6 RG 2 w ${x} ${y} 140 60 re S Q`);
      parts.push(`q 0.9 0.95 1 rg ${x + 2} ${y + 2} 136 56 re f Q`);
    }
    for (let i = 0; i < 2; i++) {
      const x = boxes[i][0] + 140, y = 230;
      parts.push(`q 0.2 0.2 0.2 RG 2 w ${x} ${y} m ${x + 30} ${y} l S ${x + 24} ${y + 6} m ${x + 30} ${y} l ${x + 24} ${y - 6} l S Q`);
    }
    // Some extra path detail so the page reads as a diagram.
    for (let i = 0; i < 40; i++) parts.push(`q 0.6 0.6 0.6 RG 0.5 w 60 ${150 - i} m 552 ${150 - i} l S Q`);
    const labels = slide.labels ?? ["ATP depletion", "Pump failure", "Cellular swelling"];
    labels.forEach((label, i) => parts.push(`BT\n/F1 11 Tf\n${boxes[i][0] + 10} 226 Td\n(${esc(label)}) Tj\nET`));
    parts.push(`BT\n/F1 11 Tf\n60 104 Td\n(${esc(slide.caption ?? "Figure")}) Tj\nET`);
  }
  return parts.join("\n");
}

function buildPdf(slides, histology, histology2) {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const logo = logoImage();
  const logoNum = add(`<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${logo.bytes.length} >>\nstream\n${logo.bytes.toString("latin1")}\nendstream`);
  const histNum = add(`<< /Type /XObject /Subtype /Image /Width ${histology.w} /Height ${histology.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${histology.bytes.length} >>\nstream\n${histology.bytes.toString("latin1")}\nendstream`);
  const hist2Num = add(`<< /Type /XObject /Subtype /Image /Width ${histology2.w} /Height ${histology2.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${histology2.bytes.length} >>\nstream\n${histology2.bytes.toString("latin1")}\nendstream`);
  const pageNums = [];
  for (const slide of slides) {
    const content = slideContent(slide);
    const contentNum = add(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`);
    pageNums.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Logo ${logoNum} 0 R /Hist ${histNum} 0 R /Hist2 ${hist2Num} 0 R >> >> /Contents ${contentNum} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageNums.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const cellInjury = [
  { heading: "Cell Injury", lines: ["Dr. A. Example", "Faculty of Medicine, Example University", "Pathology 201"] },
  { heading: "Causes of cell injury", lines: ["Hypoxia", "Physical agents", "Chemical agents and drugs", "Infectious agents", "Immunologic reactions", "Genetic derangements", "Nutritional imbalances"] },
  { heading: "Hypoxia", lines: ["Hypoxia is the most common cause of cell injury.", "Ischaemia is the most common cause of hypoxia.", "Ischaemia injures tissue faster than hypoxia alone because substrate delivery also stops."] },
  { heading: "ATP depletion", lines: ["ATP depletion causes failure of the Na+/K+ ATPase pump.", "Failure of the sodium pump leads to influx of sodium and water, producing cellular swelling.", "Reduced ATP also causes a switch to anaerobic glycolysis, which lowers intracellular pH."], figure: "vector", caption: "Figure 4.1: from ATP depletion to cellular swelling" },
  { heading: "Cellular swelling", lines: ["Cellular swelling is the first manifestation of almost all forms of injury to cells.", "Cellular swelling is caused by failure of energy-dependent ion pumps in the plasma membrane."], figure: "raster", caption: "Figure 5.1: hydropic change of renal tubular cells" },
  { heading: "Fatty change", lines: ["Fatty change (steatosis) is the accumulation of triglycerides within parenchymal cells.", "Fatty change is seen in hypoxic, toxic and metabolic injury, mainly in the liver."], figure: "raster", image: "Hist2", caption: "Figure 6.1: steatosis of hepatocytes" },
  { heading: "Reversible versus irreversible injury", lines: ["Reversible injury shows cellular swelling and fatty change.", "Irreversible injury is defined by severe membrane damage and mitochondrial dysfunction.", "Membrane damage marks the transition to irreversible injury."] },
  { heading: "Patterns of necrosis", lines: ["Coagulative necrosis", "Liquefactive necrosis", "Caseous necrosis", "Fat necrosis", "Fibrinoid necrosis", "Gangrenous necrosis"] },
  { heading: "Apoptosis", lines: ["Apoptosis is programmed cell death mediated by caspases.", "Apoptosis does not elicit an inflammatory reaction.", "Cytochrome c release from mitochondria activates caspase-9 in the intrinsic pathway."] },
  { heading: "References", lines: ["Robbins and Cotran Pathologic Basis of Disease, 10th edition.", "Thank you", "Questions?"] },
];

const inflammation = [
  { heading: "Inflammation", lines: ["Dr. A. Example", "Faculty of Medicine, Example University", "Pathology 202"] },
  { heading: "Cardinal signs of inflammation", lines: ["Rubor (redness)", "Tumor (swelling)", "Calor (heat)", "Dolor (pain)", "Functio laesa (loss of function)"] },
  { heading: "Vascular changes", lines: ["Vasodilation is the earliest vascular change in acute inflammation.", "Increased vascular permeability leads to exudation of protein-rich fluid.", "Stasis of blood flow allows neutrophils to marginate along the endothelium."] },
  { heading: "Cellular events", lines: ["Neutrophils are the first cells to arrive in acute inflammation.", "Neutrophils are replaced by monocytes after 24 to 48 hours.", "Selectins mediate rolling and integrins mediate firm adhesion of leukocytes."], figure: "raster", caption: "Figure 4.1: neutrophils in an alveolar exudate" },
  { heading: "Chemical mediators", lines: ["Histamine causes arteriolar dilation and increased venular permeability.", "Prostaglandins mediate pain and fever.", "Bradykinin causes pain and increased vascular permeability."] },
  { heading: "References", lines: ["Robbins and Cotran Pathologic Basis of Disease, 10th edition.", "Thank you"] },
];

mkdirSync(out, { recursive: true });
writeFileSync(resolve(out, "Cell Injury.pdf"), buildPdf(cellInjury, { w: 160, h: 120, bytes: syntheticImage(160, 120, 7) }, { w: 160, h: 120, bytes: syntheticImage(160, 120, 23) }));
writeFileSync(resolve(out, "Inflammation.pdf"), buildPdf(inflammation, { w: 160, h: 120, bytes: syntheticImage(160, 120, 11) }, { w: 160, h: 120, bytes: syntheticImage(160, 120, 29) }));
console.log("wrote Cell Injury.pdf and Inflammation.pdf");
