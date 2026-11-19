import { NextRequest, NextResponse } from "next/server";
import { requireInventoryOwner } from "@/lib/server/inventoryAuditAuth";
import { getInventoryAuditServiceClient } from "@/lib/server/inventoryAuditDb";

export const dynamic = "force-dynamic";
const json = (data: unknown, status=200) => NextResponse.json(data,{status,headers:{"Cache-Control":"private, no-store"}});
const states = ["확인 필요","처리 중","해결","제외"];

export async function GET(req: NextRequest) {
  if (!await requireInventoryOwner(req)) return json({error:"운영자 로그인이 필요합니다."},403);
  try {
    const db=getInventoryAuditServiceClient();
    async function list(table: "incident_evidence"|"incident_reviews") {
      const entries=[];
      for(let start=0;;start+=300){
        let query=db.from(table).select(table==="incident_evidence"?"*":"case_key,revision,evidence_hash,state,note,reviewed_at").order("case_key");
        if(table==="incident_reviews")query=query.order("revision");
        const {data,error}=await query.range(start,start+299);
        if(error)throw error;
        entries.push(...(data??[]));if(!data||data.length<300)return entries;
      }
    }
    const [cases,reviews]=await Promise.all([list("incident_evidence"),list("incident_reviews")]);
    return json({cases,reviews});
  } catch {return json({error:"사건 원장 조회 실패. 다시 조회해 주세요."},503)}
}

export async function POST(req: NextRequest) {
  const user=await requireInventoryOwner(req);
  if(!user)return json({error:"운영자 로그인이 필요합니다."},403);
  const v=await req.json().catch(()=>null);
  if(!v||typeof v.key!=="string"||!states.includes(v.state)||!Number.isSafeInteger(v.revision)||v.revision<0||typeof v.note!=="string"||!v.note.trim()||v.note.length>2000)return json({error:"처리 메모와 상태를 확인하세요."},400);
  try {
    const db=getInventoryAuditServiceClient();
    const {data,error}=await db.from("incident_evidence").select("evidence_hash").eq("case_key",v.key).maybeSingle();
    if(error)throw error;
    if(!data||data.evidence_hash!==v.hash)return json({error:"근거가 변경됐습니다. 새로고침 후 확인하세요."},409);
    const {data:last,error:readError}=await db.from("incident_reviews").select("revision").eq("case_key",v.key).order("revision",{ascending:false}).limit(1).maybeSingle();
    if(readError)throw readError;
    if((last?.revision??0)!==v.revision)return json({error:"다른 검토가 저장됐습니다. 새로고침해 주세요."},409);
    const {error:writeError}=await db.from("incident_reviews").insert({case_key:v.key,evidence_hash:v.hash,revision:v.revision+1,state:v.state,note:v.note.trim(),reviewer:user.id});
    if(writeError?.code==="23505")return json({error:"이미 변경된 기록입니다. 새로고침해 주세요."},409);
    if(writeError)throw writeError;
    return json({saved:true});
  } catch {return json({error:"처리 이력 저장 실패"},503)}
}
