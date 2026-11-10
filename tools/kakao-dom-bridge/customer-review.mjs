import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  applyPreparedKakaoDecision, buildAuthoritativePriceVerification,
  canExecuteCustomerReply, isKakaoUiPlaceholderLine, readCustomerReplyExecutionPolicy,
  sendKakaoMessageViaChrome
} from '../ai-browser-worker/worker.mjs';
import { automaticQuoteRequest, automaticStatementRequest, pricingDocumentRequested } from '../ai-browser-worker/verified-pricing.mjs';
import { queuePricingOwnerNotice } from '../ai-browser-worker/pricing-owner-notices.mjs';

const approvalAction = 'village_customer_review_approve';
const lifetimeMs = 2 * 60 * 60 * 1000;
const hash = value => createHash('sha256').update(value).digest('hex');
const ownerId = value => /^U[A-Z0-9]+$/.test(value || '');
const reviewDir = config => path.join(config.queueDir, 'pricing-owner-notices');

function reportChannel(config) {
  const channel = config.customerReportSlackChannelId ?? process.env.AI_WORKER_CUSTOMER_REPORT_SLACK_CHANNEL_ID;
  if (channel === undefined || channel === '') return config.pricingOwnerSlackUserId;
  return /^[CG][A-Z0-9]+$/.test(channel) ? channel : '';
}

function freshJob(job, now) {
  const time = Date.parse(job.detectedAt || job.detected_at || '');
  const events = job.events || [];
  return Number.isFinite(time) && time <= now && now - time < lifetimeMs
    && !job.replayedFromSupabase
    && !events.some(event => event.recoveryOnly || event.reason === 'startup_catchup')
    && events.some(event => ['top_row_changed', 'top_rows_backstop', 'mutation'].includes(event.reason));
}

function reviewDraft(decision) {
  const value = String(decision.reply_decision?.text || decision.suggested_reply_draft || '').trim();
  return value.length >= 5 && value.length <= 1800 && !isKakaoUiPlaceholderLine(value)
    && !/(?:원장|스크립트|API 키|저장소|^FINAL_JSON|셀프 리뷰)/i.test(value) ? value : '';
}

async function documentRequest(config, decision, job) {
  const verification = await buildAuthoritativePriceVerification(config, decision);
  if (decision.statement_request) return automaticStatementRequest({config, decision, verification, job});
  return {...automaticQuoteRequest({decision, verification, job}), action: 'prepareKakaoQuoteReview'};
}

async function fetchDocument(config, body, dryRun) {
  if (!config.documentApiBaseUrl || !config.documentApiKey) throw new Error('document_api_unavailable');
  const response = await (config.fetchImpl || fetch)(config.documentApiBaseUrl, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({...body, key: config.documentApiKey, dryRun}),
    signal: AbortSignal.timeout(dryRun ? 30000 : 65000)
  });
  const result = await response.json();
  if (!response.ok || result.status !== (dryRun ? 'VERIFIED' : 'PREPARED')
    || result.totalVatIncluded !== body.expectedTotal
    || result.documentType !== (body.action === 'prepareAutomaticStatement' ? 'statement' : 'quote')) {
    throw new Error('document_source_unverified');
  }
  return result;
}

function documentBlock(doc) {
  if (!doc) return '';
  const label = doc.type === 'statement' ? '거래명세서' : '견적서';
  return `\n${label} · ${doc.total.toLocaleString('ko-KR')}원 (부가세 포함)\n미리보기 ${doc.url}`;
}

