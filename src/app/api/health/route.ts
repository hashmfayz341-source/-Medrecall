import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    status: "ok",
    service: "medrecall",
    milestone: 1,
    provider: "deterministic",
    timestamp: new Date().toISOString(),
  });
}
