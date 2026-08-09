import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/ask";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const { q } = await req.json();
    const answer = await answerQuestion(typeof q === "string" ? q : "");
    return NextResponse.json(answer);
  } catch {
    return NextResponse.json({ headline: "Something went wrong answering that. Try again." }, { status: 200 });
  }
}
