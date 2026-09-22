import { LearnSession } from "@/components/LearnSession";

export default async function LearnPage({
  params,
}: {
  params: Promise<{ lectureId: string }>;
}) {
  const { lectureId } = await params;
  return <LearnSession key={lectureId} lectureId={lectureId} />;
}
