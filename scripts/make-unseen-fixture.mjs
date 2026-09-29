/**
 * Generates the UNSEEN / adversarial lecture used by the merge-gate
 * regression tests (tests/unit/unseen-lecture.test.ts, the "unseen lecture"
 * E2E tests). Its content deliberately shares no sentences or patterns of
 * wording with the Cell Injury / Inflammation fixtures, and it contains the
 * cases the generator must handle honestly:
 *
 * - English medical prose in the supported Arabic patterns (most common
 *   cause, defined as, caused by, leads to, results in, characterized by,
 *   first manifestation, increased / decreased) and OUTSIDE them (English
 *   verbs the generator cannot translate);
 * - context-dependent words: "most specific", "by two weeks" (time),
 *   "within twelve hours" (time) vs "within canaliculi" (place);
 * - an arrow sequence;
 * - a captioned micrograph, an uncaptioned image, and two related
 *   conditions sharing one generic word ("centrilobular necrosis" /
 *   "bridging necrosis");
 * - the same picture drawn twice at different sizes with CONTRADICTORY
 *   captions, and another picture drawn twice at different sizes with the
 *   SAME caption;
 * - a repeated logo on every slide, and a long lecture title (the file name).
 *
 *   node scripts/make-unseen-fixture.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "..", "tests", "fixtures");
export const UNSEEN_FILE = "Hepatic Injury, Repair and Fibrosis in Alcoholic, Viral and Drug-Induced Liver Disease.pdf";

const esc = (t) => t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

/** Deterministic synthetic micrograph: a background tint with dark blobs; `seed` makes each picture different. */
export function syntheticImage(width, height, seed, tint = [236, 205, 214]) {
  const bytes = Buffer.alloc(width * height * 3);
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const blobs = Array.from({ length: 16 }, () => [rnd() * width, rnd() * height, 8 + rnd() * 24]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let [r, g, b] = tint;
      for (const [cx, cy, rad] of blobs) {
        const d = Math.hypot(x - cx, y - cy);
        if (d < rad) { r = 80 + d; g = 50 + d / 2; b = 130 + d; }
      }
      const i = (y * width + x) * 3;
      bytes[i] = r & 255; bytes[i + 1] = g & 255; bytes[i + 2] = b & 255;
    }
  }
  return bytes;
}

/** A small repeated logo (decorative). */
function logo() {
  const w = 20, h = 20, bytes = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3; const on = (x * y) % 5 < 2;
    bytes[i] = on ? 150 : 240; bytes[i + 1] = on ? 30 : 240; bytes[i + 2] = on ? 60 : 240;
  }
  return { w, h, bytes };
}

/** The pictures: name → [width, height, seed, tint]. */
export const IMAGES = {
  Zonal: [160, 120, 303, [236, 205, 214]],
  Chart: [160, 120, 404, [210, 225, 240]],
  Twin: [160, 120, 101, [238, 210, 220]],
  Plug: [160, 120, 202, [228, 214, 190]],
};

/**
 * Slides: heading, lines, figures ({ image, x, y, w, h, caption? } in PDF
 * points; the caption is drawn 16 pt below the image).
 */
