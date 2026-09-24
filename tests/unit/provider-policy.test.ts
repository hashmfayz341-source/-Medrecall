import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DeterministicProvider,
  HOSTED_PROVIDER_SAFEGUARDS,
  ProviderNotPermittedError,
  assertProviderPermitted,
  getProvider,
  type AiProvider,
} from "@/lib/ai";

/**
 * M2 — a paid hosted provider cannot be switched on by configuration alone.
 *
 * Until curriculum is served from the server, /api/grade cannot know who is
 * calling or whether a concept is really approved (a caller can forge
 * `status: "ACTIVE"`). A hosted model behind it would be an open relay for
 * spend. So hosted providers are refused until server-side abuse control
 * exists — and it does not yet.
 */

function hosted(overrides: Partial<AiProvider> = {}): AiProvider {
  const base = new DeterministicProvider();
  return Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
    name: "hosted-stand-in",
    hosted: true,
    ...overrides,
  }) as AiProvider;
}

describe("hosted provider tripwire", () => {
  it("the active provider is local", () => {
    const provider = getProvider();
    expect(provider.name).toBe("deterministic");
    expect(provider.hosted).toBe(false);
  });

  it("no abuse control exists yet, and the flag cannot be flipped at runtime", () => {
    expect(HOSTED_PROVIDER_SAFEGUARDS.abuseControl).toBe(false);
    expect(Object.isFrozen(HOSTED_PROVIDER_SAFEGUARDS)).toBe(true);
    expect(() => {
      (HOSTED_PROVIDER_SAFEGUARDS as { abuseControl: boolean }).abuseControl = true;
    }).toThrow();
  });

  it("a hosted provider is refused", () => {
    expect(() => assertProviderPermitted(hosted())).toThrow(ProviderNotPermittedError);
    expect(() => assertProviderPermitted(hosted())).toThrow(/abuseControl/);
  });

  it("an adapter that forgets to declare `hosted` is treated as hosted", () => {
    const undeclared = hosted();
    delete (undeclared as { hosted?: boolean }).hosted;
    Object.defineProperty(undeclared, "hosted", { value: undefined });
    expect(() => assertProviderPermitted(undeclared)).toThrow(ProviderNotPermittedError);
  });

  it("only real safeguards would admit one", () => {
    expect(assertProviderPermitted(hosted(), { abuseControl: true }).name).toBe("hosted-stand-in");
  });

  it("getProvider() always passes through the tripwire", () => {
    const source = readFileSync("src/lib/ai/index.ts", "utf8");
    const body = source.slice(source.indexOf("export function getProvider"));
    const returns = [...body.matchAll(/return\s+([^;]+);/g)].map((m) => m[1]!);
    expect(returns.length).toBeGreaterThan(0);
    for (const expression of returns) {
      expect(expression.trim().startsWith("assertProviderPermitted(")).toBe(true);
    }
  });
});
