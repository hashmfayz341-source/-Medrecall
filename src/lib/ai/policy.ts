import type { ProviderIdentity } from "./provider";

/**
 * Preconditions for running a HOSTED (paid, third-party) provider.
 *
 * Applies to BOTH provider roles — grading and extraction — independently.
 *
 * Until curriculum is served from the server, POST /api/grade and
 * POST /api/ingest cannot know who is calling or whether a concept is really
 * approved: a caller can forge `status: "ACTIVE"` and any rubric. With the
 * deterministic provider that costs nothing. With a paid model it is an open
 * relay for spend and abuse.
 *
 * So a hosted provider is refused unless every safeguard below is true, and
 * none are implemented yet. Enabling a model is therefore NOT a one-line env
 * change: it requires building the protection first and flipping its flag in
 * the same reviewed change.
 */
export interface HostedProviderSafeguards {
  /**
   * Server-side abuse control on every route that calls the provider:
   * authentication, per-user/per-IP rate limiting and a spend quota, or an
   * equivalent protection. Not implemented.
   */
  abuseControl: boolean;
}

export const HOSTED_PROVIDER_SAFEGUARDS: Readonly<HostedProviderSafeguards> = Object.freeze({
  abuseControl: false,
});

export class ProviderNotPermittedError extends Error {
  constructor(provider: string, missing: string[]) {
    super(`Hosted provider "${provider}" is not permitted: missing ${missing.join(", ")}`);
    this.name = "ProviderNotPermittedError";
  }
}

/** Return the provider if it may run here; throw otherwise. */
export function assertProviderPermitted<P extends ProviderIdentity>(
  provider: P,
  safeguards: Readonly<HostedProviderSafeguards> = HOSTED_PROVIDER_SAFEGUARDS,
): P {
  if (provider.hosted !== false) {
    const missing = (Object.keys(safeguards) as (keyof HostedProviderSafeguards)[]).filter(
      (key) => !safeguards[key],
    );
    if (missing.length > 0) throw new ProviderNotPermittedError(provider.name, missing);
  }
  return provider;
}
