'use strict';

// Mechanical validation only. The native model determines that the final form
// belongs to this exact pending inquiry; GAS compares the old identity under lock.
function normalizePendingCustomerIdentity(value, sourceText) {
  if (value === undefined || value === null) return null;
  const required=['expected_name','expected_phone','name','phone'];
  if (typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k=>![...required,'discount_type'].includes(k)) ||
      required.some(k=>typeof value[k] !== 'string')) throw new Error('customer_identity_update requires exact old and final identity fields');
  const result=Object.fromEntries(required.map(k=>[k,value[k].normalize('NFKC').trim()]));
  const phone=result.phone.replace(/\D/g,'');
  const oldPhone=result.expected_phone.replace(/\D/g,'');
  const source=String(sourceText||'').normalize('NFKC');
  if (!result.name || result.name.length>120 || !result.expected_name ||
      !/^[\d\s()+.\-]+$/.test(result.phone) || phone.length<8 || phone.length>15 ||
      (oldPhone && oldPhone!==phone) || !source.includes(result.name) ||
      !source.replace(/[\s()+.\-]/g,'').includes(phone)) throw new Error('customer_identity_update contradicts existing contact or selected customer evidence');
  if (value.discount_type !== undefined) {
    if (!['일반','학생','개인사업자/프리랜서','단골','제휴'].includes(value.discount_type)) throw new Error('customer_identity_update.discount_type is invalid');
    result.discount_type=value.discount_type;
  }
  return result;
}

function normalizePendingBaselinePeriod(value) {
  const fields=['start_date','start_time','end_date','end_time'];
  if (!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).length!==4 ||
      fields.some(k=>typeof value[k]!=='string')) throw new Error('expected_period requires all four fields, including unknown blanks');
  const result={};
  for(const key of fields) {
    const text=value[key].trim();
    if(text && (key.endsWith('date') ? !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
      !Number.isFinite(Date.parse(text+'T00:00:00Z')) || new Date(text+'T00:00:00Z').toISOString().slice(0,10)!==text
      : !/^(?:[01]\d|2[0-3]):00$/.test(text))) throw new Error('expected_period contains an invalid '+key);
    result[key]=text;
  }
  return result;
}

module.exports={normalizePendingCustomerIdentity,normalizePendingBaselinePeriod};
