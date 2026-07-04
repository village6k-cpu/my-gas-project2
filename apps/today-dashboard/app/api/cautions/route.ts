import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 20;

const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPA_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const authClient = SUPA_URL && SUPA_KEY ? createClient(SUPA_URL, SUPA_KEY) : null;

async function requireUser(req: NextRequest): Promise<boolean> {
  if (!authClient) return true;
  const header = req.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return false;
  const { data, error } = await authClient.auth.getUser(token);
  return !error && !!data.user;
}

export async function DELETE(req: NextRequest) {
  if (!(await requireUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const id = String(req.nextUrl.searchParams.get("id") || "").trim();
  if (!id) return NextResponse.json({ error: "id 필요" }, { status: 400 });

  const url = new URL("https://village-ai-six.vercel.app/api/cautions");
  url.searchParams.set("id", id);

  try {
    const res = await fetch(url.toString(), { method: "DELETE", cache: "no-store" });
    const text = await res.text();
    let body: unknown = text;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { ok: res.ok, body: text };
      }
    } else {
      body = { ok: res.ok };
    }
    return NextResponse.json(body, { status: res.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

async function proxyJsonMutation(req: NextRequest, method: "PUT" | "PATCH") {
  if (!(await requireUser(req))) return NextResponse.json({ error: "인증 필요" }, { status: 401 });

  const url = new URL("https://village-ai-six.vercel.app/api/cautions");
  const id = String(req.nextUrl.searchParams.get("id") || "").trim();
  if (method === "PATCH") {
    if (!id) return NextResponse.json({ error: "id 필요" }, { status: 400 });
    url.searchParams.set("id", id);
  }

  try {
    const body = await req.text();
    const res = await fetch(url.toString(), {
      method,
      headers: { "content-type": req.headers.get("content-type") || "application/json" },
      body,
      cache: "no-store",
    });
    const text = await res.text();
    let json: unknown = text;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = { ok: res.ok, body: text };
      }
    } else {
      json = { ok: res.ok };
    }
    return NextResponse.json(json, { status: res.status });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 });
  }
}

export async function PUT(req: NextRequest) {
  return proxyJsonMutation(req, "PUT");
}

export async function PATCH(req: NextRequest) {
  return proxyJsonMutation(req, "PATCH");
}
