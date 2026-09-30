/**
 * Source structure of a PDF page, from the positions of its text.
 *
 * pdfjs returns text as positioned runs. Joining them by their end-of-line
 * flags alone (what extraction did before) loses everything a flashcard
 * generator needs to stay honest: which lines are one wrapped paragraph and
 * which are separate bullets, which text sits in another column or text box,
 * which cells form a table row, which short line is a caption. Sentences were
 * then read across those boundaries and cards merged facts about different
 * drugs, paragraphs and table rows.
 *
 * This module rebuilds, deterministically and conservatively:
 * - SEGMENTS: runs on one baseline with no column-sized gap between them;
 * - UNITS: one logical line — a paragraph, a bullet item, a caption, a table
 *   cell — made of a segment and the segments it visibly wraps onto (same
 *   size, same alignment, tight line pitch, and the previous line was full);
 * - BLOCKS: units that belong together (one text box, one list, one table).
 *
 * When a boundary is uncertain it is kept: two units that should have been
 * one cost a card, two units wrongly joined cost a wrong card.
 *
 * The result is written into the page text itself, so it persists wherever
 * pages already persist: one unit per line, a blank line between blocks, and
 * table rows as tab-separated cells. `Page.layout === "blocks"` marks text in
 * this form.
 */

export interface PositionedItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
  fontName?: string;
}

interface Segment {
  text: string;
  x0: number;
  x1: number;
  /** Baseline (PDF space: up is larger). */
  y: number;
  size: number;
  order: number;
  /** Where the text starts after a leading bullet glyph (the hanging indent of wrapped lines). */
  textX: number;
  /** The font of the segment's text (not of its bullet glyph). */
  font: string;
}

export interface LayoutUnit {
  text: string;
  x0: number;
  x1: number;
  /** Baseline of the first line. */
  top: number;
  /** Baseline of the last line. */
  bottom: number;
  size: number;
  order: number;
  lines: number;
  font: string;
}

export type LayoutBlock =
  | { kind: "text"; units: LayoutUnit[] }
  | { kind: "table"; rows: string[][] };

