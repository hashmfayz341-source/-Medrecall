import { StudySession } from "@/components/StudySession";

export default async function StudyPage({
  params,
}: {
  params: Promise<{ lectureId: string }>;
}) {
  const { lectureId } = await params;
  return <StudySession key={lectureId} lectureId={lectureId} />;
}
