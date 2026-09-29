import { Suspense } from "react";
import { LectureView } from "@/components/LectureView";

export default async function LecturePage({
  params,
}: {
  params: Promise<{ lectureId: string }>;
}) {
  const { lectureId } = await params;
  return (
    <Suspense fallback={null}>
      <LectureView key={lectureId} lectureId={lectureId} />
    </Suspense>
  );
}
