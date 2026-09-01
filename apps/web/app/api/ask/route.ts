import { NextRequest, NextResponse } from "next/server";
import { answerQuestion } from "@/lib/ask";

export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const { q } = await req.json();
    const answer = await answerQuestion(typeof q === "string" ? q : "");
    return NextResponse.json(answer);
  } catch {
    return NextResponse.json({ headline: "Something went wrong answering that. Try again." }, { status: 200 });
  }
}
