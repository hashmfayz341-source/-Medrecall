/** Small, real PDFs with known page boundaries; no network or renderer needed. */
export function makePdf(pages: readonly (readonly string[])[], imageOnly = false): Uint8Array {
  const chars = [...new Set(pages.flat().join(""))];
  if (chars.length > 220) throw new Error("Fixture alphabet too large");
  const codes = new Map(chars.map((char, i) => [char, (i + 32).toString(16).padStart(2, "0")]));
  const unicode = (char: string) => [...Array(char.length)].map((_, i) => char.charCodeAt(i).toString(16).padStart(4, "0")).join("");
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Fixture def\n/CMapType 2 def\n1 begincodespacerange\n<00> <ff>\nendcodespacerange\n${chars.length} beginbfchar\n${chars.map(c => `<${codes.get(c)}> <${unicode(c)}>`).join("\n")}\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const stream = (text: string) => `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${6 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 4 0 R >>",
    stream(cmap),
  ];
  for (const lines of pages) {
    const content = objects.length + 1;
    objects.push(stream(imageOnly ? "q 200 0 0 200 40 500 cm /Im0 Do Q" : `BT\n/F1 10 Tf\n16 TL\n40 740 Td\n${lines.map((line, i) => `${i ? "T* " : ""}<${[...line].map(c => codes.get(c)).join("")}> Tj`).join("\n")}\nET`));
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${imageOnly ? `/XObject << /Im0 ${5 + pages.length * 2} 0 R >>` : ""} >> /Contents ${content} 0 R >>`);
  }
  if (imageOnly) objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 3 >>\nstream\nabc\nendstream");
  let out = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out));
}
