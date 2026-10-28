import { NextRequest, NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/server/authCache";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";
import { itemFromRow, tradeFromRow } from "@/lib/data/mappers";
import { transitionPacking, type PackingCommand } from "@/lib/domain/packing";

export async function POST(req: NextRequest) {
  const user = await getAuthedUser(req);
  if (!user) return NextResponse.json({ error: "직원 로그인 필요" }, { status: 401 });
  try {
    const text = await req.text();
    if (text.length > 100_000) return NextResponse.json({ error: "구성품 요청이 너무 큽니다" }, { status: 413 });
    const body = JSON.parse(text);
    if (!/^\d{6}-\d{3}$/.test(body.tradeId) || !Number.isSafeInteger(body.version) || body.version < 0) throw new Error("거래ID와 저장 버전을 확인해주세요");
    const db = getInventoryAuditServiceClient();
    const [tradeResult, itemResult] = await Promise.all([
      db.from("trades").select("*").eq("trade_id", body.tradeId).single(),
      db.from("schedule_items").select("*").eq("trade_id", body.tradeId).is("removed_at", null).order("sort"),
    ]);
    if (tradeResult.error || itemResult.error) throw new Error("예약 원본을 불러오지 못했습니다");
    const trade = tradeFromRow(tradeResult.data, (itemResult.data ?? []).map(itemFromRow));
    if ((trade.packing?.version ?? 0) !== body.version) return NextResponse.json({ error: "다른 직원이 수정했습니다. 최신 내역을 확인하고 다시 시도해주세요" }, { status: 409 });
    const command = body.command as PackingCommand;
    if (!command || typeof command.action !== "string") throw new Error("구성품 작업을 확인해주세요");
    const next = transitionPacking(trade, command, new Date().toISOString());
    const { data, error } = await db.rpc("save_packing_manifest", {
      p_trade_id: body.tradeId, p_version: body.version, p_next: next, p_actor: user.id, p_action: command.action,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: error.code === "40001" ? 409 : 422 });
    return NextResponse.json({ packing: data }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "구성품 저장 실패" }, { status: 422 });
  }
}
