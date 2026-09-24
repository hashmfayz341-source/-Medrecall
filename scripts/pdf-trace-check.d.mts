export declare const WORKER_FILE: string;
export declare const PDF_ROUTES: string[];
export declare function checkRouteManifest(manifestPath: string): {
  ok: boolean;
  reason: string;
  workerPath?: string;
};
export declare function checkAllPdfRoutes(
  projectRoot: string,
): { route: string; ok: boolean; reason: string; workerPath?: string }[];
