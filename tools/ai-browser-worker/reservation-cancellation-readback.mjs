// Verifies the AI-selected cancellation; business intent comes from the conversation.
export function exactRegisteredCancellationReadback(authoritative, mutation) {
  const before=authoritative?.before, after=authoritative?.after;
  if (!before?.contract || !after?.contract || before.contract.status !== '예약' || after.contract.status !== '취소'
      || !Array.isArray(before.schedule?.rows) || !Array.isArray(after.schedule?.rows)
      || after.schedule.rows.length !== 0 || !Array.isArray(after.schedule.periods) || after.schedule.periods.length !== 0
      || JSON.stringify(after.schedule.topLevelQuantities) !== '{}'
      || Object.hasOwn(authoritative,'requestFinalization')) return false;
  for (const [key,field] of [['startDate','start_date'],['startTime','start_time'],['endDate','end_date'],['endTime','end_time']]) {
    if (!mutation.expected_period?.[field] || before.contract[key] !== mutation.expected_period[field] || after.contract[key] !== before.contract[key]) return false;
  }
  const beforeOther={...before.contract}, afterOther={...after.contract};
  delete beforeOther.status; delete afterOther.status;
  if (JSON.stringify(beforeOther)!==JSON.stringify(afterOther)) return false;
  const expected=mutation.expected_before;
  if (!Array.isArray(expected) || !expected.length || expected.length!==before.schedule.rows.length) return false;
  const seen=new Set();
  return expected.every(row=>{
    if (!row.schedule_id?.startsWith(mutation.trade_id+'-') || seen.has(row.schedule_id)) return false;
    seen.add(row.schedule_id);
    const matches=before.schedule.rows.filter(x=>x.scheduleId===row.schedule_id);
    return matches.length===1 && matches[0].name===row.name && matches[0].qty===row.quantity;
  });
}
