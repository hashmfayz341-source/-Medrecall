import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static architecture checks for the grading boundary.
 *
 * - No client component can reach the AI provider layer, directly or through
 *   any chain of imports. Providers run on the server only.
 * - The engine and domain stay independent of React, Next, the network and
 *   providers.
 */

const ROOT = resolve(".");
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

const FILES = walk(SRC).filter((f) => /\.(ts|tsx)$/.test(f));

/** Runtime (non type-only) import specifiers of a file. */
function runtimeImports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const specs: string[] = [];
  // The clause before `from` never contains a quote or semicolon, so a bare
  // side-effect import (`import "x"`) cannot be skipped over.
  const re = /^\s*(import|export)\s+(?!type\b)(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const match of source.matchAll(re)) specs.push(match[2]!);
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.push(match[1]!);
  return specs;
}

function resolveSpec(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      const target = resolveSpec(file, spec);
      if (target) stack.push(target);
    }
  }
  return seen;
}

const clientFiles = FILES.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
const AI_DIR = join(SRC, "lib", "ai") + "/";

describe("providers never reach the browser", () => {
  it("finds the client components", () => {
    expect(clientFiles.map((f) => f.replace(ROOT + "/", ""))).toContain(
      "src/components/LearnSession.tsx",
    );
  });

  it("no client component imports the AI layer, directly or transitively", () => {
    for (const file of clientFiles) {
      const leaks = [...reachable(file)].filter((f) => f.startsWith(AI_DIR));
      expect(leaks.map((f) => f.replace(ROOT + "/", "")), file).toEqual([]);
    }
  });

  it("LearnSession neither imports nor instantiates a provider", () => {
    const source = readFileSync("src/components/LearnSession.tsx", "utf8");
    expect(source).not.toMatch(/from\s+["']@\/lib\/ai/);
    expect(source).not.toContain("new DeterministicProvider");
    expect(source).not.toContain("recordAttempt(");
    expect(source).toContain("submitAnswer(");
  });

  it("the grade route is the one that runs the provider", () => {
    const route = "src/app/api/grade/route.ts";
    expect([...reachable(join(ROOT, route))].some((f) => f.startsWith(AI_DIR))).toBe(true);
  });

  it("the two role resolvers share no resolver or configuration code, directly or indirectly", () => {
    // M-1. Both resolvers may legitimately share only the provider
    // implementation, the hosted-provider policy and the role types — and
    // whatever those three modules themselves depend on. ANY other module
    // reachable from both resolvers (a shared resolver, factory, config or
    // env reader, inside lib/ai or anywhere else) would again let one switch
    // choose the provider for both roles. No filenames are special-cased:
    // the check is on the real runtime import graph.
    const ALLOWED_SHARED = ["deterministic.ts", "policy.ts", "provider.ts"].map((f) => join(AI_DIR, f));
    const allowedClosure = new Set<string>();
    for (const file of ALLOWED_SHARED) {
      if (existsSync(file)) for (const dep of reachable(file)) allowedClosure.add(dep);
    }

    const grading = reachable(join(AI_DIR, "gradingProvider.ts"));
    const extraction = reachable(join(AI_DIR, "extractionProvider.ts"));
    grading.delete(join(AI_DIR, "gradingProvider.ts"));
    extraction.delete(join(AI_DIR, "extractionProvider.ts"));

    const sharedButNotAllowed = [...grading]
      .filter((f) => extraction.has(f))
      .filter((f) => !allowedClosure.has(f))
      .map((f) => f.replace(ROOT + "/", ""));
    expect(sharedButNotAllowed).toEqual([]);

    // And neither resolver may reach the other.
    expect(grading.has(join(AI_DIR, "extractionProvider.ts"))).toBe(false);
    expect(extraction.has(join(AI_DIR, "gradingProvider.ts"))).toBe(false);
  });

  it("grading and extraction resolve through separate, non-overlapping resolvers", () => {
    const GRADING = join(AI_DIR, "gradingProvider.ts");
    const EXTRACTION = join(AI_DIR, "extractionProvider.ts");
    const BARREL = join(AI_DIR, "index.ts");
    const gradeGraph = reachable(join(ROOT, "src/app/api/grade/route.ts"));
    const ingestGraph = reachable(join(ROOT, "src/app/api/ingest/route.ts"));

    expect(gradeGraph.has(GRADING)).toBe(true);
    expect(gradeGraph.has(EXTRACTION)).toBe(false);
    expect(ingestGraph.has(EXTRACTION)).toBe(true);
    expect(ingestGraph.has(GRADING)).toBe(false);
    // Neither route goes through the barrel that exposes both resolvers.
    expect(gradeGraph.has(BARREL)).toBe(false);
    expect(ingestGraph.has(BARREL)).toBe(false);
    // Ingestion never reaches the grading service either.
    expect(ingestGraph.has(join(AI_DIR, "grade.ts"))).toBe(false);
  });

  it("no source file reads a NEXT_PUBLIC_ variable", () => {
    for (const file of FILES) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/process\.env\.NEXT_PUBLIC_/);
    }
  });
});

describe("the engine and domain stay independent", () => {
  const layers = [join(SRC, "lib", "engine"), join(SRC, "lib", "domain")];
  const files = FILES.filter((f) => layers.some((l) => f.startsWith(l + "/")));

  it("import no React, Next, providers, session or network code", () => {
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      for (const f of reachable(file)) {
        const source = readFileSync(f, "utf8");
        expect(f.startsWith(AI_DIR), `${file} reaches ${f}`).toBe(false);
        expect(f.includes("/lib/session/"), `${file} reaches ${f}`).toBe(false);
        expect(f.includes("/lib/grading/client"), `${file} reaches ${f}`).toBe(false);
        expect(source, f).not.toMatch(/from\s+["'](react|next)(\/|["'])/);
        expect(source, f).not.toMatch(/\bfetch\(/);
      }
    }
  });
});