/** Bullet glyphs and list markers that open a new item. */
export const BULLET = /^\s*(?:[•●○◦▪▫■□►▸‣⁃∙·*–—-]\s+|[•●○◦▪▫■□►▸‣⁃∙·](?=\S)|(?:\d{1,2}|[a-z])[.)]\s+)/i;
const TERMINAL = /[.!?:]["”’)]?$/;
/** Words that cannot end a line of text that is complete: the line must continue. */
const OPEN_END = /(?:,|;|\b(?:and|or|of|the|a|an|by|to|with|in|on|at|for|from|as|into|than|that|which|is|are|was|were|be|its|their|such|including|between|versus|vs\.?|via|per|both|either|neither|not|no|more|less|most))$/i;

const GLYPH = /^[•●○◦▪▫■□►▸‣⁃∙·*–—-]$/;

const MAX = { lineShift: 0.35, pitch: 1.45, sizeRatio: 0.15, align: 0.6, gap: 1.0 };

function segmentsOf(items: readonly PositionedItem[]): Segment[] {
  const segments: Segment[] = [];
  let current: Segment | null = null;
  let order = 0;
  let pendingGap = false;
  for (const item of items) {
    const t = item.transform;
    if (typeof item.str !== "string" || !t || t.length < 6) continue;
    const size = Math.hypot(t[2]!, t[3]!) || item.height || 0;
    const x = t[4]!;
    const y = t[5]!;
    const width = item.width ?? 0;
    if (item.str.trim() === "") {
      // A whitespace run wider than a character or two is a column gap (tables, tab stops).
      // (Not after a lone bullet glyph: that space is the bullet's indent.)
      if (current && !GLYPH.test(current.text) && width > Math.max(size, current.size) * MAX.gap) pendingGap = true;
      if (item.hasEOL && current) {
        segments.push(current);
        current = null;
        pendingGap = false;
      }
      continue;
    }
    const ref = current ? Math.max(current.size, size) : size;
    const sameLine = current !== null && Math.abs(y - current.y) <= ref * MAX.lineShift;
    const gap = current ? x - current.x1 : 0;
    const afterGlyph = current !== null && GLYPH.test(current.text);
    const joins = current !== null && sameLine && !pendingGap && gap > -ref * 0.5 && gap <= ref * (afterGlyph ? 3 : MAX.gap);
    if (current && joins) {
      if (afterGlyph) {
        current.textX = x;
        current.font = item.fontName ?? "";
      }
      const space = gap > ref * 0.12 && !/\s$/.test(current.text) && !/^\s/.test(item.str);
      current.text += (space ? " " : "") + item.str;
      current.x1 = Math.max(current.x1, x + width);
      // A superscript or subscript keeps the line's own baseline and size.
      if (size > current.size) {
        current.size = size;
        current.y = y;
      }
    } else {
      if (current) segments.push(current);
      current = { text: item.str, x0: x, x1: x + width, y, size, order: order++, textX: x, font: item.fontName ?? "" };
    }
    pendingGap = false;
    if (item.hasEOL && current) {
      segments.push(current);
      current = null;
    }
  }
  if (current) segments.push(current);
  return segments
    .map((s) => ({ ...s, text: s.text.replace(/\s+/g, " ").trim() }))
    .filter((s) => s.text.length > 0);
}

const sameSize = (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * MAX.sizeRatio;
const center = (s: { x0: number; x1: number }) => (s.x0 + s.x1) / 2;

/** Where a unit's continuation lines start: after a bullet glyph, the text itself. */
function hangingX(unit: LayoutUnit, first: Segment): number {
  if (first.textX > first.x0) return first.textX;
  const bullet = BULLET.exec(first.text);
  if (!bullet || first.text.length === 0) return unit.x0;
  return first.x0 + ((first.x1 - first.x0) * bullet[0].length) / first.text.length;
}

interface Open {
  unit: LayoutUnit;
  first: Segment;
  last: Segment;
  segments: Segment[];
}

/**
 * Whether segment `s` is the next line of the unit ending with `last`:
 * directly below at a normal line pitch, the same size, aligned the same
 * way, not a new bullet — and the previous line was full: the first word of
 * `s` would not have fitted after it within the widest line of the column.
 * A short line followed by a capitalised one ("Bronchospasm" /
 * "Bradycardia") is two items, not one wrapped line.
 */
function continues(open: Open, s: Segment, columnWidth: number): boolean {
  const { last, unit } = open;
  const size = Math.max(s.size, last.size);
  if (!sameSize(s.size, last.size)) return false;
  const drop = last.y - s.y;
  if (drop <= size * 0.5 || drop > size * MAX.pitch) return false;
  if (BULLET.test(s.text)) return false;
  const tol = size * MAX.align;
  const left = Math.abs(s.x0 - unit.x0) <= tol || Math.abs(s.x0 - hangingX(unit, open.first)) <= tol;
  const centred = Math.abs(center(s) - center(last)) <= tol && Math.abs(s.x0 - unit.x0) > tol;
  if (!left && !centred) return false;
  const firstWord = s.text.split(" ")[0] ?? "";
  const wordWidth = ((s.x1 - s.x0) * firstWord.length) / Math.max(1, s.text.length);
  const lastWidth = centred ? last.x1 - last.x0 : last.x1 - last.textX;
  const room = lastWidth + wordWidth + size * 0.3;
  const full = room >= columnWidth - size * 1.5;
  // A lower-case line after an unfinished, well-filled line is a wrap even when widths are uncertain.
  const lowerWrap = /^[a-z(]/.test(s.text) && !TERMINAL.test(last.text) && room >= columnWidth * 0.7;
  if (!full && !lowerWrap && !OPEN_END.test(last.text)) return false;
  // A capitalised line after a short one that ends a phrase is a new item ("Bronchospasm" / "Bradycardia").
  if (/^[A-Z]/.test(s.text) && !TERMINAL.test(last.text) && !OPEN_END.test(last.text) && (!full || wordsIn(last.text) <= 4)) return false;
  return true;
}

const wordsIn = (text: string) => text.split(/\s+/).filter(Boolean).length;

/**
 * The widest line of the text box a segment belongs to: the run of
 * segments around it in the stream that share its size and alignment (a
 * text box is written contiguously; the next box breaks the run).
 */
function columnWidths(segments: readonly Segment[]): Map<Segment, number> {
  const widths = new Map<Segment, number>();
  const aligned = (o: Segment, s: Segment) => {
    const tol = Math.max(o.size, s.size) * MAX.align;
    return sameSize(o.size, s.size) && (Math.abs(o.x0 - s.x0) <= tol || Math.abs(o.textX - s.textX) <= tol || Math.abs(center(o) - center(s)) <= tol);
  };
  segments.forEach((s, i) => {
    let widest = s.x1 - s.textX;
    for (let j = i - 1; j >= 0 && aligned(segments[j]!, s); j--) widest = Math.max(widest, segments[j]!.x1 - segments[j]!.textX);
    for (let j = i + 1; j < segments.length && aligned(segments[j]!, s); j++) widest = Math.max(widest, segments[j]!.x1 - segments[j]!.textX);
    widths.set(s, widest);
  });
  return widths;
}

function unitsOf(segments: readonly Segment[]): LayoutUnit[] {
  const widths = columnWidths(segments);
  const open: Open[] = [];
  for (const s of segments) {
    // The most recent unit this line continues (a table row interleaves cells, so look back a little).
    let target: Open | undefined;
    for (let i = open.length - 1; i >= Math.max(0, open.length - 8); i--) {
      const candidate = open[i]!;
      if (continues(candidate, s, widths.get(candidate.last) ?? 0)) {
        target = candidate;
        break;
      }
    }
    if (target) {
      target.segments.push(s);
      target.last = s;
      target.unit.text = joinWrapped(target.unit.text, s.text);
      target.unit.bottom = s.y;
      target.unit.x1 = Math.max(target.unit.x1, s.x1);
      target.unit.lines++;
    } else {
      open.push({
        unit: { text: s.text, x0: s.x0, x1: s.x1, top: s.y, bottom: s.y, size: s.size, order: s.order, lines: 1, font: s.font },
        first: s,
        last: s,
        segments: [s],
      });
    }
  }
  return open.map((o) => o.unit);
}

/** Join a wrapped line: a word hyphenated at the line end is rejoined only when the hyphen is a soft break ("infarc-" + "tion"). */
function joinWrapped(a: string, b: string): string {
  if (/[a-z]-$/i.test(a)) {
    // "beta-" + "2", "non-" + "small": a compound keeps its hyphen; "infarc-" + "tion" was a soft break.
    const compound = /^\d/.test(b) || /^[A-Z]/.test(b) || /\b(?:non|anti|pre|post|self|well|beta|alpha|gamma|delta|type|first|second|third|low|high|long|short|co|re|sub|inter|intra|extra|multi|mono|poly|bi|tri)-$/i.test(a);
    return compound ? `${a}${b}` : `${a.slice(0, -1)}${b}`;
  }
  return `${a} ${b}`;
}

/**
 * Rows of a table: units side by side on one top baseline, in reading order
 * of the stream (a table is written row by row; two text columns are written
 * one after the other). A table needs a header and at least two body rows,
 * the same number of cells in every row, aligned under the header, and its
 * cells must be labels and short phrases, not paragraphs. Anything less is
 * not read as a table.
 */
function findTables(units: readonly LayoutUnit[]): { tables: { units: LayoutUnit[]; rows: string[][] }[] } {
  const byOrder = [...units].sort((a, b) => a.order - b.order);
  const rows: LayoutUnit[][] = [];
  for (const u of byOrder) {
    const row = rows[rows.length - 1];
    const tol = u.size * MAX.lineShift;
    if (row && sameSize(row[0]!.size, u.size) && Math.abs(row[0]!.top - u.top) <= tol && u.x0 > row[row.length - 1]!.x1) {
      row.push(u);
    } else {
      rows.push([u]);
    }
  }
  const tables: { units: LayoutUnit[]; rows: string[][] }[] = [];
  let i = 0;
  while (i < rows.length) {
    const header = rows[i]!;
    if (header.length < 2) {
      i++;
      continue;
    }
    const cols = header.map((u) => u.x0);
    const aligned = (row: LayoutUnit[]) =>
      row.length === cols.length && row.every((u, c) => Math.abs(u.x0 - cols[c]!) <= u.size * 1.0) && row[0]!.top < header[0]!.top;
    let j = i + 1;
    while (j < rows.length && aligned(rows[j]!) && rows[j]![0]!.top < rows[j - 1]![0]!.top) j++;
    const body = rows.slice(i + 1, j);
    const cells = body.flat();
    const prose = cells.filter((u) => wordsIn(u.text) >= 9 && /[.!?]$/.test(u.text)).length;
    if (body.length >= 2 && prose * 2 <= cells.length) {
      const members = [header, ...body];
      tables.push({ units: members.flat(), rows: members.map((r) => r.map((u) => u.text.replace(/\t/g, " "))) });
      i = j;
    } else {
      i++;
    }
  }
  return { tables };
}

/**
 * Whether a unit continues the current block: consecutive in the stream,
 * going down the page without a large gap, and either aligned with the
 * block's first unit at its size, or indented under it at the same or a
 * smaller size (a sub-bullet stays with its bullet).
 */
function sameBlock(block: readonly LayoutUnit[], next: LayoutUnit): boolean {
  const base = block[0]!;
  const prev = block[block.length - 1]!;
  const gap = prev.bottom - next.top;
  if (gap <= Math.min(prev.size, next.size) * 0.5 || gap > Math.max(prev.size, next.size) * 2.5) return false;
  const tol = base.size * MAX.align;
  if (Math.abs(next.x0 - base.x0) <= tol) return sameSize(base.size, next.size);
  const indented = next.x0 > base.x0 + tol && next.x0 <= base.x0 + base.size * 4;
  if (indented && next.size <= base.size * (1 + MAX.sizeRatio) && next.size >= base.size * 0.7) return true;
  return Math.abs(center(next) - center(base)) <= tol && sameSize(base.size, next.size);
}

export interface PageLayout {
  /** The page title: the first unit when it is set larger than the body, else "". */
  title: string;
  blocks: LayoutBlock[];
  /** The page text in block form (see module comment). */
  text: string;
}

export function layoutPage(items: readonly PositionedItem[]): PageLayout {
  const units = unitsOf(segmentsOf(items));
  const { tables } = findTables(units);
  const inTable = new Map<LayoutUnit, number>();
  tables.forEach((t, i) => t.units.forEach((u) => inTable.set(u, i)));

  const blocks: LayoutBlock[] = [];
  const emitted = new Set<number>();
  let current: LayoutUnit[] = [];
  const flush = () => {
    if (current.length > 0) blocks.push({ kind: "text", units: current });
    current = [];
  };
  for (const u of [...units].sort((a, b) => a.order - b.order)) {
    const t = inTable.get(u);
    if (t !== undefined) {
      flush();
      if (!emitted.has(t)) {
        emitted.add(t);
        blocks.push({ kind: "table", rows: tables[t]!.rows });
      }
      continue;
    }
    if (current.length > 0 && !sameBlock(current, u)) flush();
    current.push(u);
  }
  flush();

  // The title: the first block's first unit, when it is larger than most body text.
  const sizes = units.map((u) => u.size).sort((a, b) => a - b);
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0;
  const first = blocks[0];
  let title = "";
  if (first?.kind === "text" && first.units[0] && first.units[0].size > median * 1.2) {
    title = first.units[0].text;
    // A title is a block of its own.
    if (first.units.length > 1) blocks.splice(0, 1, { kind: "text", units: [first.units[0]] }, { kind: "text", units: first.units.slice(1) });
  }
  // A block's heading set in its own font ("Bethanechol" in bold over its
  // paragraph, "Muscarinic signs of …" over its items) is a block of its own:
  // a heading, not the first item.
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.kind !== "text" || block.units.length < 2) continue;
    const [head, ...rest] = block.units;
    const fonts = new Set(rest.map((u) => u.font));
    if (head!.lines <= 3 && head!.text.split(/\s+/).length <= 12 && head!.font && fonts.size === 1 && !fonts.has(head!.font) && !BULLET.test(head!.text) && !/[.!?]$/.test(head!.text)) {
      blocks.splice(i, 1, { kind: "text", units: [head!] }, { kind: "text", units: rest });
      i++;
    }
  }
  const text = blocks
    .map((b) => (b.kind === "table" ? b.rows.map((r) => r.join("\t")).join("\n") : b.units.map((u) => u.text).join("\n")))
    .join("\n\n");
  return { title, blocks, text };
}
