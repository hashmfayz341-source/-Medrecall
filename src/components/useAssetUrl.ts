"use client";

import { useEffect, useState } from "react";
import { loadAssetUrl } from "@/lib/persistence/assetStore";

/**
 * The object URL of a stored page/figure asset, or null while loading or
 * when the asset is missing (storage cleared, older browser). Cards render
 * without their image in that case; nothing else changes.
 */
export function useAssetUrl(assetId: string | undefined): { url: string | null; missing: boolean } {
  const [state, setState] = useState<{ id: string | undefined; url: string | null; missing: boolean }>({ id: assetId, url: null, missing: false });
  useEffect(() => {
    let cancelled = false;
    if (!assetId) return;
    loadAssetUrl(assetId).then((url) => {
      if (!cancelled) setState({ id: assetId, url, missing: url === null });
    });
    return () => {
      cancelled = true;
    };
  }, [assetId]);
  return state.id === assetId ? { url: state.url, missing: state.missing } : { url: null, missing: false };
}
