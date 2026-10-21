// Transport completeness only. Reservation meaning and authorization remain AI decisions.
const compact = value => String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();

export function assessKakaoCaptureIntegrity(evidence = {}, job = {}) {
  const lines = Array.isArray(evidence.visible_static_text_tail)
    ? evidence.visible_static_text_tail : String(evidence.visible_static_text_tail || '').split(/[\n,]+/);
  if (evidence.capture_integrity?.ok === false) return evidence.capture_integrity;
  if (lines.some(line => /^(?:연결\s*끊김|대화가\s*불가능한\s*상태입니다)[.!\s]*$/.test(String(line).trim()))) {
    return { ok: false, reason: 'conversation_disconnected' };
  }
  const latestEvent = Array.isArray(job.events) ? job.events.at(-1) : null;
  const preview = compact(job.messagePreview || job.message_preview
    || latestEvent?.messagePreview || latestEvent?.raw?.messagePreview || job.payload?.messagePreview);
  if (!preview) return { ok: true, reason: 'no_structured_trigger' };
  // Kakao list media labels describe an attachment, not a literal text bubble.
  // Leave image/file interpretation to the existing AI path; disconnected UI still fails above.
  if (/^(?:사진(?:\d+장)?|동영상|이모티콘|파일|photo|video|emoticon|file)$/i.test(preview)) {
    return { ok: true, reason: 'non_text_trigger' };
  }
  const needle = preview.replace(/(?:…|\.{3})+$/u, '');
  // Prefer message bubbles: list previews and room memos are not conversation evidence.
  const messages = Array.isArray(evidence.messages) && evidence.messages.length
    ? evidence.messages.map(message => message.text) : lines;
  const found = needle && messages.some(message => compact(message).includes(needle));
  return found ? { ok: true, reason: 'trigger_message_observed' }
    : { ok: false, reason: 'trigger_message_missing' };
}
