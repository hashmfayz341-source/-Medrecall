import { Suspense } from "react";
import { CardBrowser } from "@/components/CardBrowser";

export default function CardBrowserPage() {
  return (
    <Suspense fallback={<p className="p-8 text-ink-500">Loading your cards…</p>}>
      <CardBrowser />
    </Suspense>
  );
}