export async function queueCustomerReview({config, job, prepared, applied, now = Date.now()}) {
  const decision = prepared?.decision;
  const snapshot = prepared?.snapshot;
  const evidence = snapshot?.navigation?.conversation_evidence;
  const lastRole = evidence?.messages?.at(-1)?.role;
  const result = applied?.autoReplyResult || {};
  const channel = reportChannel(config);
  if (!channel || !ownerId(config.pricingOwnerSlackUserId) || !freshJob(job, now) || !decision
    || evidence?.capture_integrity?.ok !== true || evidence.hint_matched !== true
    || !/^chat:\d+$/.test(snapshot.roomKey) || snapshot.roomRevision < 1
    || !['customer', 'unknown'].includes(lastRole)
    || result.attempted === true || result.sent === true || result.pricingDocumentReceipt
    || result.pricingDocumentFailure || applied?.superseded || applied?.snapshotChanged
    || ['duplicate_recent_auto_reply', 'duplicate_room_reply_text_24h'].includes(result.gate?.reason)) return false;
  const mode = decision.reply_decision?.replyMode;
  if (mode === 'no_reply') return false;
  const work = (decision.follow_up_items || []).find(item => item.requiresHumanAction === true);
  if (lastRole === 'unknown' && (!work || evidence.capture_integrity.reason !== 'trigger_message_observed')) return false;
  const typedDocument = pricingDocumentRequested(decision);
  const needsDocument = typedDocument || work?.type === 'contract_document';
  if (!work && mode !== 'draft_only' && !(needsDocument && mode === 'auto_send')) return false;
  const draft = reviewDraft(decision);
  const key = hash(`customer-review:${snapshot.roomKey}:${snapshot.roomRevision}`);
  const dir = reviewDir(config);
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  try { await fs.access(path.join(dir, key + '.json')); return true; } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let doc = null;
  if (typedDocument && decision.price_quote && draft) {
    try {
      const body = await documentRequest(config, decision, job);
      const preparedDocument = await fetchDocument(config, body, false);
      const bytes = Buffer.from(preparedDocument.pdfBase64 || '', 'base64');
      const url = new URL(preparedDocument.ownerUrl);
      if (preparedDocument.operationId !== body.operationId || preparedDocument.documentAccess !== 'private'
        || preparedDocument.mimeType !== 'application/pdf' || bytes.length < 30 || bytes.length > 10 * 1024 * 1024
        || bytes.subarray(0, 5).toString() !== '%PDF-' || hash(bytes) !== preparedDocument.pdfSha256
        || url.origin !== 'https://docs.google.com' || !/^\/spreadsheets\/d\/[A-Za-z0-9_-]+/.test(url.pathname)) {
        throw new Error('document_preview_unverified');
      }
      const pdf = path.join(dir, key + (preparedDocument.documentType === 'statement' ? '-거래명세서.pdf' : '-견적서.pdf'));
      await fs.writeFile(pdf, bytes, {mode: 0o600});
      doc = {type: preparedDocument.documentType, total: preparedDocument.totalVatIncluded, url: url.href,
        pdf, pdfSha256: preparedDocument.pdfSha256, requestHash: hash(JSON.stringify(body))};
    } catch { /* The card will show the unresolved document and will not offer approval. */ }
  }
  const hasApproval = lastRole === 'customer' && Boolean(draft) && (!needsDocument || Boolean(doc)) && (!work || mode === 'draft_only' || Boolean(doc))
    && !/^(?:schedule_check|reservation_review|payment_check|tax_invoice|price_review)$/.test(work?.type || '')
    && (!/\d\s*원/.test(draft) || Boolean(doc));
  const hint = String(work?.recommended_action || work?.summary || '').trim()
    .replace(/01[016789][ -]?\d{3,4}[ -]?\d{4}/g, '[연락처 생략]').slice(0, 400);
  const customer = String(decision.customer?.name || job.customerName || '고객').replace(/\d{3}[- ]?\d{4}[- ]?\d{4}/g, '').slice(0, 70);
  const text = [`카카오 응대 검토 · ${customer}`, draft && `${hasApproval ? '보낼 답변' : '검토용 초안'}\n${draft}`,
    documentBlock(doc), needsDocument && !doc && '확인 필요 · 요청한 문서의 대상·품목·금액을 각각 확인해 주세요.',
    hint && `남은 확인 · ${hint}`, lastRole === 'unknown' && '카카오에서 발신자 구분을 확인해 주세요.', !hasApproval && '내용 확인 후 후속조치에서 처리해 주세요.']
    .filter(Boolean).join('\n\n');
  const clientMsgId = `${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20,32)}`;
  await queuePricingOwnerNotice(dir, {schema: 'village-pricing-owner-notice/v1', key, clientMsgId,
    channel, requiresHumanAction: true, state: 'pending',
    createdAt: new Date(now).toISOString(), text,
    ...(hasApproval ? {approval: {action: approvalAction, value: key},
      review: {job, snapshot, decision, draft, doc, status: 'ready'}} : {})});
  return true;
}

async function writeNotice(file, value) {
  const tmp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value), {mode: 0o600, flag: 'wx'});
  await fs.rename(tmp, file);
}

