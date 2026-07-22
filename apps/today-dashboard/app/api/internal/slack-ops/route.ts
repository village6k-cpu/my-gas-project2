import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { applySlackOpsPlan, markSlackOpsEvent, scanSlackOpsEvents } from "@/lib/server/slackOps";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: NextRequest): boolean {
  const header = req.headers.get("authorization") || "";
  const actual = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!actual) return false;

  // AX2 already needs the workspace bot token to read #단톡방. Keep the
  // dedicated sync secret valid when configured, while also accepting that
  // same bot token for this single internal endpoint. Using `||` here made a
  // configured sync secret silently disable the documented bot-token fallback.
  const expectedSecrets = [process.env.SLACK_OPS_SYNC_SECRET, process.env.SLACK_BOT_TOKEN]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!expectedSecrets.length) return false;

  const a = Buffer.from(actual);
  return expectedSecrets.some((expected) => {
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

function jsonError(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : String(error);
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return jsonError("인증 실패", 401);
  return NextResponse.json({ ok: true, service: "slack-heybilli-sync" });
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return jsonError("인증 실패", 401);
  try {
    const body = await req.json() as Record<string, unknown>;
    const mode = String(body.mode || "");
    if (mode === "scan") return NextResponse.json(await scanSlackOpsEvents(Array.isArray(body.events) ? body.events : []));
    if (mode === "apply") return NextResponse.json(await applySlackOpsPlan(body.plan, body.execute === true));
    if (mode === "needs_context" || mode === "ignored") {
      return NextResponse.json(await markSlackOpsEvent(body.event, mode, String(body.reason || "")));
    }
    return jsonError("지원하지 않는 mode", 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /바뀌었습니다|직전에|먼저 scan/.test(message) ? 409 : 400;
    return jsonError(error, status);
  }
}
