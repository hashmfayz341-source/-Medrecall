import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Error mapping at the /api/ingest boundary.
 *
 * The rule: only a file we can positively identify as bad (MALFORMED) or
 * locked (ENCRYPTED) may be blamed on the user. Everything else — a missing
 * worker, a parser that failed to bootstrap, or a failure we cannot classify
 * at all — is a server problem and must say so, with no internals exposed.
 */

// Lets a test make extraction throw a chosen error for an otherwise valid PDF.
const inject = vi.hoisted(() => ({ next: null as unknown }));

vi.mock("@/lib/ingestion/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ingestion/pdf")>();
  return {
    ...actual,
    extractPdfPages: async (...args: Parameters<typeof actual.extractPdfPages>) => {
      if (inject.next) {
        const error = inject.next;
        inject.next = null;
        throw error;
      }
      return actual.extractPdfPages(...args);
    },
  };
});

// Imported after the mock so the route picks it up.
const { POST } = await import("@/app/api/ingest/route");

const VALID = readFileSync("tests/fixtures/cell-injury.pdf");

function upload(bytes: Uint8Array | Buffer, name = "lecture.pdf") {
  const form = new FormData();
  form.set("file", new File([new Uint8Array(bytes)], name, { type: "application/pdf" }));
  form.set("courseId", "course-pathology");
  form.set("lectureId", "lecture-cell-injury");
  return new Request("http://localhost/api/ingest", { method: "POST", body: form });
}

async function call(bytes: Uint8Array | Buffer, name?: string) {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await POST(upload(bytes, name));
  const body = (await response.json()) as Record<string, unknown>;
  errorSpy.mockRestore();
  return { status: response.status, body };
}

/** Nothing a browser should ever see from a server-side failure. */
function assertNoDisclosure(body: Record<string, unknown>, raw: string) {
  const serialised = JSON.stringify(body);
  expect(Object.keys(body)).toEqual(["error"]);
  expect(serialised).not.toContain(raw);
  expect(serialised).not.toMatch(/node_modules|\/var\/task|\/home\/|\.mjs|\.js\b/);
  expect(serialised).not.toMatch(/\bat [\w$.<>]+ \(|\n\s+at /);
  expect(serialised).not.toMatch(/ReferenceError|TypeError|Error:/);
}

const BLAMES_THE_FILE = /could not read this file|not a valid pdf|invalid pdf|corrupt/i;

afterEach(() => {
  inject.next = null;
});

describe("server-side failures never blame the user's file", () => {
  it("an arbitrary unclassifiable failure returns a neutral 500", async () => {
    const raw = "something unexpected at /var/task/node_modules/secret/thing.js:42";
    inject.next = new Error(raw);

    const { status, body } = await call(VALID);
    expect(status).toBe(500);
    expect(String(body.error)).not.toMatch(BLAMES_THE_FILE);
    expect(String(body.error)).toMatch(/server/i);
    assertNoDisclosure(body, raw);
  });

  it("a parser bootstrap ReferenceError is a server problem, not a bad PDF", async () => {
    // The file is valid: without the injected failure this same upload succeeds.
    const raw = "DOMMatrix is not defined";
    inject.next = new ReferenceError(raw);

    const { status, body } = await call(VALID);
    expect(status).toBe(500);
    expect(String(body.error)).not.toMatch(BLAMES_THE_FILE);
    assertNoDisclosure(body, raw);

    // Control: the identical bytes extract fine once the fault is gone.
    const control = await call(VALID);
    expect(control.status).toBe(200);
  });

  it("a missing worker is reported as RUNTIME with a neutral 500", async () => {
    const raw =
      'Setting up fake worker failed: "Cannot find module \'/var/task/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs\' imported from /var/task/node_modules/pdfjs-dist/legacy/build/pdf.mjs".';
    inject.next = new Error(raw);

    const { status, body } = await call(VALID);
    expect(status).toBe(500);
    expect(String(body.error)).not.toMatch(BLAMES_THE_FILE);
    assertNoDisclosure(body, raw);
  });

  it("a thrown non-Error value is still handled safely", async () => {
    inject.next = { weird: "object", path: "/home/user/secret" };
    const { status, body } = await call(VALID);
    expect(status).toBe(500);
    assertNoDisclosure(body, "/home/user/secret");
  });
});

describe("genuinely bad or locked files keep their specific responses", () => {
  it("a malformed PDF still returns 422 and says the file could not be read", async () => {
    const { status, body } = await call(
      new TextEncoder().encode("%PDF-1.4\ntruncated nonsense"),
      "broken.pdf",
    );
    expect(status).toBe(422);
    expect(String(body.error)).toMatch(/could not read this file as a pdf/i);
    assertNoDisclosure(body, "truncated nonsense");
  });

  it("a genuinely encrypted PDF gets the password message", async () => {
    // Real RC4-128 encrypted file; pdfjs raises its own PasswordException.
    const { status, body } = await call(
      readFileSync("tests/fixtures/encrypted.pdf"),
      "encrypted.pdf",
    );
    expect(status).toBe(422);
    expect(String(body.error)).toMatch(/password/i);
    assertNoDisclosure(body, "No password given");
  });

  it("a valid PDF still succeeds end to end", async () => {
    const { status, body } = await call(VALID);
    expect(status).toBe(200);
    expect((body.stats as { draft: number }).draft).toBeGreaterThan(0);
  });
});
