import { Suspense } from "react";
import { CustomStudy } from "@/components/CustomStudy";

export default function CustomStudyPage() {
  return (
    <Suspense fallback={<p className="p-8 text-ink-500">Loading your cards…</p>}>
      <CustomStudy />
    </Suspense>
  );
}
