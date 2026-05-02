/**
 * villageAiClient.gs — village-ai API 호출 래퍼
 */

function villageAi_getUrl() {
  const url = PropertiesService.getScriptProperties().getProperty('VILLAGE_AI_URL');
  if (!url) throw new Error('VILLAGE_AI_URL 스크립트 속성 없음 — 설정 필요');
  return url.replace(/\/$/, '');
}

/**
 * POST /api/advise-booking
 * @return { verdict: 'ok'|'warn'|'block', blocks: string[], warnings: string[], notes: string[] }
 */
function villageAi_adviseBooking(data) {
  const payload = {
    requestId: String(data.requestId || ''),
    carryOut: {
      date: villageAi_fmtDate(data.carryOutDate),
      time: villageAi_fmtTime(data.carryOutTime)
    },
    return: {
      date: villageAi_fmtDate(data.returnDate),
      time: villageAi_fmtTime(data.returnTime)
    },
    equipment: String(data.equipment || ''),
    quantity: Number(data.quantity) || 0,
    customerName: String(data.customerName || ''),
    customerPhone: String(data.customerPhone || ''),
    company: data.company ? String(data.company) : null,
    availability: String(data.result || ''),
    availabilityCheckedAt: null,
    detail: String(data.detail || ''),
    extraRequest: String(data.extraRequest || ''),
    note: String(data.note || '')
  };

  const res = UrlFetchApp.fetch(villageAi_getUrl() + '/api/advise-booking', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = res.getResponseCode();
  const body = res.getContentText();

  if (code !== 200) {
    throw new Error(`advise-booking HTTP ${code}: ${body.slice(0, 200)}`);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new Error('advise-booking 응답 JSON 파싱 실패');
  }
}

function villageAi_fmtDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
  return String(v || '');
}

function villageAi_fmtTime(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'HH:mm');
  return String(v || '');
}