export const SLIDES = [
  { heading: "Hepatic Injury, Repair and Fibrosis", lines: ["Dr. C. Placeholder", "Department of Pathology, Placeholder School of Medicine", "Gastrointestinal block"] },
  {
    heading: "Acetaminophen hepatotoxicity",
    lines: [
      "Acetaminophen overdose is the most common cause of acute liver failure.",
      "Glutathione depletion leads to accumulation of reactive metabolites.",
      "Increased NAPQI formation causes decreased mitochondrial respiration.",
    ],
  },
  {
    heading: "Patterns of hepatocyte necrosis",
    lines: [
      "Centrilobular necrosis is the first manifestation of acetaminophen toxicity.",
      "Bridging necrosis is characterized by bands of necrosis linking portal tracts.",
    ],
    figures: [{ image: "Zonal", x: 150, y: 130, w: 300, h: 225, caption: "Figure 3.1: centrilobular necrosis with preserved periportal hepatocytes" }],
  },
  {
    heading: "Alcoholic liver disease",
    lines: [
      "Chronic alcohol use results in macrovesicular steatosis.",
      "Mallory bodies are caused by aggregation of damaged intermediate filaments.",
      "Alcoholic hepatitis is defined as hepatocyte ballooning with neutrophilic infiltration.",
    ],
  },
  {
    heading: "Biochemical markers",
    lines: [
      "Alanine aminotransferase is the most specific marker of hepatocellular injury.",
      "Serum aminotransferases rise within twelve hours of the toxic insult.",
    ],
    figures: [{ image: "Chart", x: 170, y: 150, w: 260, h: 195 }],
  },
  {
    heading: "Regeneration and fibrosis",
    lines: [
      "Hepatocyte replication restores liver mass by two weeks.",
      "Portal fibrosis follows repeated episodes of hepatocyte injury in many patients.",
      "Stellate cell activation -> collagen deposition -> septal fibrosis -> cirrhosis",
    ],
  },
  {
    heading: "Viral hepatitis B",
    lines: ["Chronic hepatitis B shows hepatocytes with finely granular cytoplasm."],
    figures: [{ image: "Twin", x: 110, y: 140, w: 320, h: 240, caption: "Figure 7.1: ground-glass hepatocytes in chronic hepatitis B" }],
  },
  {
    heading: "Viral hepatitis A",
    lines: ["Acute hepatitis A produces scattered apoptotic hepatocytes."],
    figures: [{ image: "Twin", x: 230, y: 170, w: 240, h: 180, caption: "Figure 8.1: councilman bodies in acute hepatitis A" }],
  },
  {
    heading: "Cholestasis",
    lines: ["Conjugated bilirubin accumulates within canaliculi during cholestasis."],
    figures: [{ image: "Plug", x: 140, y: 140, w: 320, h: 240, caption: "Figure 9.1: canalicular bile plugs" }],
  },
  {
    heading: "Cholestasis revisited",
    lines: ["Prolonged cholestasis damages bile ductules through retained bile acids."],
    figures: [{ image: "Plug", x: 250, y: 160, w: 220, h: 165, caption: "Figure 10.1: canalicular bile plugs" }],
  },
  { heading: "References", lines: ["Macsween's Pathology of the Liver, 8th edition.", "Thank you"] },
];

function content(slide) {
  const parts = [`BT\n/F1 22 Tf\n56 730 Td\n(${esc(slide.heading)}) Tj\nET`];
  const lines = slide.lines ?? [];
  if (lines.length) parts.push(`BT\n/F1 12 Tf\n17 TL\n56 690 Td\n${lines.map((l, i) => `${i ? "T* " : ""}(${esc(l)}) Tj`).join("\n")}\nET`);
  parts.push("q 24 0 0 24 562 752 cm /Logo Do Q");
  for (const f of slide.figures ?? []) {
    parts.push(`q ${f.w} 0 0 ${f.h} ${f.x} ${f.y} cm /${f.image} Do Q`);
    if (f.caption) parts.push(`BT\n/F1 11 Tf\n${f.x} ${f.y - 16} Td\n(${esc(f.caption)}) Tj\nET`);
  }
  return parts.join("\n");
}

export function buildUnseenPdf() {
  const objects = [];
  const add = (body) => { objects.push(body); return objects.length; };
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const image = (w, h, bytes) => add(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${bytes.length} >>\nstream\n${bytes.toString("latin1")}\nendstream`);
  const l = logo();
  const refs = { Logo: image(l.w, l.h, l.bytes) };
  for (const [name, [w, h, seed, tint]] of Object.entries(IMAGES)) refs[name] = image(w, h, syntheticImage(w, h, seed, tint));
  const xobjects = Object.entries(refs).map(([name, n]) => `/${name} ${n} 0 R`).join(" ");
  const pages = [];
  for (const slide of SLIDES) {
    const c = content(slide);
    const contentNum = add(`<< /Length ${Buffer.byteLength(c, "latin1")} >>\nstream\n${c}\nendstream`);
    pages.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << ${xobjects} >> >> /Contents ${contentNum} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Kids [${pages.map((n) => `${n} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(pdf, "latin1")); pdf += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, UNSEEN_FILE), buildUnseenPdf());
  console.log(`wrote ${UNSEEN_FILE}`);
}
