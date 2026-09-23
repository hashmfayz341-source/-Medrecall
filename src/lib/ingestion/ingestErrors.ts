import type { ExtractionFailure } from "./pdf";

/**
 * What the browser is told when extraction fails.
 *
 * Only a file we can positively identify as bad (MALFORMED) or locked
 * (ENCRYPTED) is attributed to the user. A runtime failure, and anything we
 * could not classify, is reported as a server problem: an unrecognised error
 * is far more likely to be a deployment or parser fault than a bad upload, and
 * telling someone their valid PDF is broken sends them hunting for a problem
 * that is not theirs.
 *
 * Messages are fixed strings. No raw exception text, stack trace or file path
 * ever reaches the response.
 */
export interface IngestErrorResponse {
  status: number;
  error: string;
}

export const INGEST_ERRORS: Record<ExtractionFailure, IngestErrorResponse> = {
  ENCRYPTED: {
    status: 422,
    error: "This PDF is password protected. Remove the protection and try again.",
  },
  MALFORMED: {
    status: 422,
    error: "Could not read this file as a PDF. It may be damaged or not a PDF at all.",
  },
  RUNTIME: {
    status: 500,
    error:
      "PDF processing failed on the server. Your file may not be at fault — please try again later.",
  },
  UNKNOWN: {
    status: 500,
    error:
      "PDF processing failed on the server. Your file may not be at fault — please try again later.",
  },
};

export function ingestErrorResponse(reason: ExtractionFailure): IngestErrorResponse {
  return INGEST_ERRORS[reason];
}
