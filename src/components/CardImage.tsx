"use client";

import type { CardImage as CardImageRef } from "@/lib/domain/types";
import { useAssetUrl } from "./useAssetUrl";

/**
 * A card's visual: the original page or figure of the uploaded PDF, from the
 * browser asset store. Scales to the container without distorting the
 * aspect ratio. When the asset is gone (site data cleared) a short note
 * replaces it so the card still reads.
 */
export function CardImage({
  image,
  alt,
  className = "",
  size = "card",
  testId,
  hideWhenMissing = false,
}: {
  image: CardImageRef;
  alt: string;
  className?: string;
  size?: "card" | "thumb" | "page";
  testId?: string;
  /** Render nothing (instead of a note) when the asset is not stored. */
  hideWhenMissing?: boolean;
}) {
  const { url, missing } = useAssetUrl(image.assetId);
  const sizing = size === "thumb" ? "max-h-24" : size === "page" ? "max-h-[70vh]" : "max-h-[40vh]";
  if (missing && hideWhenMissing) return null;
  if (missing) {
    return (
      <p data-testid={testId ? `${testId}-missing` : undefined} className={`rounded-xl border border-dashed border-ink-300 bg-ink-50 p-3 text-center text-xs text-ink-500 ${className}`}>
        Image from page {image.pageNumber} is not available in this browser. Re-upload the PDF to restore it.
      </p>
    );
  }
  if (!url) {
    return <div aria-hidden className={`${sizing} h-24 w-full animate-pulse rounded-xl bg-ink-100 ${className}`} />;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- object URL from IndexedDB, not an optimisable remote image
    <img
      src={url}
      alt={alt}
      data-testid={testId}
      data-asset-id={image.assetId}
      data-page={image.pageNumber}
      className={`${sizing} mx-auto block h-auto w-auto max-w-full rounded-xl border border-ink-200 bg-white object-contain ${className}`}
    />
  );
}
