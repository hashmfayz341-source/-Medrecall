import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The REAL persistence and Tutor code of main@482824c — the build a stale
 * browser tab may still be running after this PR deploys — taken from git at
 * test time, so mixed-version tests exercise the actual old writer rather than
 * an approximation of it.
 *
 * Each file is the exact blob from the base commit. The one transformation is
 * mechanical: `@/…` module specifiers become relative paths inside the copy,
 * because `@/` would otherwise resolve to THIS build's `src/`. Nothing else is
 * touched, and `materializeBase` checks that every rewritten file differs from
 * its git blob only in those specifiers.
 *
 * Written to `.base-main-482824c/` (git-ignored) inside the repository so that
 * `ts-fsrs` resolves from this project's node_modules. Needs the base commit in
 * local git history (a normal clone has it); fails loudly otherwise.
 */

export const BASE_COMMIT = "482824c40a2a7c10734103494a965b6810747637";

/** The import closure of the base persistence layer, Tutor engine and content. */
export const BASE_FILES = [
  "src/lib/content/pathology.ts",
  "src/lib/domain/errors.ts",
  "src/lib/domain/gate.ts",
  "src/lib/domain/mastery.ts",
  "src/lib/domain/text.ts",
  "src/lib/domain/types.ts",
  "src/lib/engine/priority.ts",
  "src/lib/engine/scheduler.ts",
  "src/lib/engine/tutor.ts",
  "src/lib/grading/index.ts",
  "src/lib/persistence/localStorage.ts",
  "src/lib/persistence/repository.ts",
] as const;

const SPECIFIER = /(["'])@\/([^"']+)\1/g;

function repoRoot(): string {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: string };
  if (pkg.name !== "medrecall") throw new Error(`run from the repository root (cwd: ${root})`);
  return root;
}

function gitShow(root: string, file: string): string {
  try {
    return execFileSync("git", ["show", `${BASE_COMMIT}:${file}`], { cwd: root, encoding: "utf8" });
  } catch {
    throw new Error(
      `base commit ${BASE_COMMIT} is not in local git history (needed for ${file}); ` +
        "fetch it with: git fetch origin main",
    );
  }
}

/** Rewrite `@/x` to a path relative to `file`, inside the copy. */
function rewrite(file: string, source: string): string {
  const dir = path.posix.dirname(file);
  return source.replace(SPECIFIER, (_m, quote: string, rest: string) => {
    let rel = path.posix.relative(dir, `src/${rest}`);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${quote}${rel}${quote}`;
  });
}

/** Returns the directory holding `src/…` exactly as main@482824c had it. */
export function materializeBase(): string {
  const root = repoRoot();
  const target = path.join(root, ".base-main-482824c");
  const stamp = path.join(target, "COMMIT");
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === BASE_COMMIT) return target;

  const staging = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  for (const file of BASE_FILES) {
    const original = gitShow(root, file);
    const copy = rewrite(file, original);
    // Only module specifiers may differ from the git blob.
    if (copy.replace(/(["'])\.{1,2}\/[^"']+\1/g, "<spec>") !== original.replace(SPECIFIER, "<spec>").replace(/(["'])\.{1,2}\/[^"']+\1/g, "<spec>")) {
      throw new Error(`rewrite of ${file} changed more than module specifiers`);
    }
    mkdirSync(path.join(staging, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(staging, file), copy);
  }
  writeFileSync(path.join(staging, "COMMIT"), BASE_COMMIT);
  // The complete copy appears atomically, COMMIT included. A copy that is
  // already complete (another worker won the race) is never removed.
  if (existsSync(stamp) && readFileSync(stamp, "utf8") === BASE_COMMIT) {
    rmSync(staging, { recursive: true, force: true });
    return target;
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true }); // other commit
  try {
    renameSync(staging, target);
  } catch {
    rmSync(staging, { recursive: true, force: true });
    if (!existsSync(stamp)) throw new Error("could not materialize the base commit");
  }
  return target;
}
