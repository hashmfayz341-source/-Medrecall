import { NextResponse } from "next/server";
import { pathologyCurriculum } from "@/lib/content/pathology";

/**
 * Shared curriculum state, served from the server.
 *
 * Learner state is deliberately absent: it is per-user and, in Milestone 1,
 * lives only in the browser. Keeping the split visible at the API boundary is
 * what makes a later server-side learner store a drop-in change.
 */
export const dynamic = "force-dynamic";

export function GET() {
  const { course, concepts } = pathologyCurriculum;
  return NextResponse.json({
    course: {
      id: course.id,
      title: course.title,
      description: course.description,
      lectures: course.lectures.map((l) => ({
        id: l.id,
        title: l.title,
        order: l.order,
        chunkCount: l.chunks.length,
      })),
    },
    conceptCounts: {
      total: concepts.length,
      active: concepts.filter((c) => c.status === "ACTIVE").length,
      draft: concepts.filter((c) => c.status === "DRAFT").length,
    },
  });
}
