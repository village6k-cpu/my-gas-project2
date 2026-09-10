import 'server-only';
import { checkedChannelId } from './slackOps';
import { employeeMessages } from './slackOpsResolution';
import { getInventoryAuditServiceClient } from './inventoryAuditDb';
import { lookupEquipment, validateEquipmentReports, mergeEquipmentSheetNote } from './slackEquipmentCore.mjs';
import { getInventoryAuditMirrorConfig, syncEquipmentMasterNotes } from './inventoryAuditMirrorCore.mjs';

type EventRef = {channelId:string; messageTs:string; sourceHash:string};
type LedgerNote = {equipment_id:string;note:string|null;open_issues:Array<{label?:string}>;updated_at:string};
type Receipt = {channel_id:string;message_ts:string;equipment_id:string;updated_at:string;synced_at:string|null;report:{label?:string};previous_labels:string[];mirrored_segments:string[]|null};
async function readEvent(input: unknown) {
  const raw = (input || {}) as EventRef;
  const event = {channelId:checkedChannelId(raw.channelId),messageTs:String(raw.messageTs || ''),sourceHash:String(raw.sourceHash || '')};
  const db = getInventoryAuditServiceClient();
  const {data,error} = await db.from('slack_ops_events').select('source_hash,raw_context').eq('channel_id',event.channelId).eq('message_ts',event.messageTs).maybeSingle();
  if(error) throw new Error('Slack 장비 보고 원문 조회 실패');
  if(!data || data.source_hash !== event.sourceHash) throw new Error('Slack 스레드가 바뀌었습니다. 다시 scan해 주세요');
  const sourceMessages = employeeMessages({messageTs:event.messageTs,root:data.raw_context.root,replies:data.raw_context.replies || []});
  return {db,event:{...event,sourceMessages},source:sourceMessages.join('\n')};
}

async function catalog() {
  const db = getInventoryAuditServiceClient();
  const rows = [];
  for(let from=0;from<100_000;from+=500) {
    const {data,error} = await db.from('equipment_ledger').select('equipment_id,name,aliases,state').order('equipment_id').range(from,from+499);
    if(error) throw new Error('장비 원장 조회 실패');
    rows.push(...data);
    if(data.length<500) return rows;
  }
  throw new Error('장비 원장 조회 범위 초과');
}

export async function lookupSlackEquipment(input:unknown, query:unknown) {
  const {event,source} = await readEvent(input);
  return {ok:true,event,...lookupEquipment(source,query,await catalog())};
}