const running = new Set();
export async function approveCustomerReview(config, input, now = Date.now(), apply = applyPreparedKakaoDecision) {
  const key = String(input.value || '');
  if (!/^[a-f0-9]{64}$/.test(key) || !ownerId(config.pricingOwnerSlackUserId)
    || input.user_id !== config.pricingOwnerSlackUserId || running.has(key)) return {state: 'unavailable'};
  running.add(key);
  try {
    const file = path.join(reviewDir(config), key + '.json');
    const notice = JSON.parse(await fs.readFile(file, 'utf8'));
    const review = notice.review;
    if (!review || review.status !== 'ready' || notice.state !== 'sent'
      || notice.slackChannel !== input.channel_id || notice.slackTs !== input.message_ts
      || now - Date.parse(notice.createdAt) > lifetimeMs || !freshJob(review.job, now)) return {state: 'expired'};
    review.status = 'sending';
    await writeNotice(file, notice);
    let verified = false;
    try {
      const doc = review.doc;
      if (doc) {
        const body = await documentRequest(config, review.decision, review.job);
        if (hash(JSON.stringify(body)) !== doc.requestHash || hash(await fs.readFile(doc.pdf)) !== doc.pdfSha256) {
          throw new Error('document_changed');
        }
        await fetchDocument(config, body, true);
      }
      const applied = await apply({
        config: {...config, openTargetChat: true}, job: review.job,
        prepared: {status: 'ai_prepared', snapshot: review.snapshot, decision: review.decision},
        dependencies: {sendReply: async ({config, decision, navigationContext, dependencies}) => {
          const target = new URL(navigationContext.conversation_target?.url || 'about:blank');
          const expectedRoomId = review.snapshot.roomKey.slice('chat:'.length);
          if (target.origin !== 'https://business.kakao.com' || !target.pathname.endsWith('/chats/' + expectedRoomId)) {
            return {sent:false};
          }
          const policy = await readCustomerReplyExecutionPolicy(config);
          if (!canExecuteCustomerReply(decision, policy).allowed || (doc && policy.status !== 'active')) return {sent: false};
          await dependencies.assertFreshBeforeSend();
          const sent = await sendKakaoMessageViaChrome(review.draft, navigationContext, {
            timeoutMs: config.autoSendTimeoutMs, cuaDriverCommand: config.cuaDriverCommand,
            requireAutomationChromeProfile: config.requireAutomationChromeProfile,
            controlMode: config.workerControlMode, cuaMinIdleSeconds: config.cuaMinIdleSeconds,
            attachmentPaths: doc ? [doc.pdf] : []
          });
          return {sent: sent.sent === true && sent.readback_confirmed === true
            && (!doc || sent.attachments?.attached === true)};
        }}
      });
      verified = applied.autoReplyResult?.sent === true;
    } catch { /* Persist uncertainty; an approval must never replay a possibly sent message. */ }
    review.status = verified ? 'sent' : 'needs_review';
    await writeNotice(file, notice);
    return {state: review.status};
  } catch {
    return {state: 'unavailable'};
  } finally {
    running.delete(key);
  }
}

export async function recordCustomerCompletion(config, job, applied, now = Date.now()) {
  if (!ownerId(config.pricingOwnerSlackUserId) || !freshJob(job, now)) return;
  const result = applied?.autoReplyResult;
  const document = result?.pricingDocumentReceipt;
  const reply = result?.sent === true && Boolean(result.readbackReceipt?.id);
  if (!reply && !document?.deliveryConfirmed) return;
  const jobId = job.jobId || job.id;
  if (!jobId) return;
  const key = hash(String(jobId));
  const directory = path.join(config.queueDir, 'customer-completion-digests');
  const customer = String(job.customerName || job.customer_name || '').replace(/[<>@&\r\n]/g, '')
    .replace(/01[016789][ -]?\d{3,4}[ -]?\d{4}/g, '').trim().slice(0, 70);
  await fs.mkdir(directory, {recursive:true, mode:0o700});
  await fs.writeFile(path.join(directory, key + '.json'), JSON.stringify({
    at:now, customer, reply, document:document?.deliveryConfirmed ? document.documentType : null
  }), {flag:'wx', mode:0o600}).catch(error => { if (error.code !== 'EEXIST') throw error; });
}

export async function queueCustomerCompletionDigest(config, now = Date.now()) {
  const channel = reportChannel(config);
  if (!channel || !ownerId(config.pricingOwnerSlackUserId)) return;
  const directory = path.join(config.queueDir, 'customer-completion-digests');
  const files = await fs.readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const hour = 60 * 60 * 1000;
  const end = Math.floor(now / hour) * hour;
  if (!files.length) return;
  const cursor = path.join(directory, 'reported-through.json');
  const lastEnd = await fs.readFile(cursor, 'utf8').then(value => Number(JSON.parse(value)))
    .catch(error => { if (error.code === 'ENOENT') return end - hour; throw error; });
  if (lastEnd >= end) return;
  const start = Math.max(lastEnd, end - 24 * hour);
  const counts = {reply:0, quote:0, statement:0};
  const completed = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const entry = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'));
    if (entry.at < end - 24 * hour) {
      await fs.unlink(path.join(directory, file)).catch(() => {});
      continue;
    }
    if (entry.at < start || entry.at >= end) continue;
    if (entry.reply) counts.reply += 1;
    if (entry.document === 'quote' || entry.document === 'statement') counts[entry.document] += 1;
    completed.push(entry);
  }
  const lines = completed.sort((left, right) => left.at - right.at).slice(0, 15).map(entry => {
    const actions = [entry.reply && '답변', entry.document === 'quote' && '견적서', entry.document === 'statement' && '거래명세서'];
    return `• ${entry.customer || '카카오 문의'} · ${actions.filter(Boolean).join(' / ')}`;
  });
  if (completed.length > lines.length) lines.push(`외 ${completed.length - lines.length}건`);
  const key = hash(`customer-completion:${end}`);
  const clientMsgId = `${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-a${key.slice(17,20)}-${key.slice(20,32)}`;
  if (Object.values(counts).some(Boolean)) await queuePricingOwnerNotice(reviewDir(config), {schema:'village-pricing-owner-notice/v1',
    kind:'completion_digest', key, clientMsgId, channel,
    requiresHumanAction:false, state:'pending', createdAt:new Date(now).toISOString(),
    text:[`카카오 자동처리 누적 결과 · 답변 ${counts.reply}건 · 견적서 ${counts.quote}건 · 거래명세서 ${counts.statement}건`,
      ...lines].join('\n')});
  await writeNotice(cursor, end);
}