// Reconcile every previously recorded equipment ID, even after delivery. This
// also repairs a concurrent older full-ledger mirror overwriting a newer note.
export async function syncSlackEquipmentNotes(dryRun=false) {
  const db = getInventoryAuditServiceClient();
  const receipts: Receipt[] = [];
  for(let from=0;from<100_000;from+=500) {
    const {data,error} = await db.from('slack_equipment_reports').select('channel_id,message_ts,equipment_id,updated_at,synced_at,report,previous_labels,mirrored_segments').order('channel_id').order('message_ts').order('equipment_id').range(from,from+499);
    if(error) throw new Error('장비 보고 반영 대기 내역 조회 실패');
    receipts.push(...data);
    if(data.length<500) break;
    if(from===99_500) throw new Error('장비 보고 조회 범위 초과');
  }
  if(!receipts.length) return {ok:true,dryRun,updateCount:0};
  const ids = [...new Set(receipts.map(row=>row.equipment_id))];
  const ledger: LedgerNote[] = [];
  for(let i=0;i<ids.length;i+=200) {
    const {data,error} = await db.from('equipment_ledger').select('equipment_id,note,open_issues,updated_at').in('equipment_id',ids.slice(i,i+200));
    if(error) throw new Error('장비 보고 원장 조회 실패');
    ledger.push(...data);
  }
  if(ledger.length !== ids.length) throw new Error('장비 보고 원장 누락');
  const config = getInventoryAuditMirrorConfig();
  let preparedLedger: LedgerNote[] = [];
  const deferred: Array<{equipmentId:string;message:string}> = [];
  const result = await syncEquipmentMasterNotes({ledger,...config,dryRun,
    prepareLedger: async (rows:LedgerNote[], sheetNotes:Map<string,string>, preview:boolean) => {
      for(const row of rows) {
        try {
        if(!sheetNotes.has(row.equipment_id)) throw new Error('장비마스터에 해당 장비 행이 없습니다');
        const related = receipts.filter(r=>r.equipment_id===row.equipment_id);
        const labels = related.flatMap(r=>[r.report?.label,...(r.previous_labels || []),...(r.mirrored_segments || [])]);
        const note = mergeEquipmentSheetNote(sheetNotes.get(row.equipment_id),row,labels);
        if(note === (row.note || '')) {preparedLedger.push(row);continue;}
        // Without a previous mirror snapshot, an extra sheet note could be an
        // old resolved issue, not new handwriting. Preserve both stores until reviewed.
        if(!related.some(r=>Array.isArray(r.mirrored_segments))) throw new Error('장비마스터 기존 비고와 원장이 달라 원문을 보존했습니다. 최초 비고 대조가 필요합니다');
        if(preview) {row.note=note;preparedLedger.push(row);continue;}
        const {data,error} = await db.rpc('preserve_slack_equipment_sheet_note',{p_equipment_id:row.equipment_id,p_expected_updated_at:row.updated_at,p_note:note});
        if(error || !data?.updated_at) throw new Error('시트 수기 비고 보존 중 원장이 변경됐습니다. 다음 실행에서 재시도합니다');
        row.note=note; row.updated_at=data.updated_at;
        preparedLedger.push(row);
        } catch(error) {deferred.push({equipmentId:row.equipment_id,message:error instanceof Error?error.message:'장비 비고 대조 실패'});}
      }
      return preparedLedger;
    },
  });
  if(dryRun) return {ok:!deferred.length,...result,pending:deferred};
  const preparedIds = preparedLedger.map(row=>row.equipment_id);
  // Only acknowledge the version actually read back from the sheet.
  for(let i=0;i<preparedIds.length;i+=200) {
    const {data,error} = await db.from('equipment_ledger').select('equipment_id,updated_at').in('equipment_id',preparedIds.slice(i,i+200));
    if(error || data?.some(row=>row.updated_at !== ledger.find(before=>before.equipment_id===row.equipment_id)?.updated_at)) throw new Error('장비 원장이 반영 중 바뀌었습니다. 다음 실행에서 재시도합니다');
  }
  for(const receipt of receipts) {
    const pending = deferred.find(row=>row.equipmentId===receipt.equipment_id);
    if(pending) {
      const {error} = await db.from('slack_equipment_reports').update({synced_at:null,last_error:pending.message})
        .eq('channel_id',receipt.channel_id).eq('message_ts',receipt.message_ts).eq('equipment_id',receipt.equipment_id).eq('updated_at',receipt.updated_at);
      if(error) throw new Error('장비 비고 보류 기록 저장 실패');
      continue;
    }
    const row = ledger.find(r=>r.equipment_id===receipt.equipment_id)!;
    const segments = [...new Set([...(receipt.mirrored_segments || []),row.note,...row.open_issues.map(i=>i.label)].filter(Boolean))];
    if(receipt.synced_at && JSON.stringify(receipt.mirrored_segments)===JSON.stringify(segments)) continue;
    const {error} = await db.from('slack_equipment_reports').update({synced_at:new Date().toISOString(),last_error:null,mirrored_segments:segments})
      .eq('channel_id',receipt.channel_id).eq('message_ts',receipt.message_ts).eq('equipment_id',receipt.equipment_id).eq('updated_at',receipt.updated_at);
    if(error) throw new Error('장비마스터 반영 확인 저장 실패');
  }
  return {ok:!deferred.length,...result,pending:deferred};
}

export async function recordSlackEquipment(input:unknown, rawReports:unknown, execute:boolean, finish:boolean) {
  const {db,event,source} = await readEvent(input);
  const reports = validateEquipmentReports(source,event,rawReports,await catalog());
  if(!execute) return {ok:true,dryRun:true,event,reports,finish};
  const {data,error} = await db.rpc('record_slack_equipment_reports',{
    p_channel_id:event.channelId,p_message_ts:event.messageTs,p_source_hash:event.sourceHash,p_reports:reports,p_finish:finish,
  });
  if(error) throw new Error('장비 보고 저장 실패. 원문과 현재 장비 원장을 다시 확인해 주세요');
  // A failed projection must never replay a trade mutation. The durable receipt
  // is sufficient to retry notes alone on every subsequent cron scan.
  try { return {...data,durable:true,mirror:await syncSlackEquipmentNotes()}; }
  catch { return {...data,durable:true,mirror:{ok:false,pending:true,message:'장비 보고는 저장됐으며 장비마스터 비고 반영은 다음 실행에서 재시도합니다'}}; }
}
