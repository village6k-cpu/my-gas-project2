#!/usr/bin/env node
// mine-kakao-corrections.mjs — 야간 응대 교정 채굴기 (v1, 결정론적)
//
// 목적: "봇이 발송한 뒤 사장이 수동으로 개입한 방"을 auto-replies.ndjson에서 찾아
// 사장 수동응대 원문 사례를 교정 원장(corrections-latest.md)에 적재한다.
// 워커는 매 판단마다 원장 앞부분을 프롬프트로 읽는다(buildCorrectionsPromptText).
// 사장의 수동 개입 자체가 라벨링이므로 별도 학습 데이터 작업이 필요 없다.
//
// 설계 원칙:
// - G-BRAIN(사업 참모용)과 의도적으로 분리 — 사장님 결정(2026-08-12).
// - v1은 AI 요약 없이 원문 사례만 적재 — 환각 0%. 교훈 추출은 라이브 모델이 사례를 보고 한다.
// - 원장은 사람이 편집/삭제할 수 있는 마크다운. 45일 지난 섹션과 총량 초과분은 자동 정리.
//
// 실행: node mine-kakao-corrections.mjs [--log <path>] [--out <path>] [--hours 36]
//       [--max-cards 8] [--dry-run]
// 기본 로그: ../kakao-dom-bridge/queue/auto-replies.ndjson
// 기본 원장: %LOCALAPPDATA%\Village\kakao-corrections\corrections-latest.md

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { normalizeAutoReplyText, isKakaoUiPlaceholderLine, isStaffSenderLabel } from './worker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEDGER_HEADER = [
  '# 빌리지 카카오 응대 교정 원장',
  '(사장 수동응대 사례 자동 채굴 — 자유롭게 편집/삭제해도 된다. 워커가 매 판단마다 앞부분 1500자를 읽으므로 최신 섹션이 위에 온다.)',
  ''
].join('\n');

function roomKeyOfEntry(entry) {
  const fromDedupe = String(entry?.dedupeKey || '').split('|')[0] || '';
  return normalizeAutoReplyText(fromDedupe) || normalizeAutoReplyText(entry?.customer || '');
}

function clip(value, max) {
  const v = normalizeAutoReplyText(value);
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

// 사장 수동 발화 판별: 스태프 라벨 발화인데 봇 발송 정본과 매칭되지 않는 것.
// evidence.message는 AI가 화면에서 옮겨 적은 값이라 발송 원문과 미세하게 다를 수 있어
// 정확 일치 외에 앞 60자 포함 관계도 봇 발송으로 간주한다(오탐보다 미탐이 안전).
function matchesBotSend(normalizedMessage, botSendTexts) {
  if (!normalizedMessage) return true;
  if (botSendTexts.has(normalizedMessage)) return true;
  const head = normalizedMessage.slice(0, 60);
  for (const sent of botSendTexts) {
    if (!sent) continue;
    if (sent.startsWith(head) || normalizedMessage.startsWith(sent.slice(0, 60))) return true;
  }
  return false;
}

export function extractOwnerInterventionCards(entries, { now = new Date(), windowMs = 36 * 60 * 60 * 1000, maxCards = 8 } = {}) {
  const botSendTexts = new Set();
  for (const entry of entries) {
    if (entry?.result?.sent === true) {
      const sent = normalizeAutoReplyText(entry?.result?.text || '');
      if (sent) botSendTexts.add(sent);
    }
  }

  // 방별 최신 evidence 스냅샷 + 그 방의 최근 봇 발송(대비용)
  const latestByRoom = new Map();
  const lastBotSendByRoom = new Map();
  for (const entry of entries) {
    const at = new Date(entry?.at || '');
    if (!Number.isFinite(at.getTime())) continue;
    const room = roomKeyOfEntry(entry);
    if (!room) continue;
    if (entry?.result?.sent === true) {
      const prev = lastBotSendByRoom.get(room);
      if (!prev || at > prev.at) lastBotSendByRoom.set(room, { at, text: normalizeAutoReplyText(entry?.result?.text || '') });
    }
    if (now.getTime() - at.getTime() > windowMs) continue;
    if (!Array.isArray(entry?.evidence) || !entry.evidence.length) continue;
    const prev = latestByRoom.get(room);
    if (!prev || at > prev.at) latestByRoom.set(room, { at, entry });
  }

  const cards = [];
  const seenOwnerMessages = new Set();
  const sortedRooms = [...latestByRoom.entries()].sort((a, b) => b[1].at - a[1].at);
  for (const [room, { at, entry }] of sortedRooms) {
    const customer = normalizeAutoReplyText(entry?.customer || '') || room;
    for (const item of entry.evidence) {
      if (!isStaffSenderLabel(item?.sender)) continue;
      const message = normalizeAutoReplyText(item?.message || '');
      if (message.length < 5) continue;
      if (isKakaoUiPlaceholderLine(message)) continue;
      if (message.startsWith('[첨부]')) continue; // 파일 첨부는 응대 문장이 아니다
      if (matchesBotSend(message, botSendTexts)) continue;
      if (seenOwnerMessages.has(message)) continue;
      seenOwnerMessages.add(message);
      const botContrast = lastBotSendByRoom.get(room);
      const dateLabel = `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
      const contrastText = botContrast?.text ? ` (직전 봇 발송: "${clip(botContrast.text, 80)}")` : '';
      cards.push(`- [${dateLabel} ${clip(customer, 12)}] 사장 수동응대: "${clip(message, 140)}"${contrastText}`);
      if (cards.length >= maxCards) return cards;
    }
  }
  return cards;
}

export function mergeCorrectionsLedger(existing, cards, { now = new Date(), maxAgeDays = 45, maxChars = 6000 } = {}) {
  const today = now.toISOString().slice(0, 10);
  // 기존 원장을 섹션(## YYYY-MM-DD) 단위로 파싱
  const sections = new Map();
  const body = String(existing || '');
  const sectionRegex = /^## (\d{4}-\d{2}-\d{2})\s*$/gm;
  const marks = [];
  let match;
  while ((match = sectionRegex.exec(body))) marks.push({ date: match[1], index: match.index });
  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].index;
    const end = i + 1 < marks.length ? marks[i + 1].index : body.length;
    const content = body.slice(start, end).split('\n').slice(1).join('\n').trim();
    if (content) sections.set(marks[i].date, content);
  }

  // 원장 전체에서 이미 본 카드(원문 기준)는 재적재하지 않는다
  const existingLines = new Set();
  for (const content of sections.values()) {
    for (const line of content.split('\n')) existingLines.add(normalizeAutoReplyText(line));
  }
  const freshCards = cards.filter((card) => !existingLines.has(normalizeAutoReplyText(card)));
  if (freshCards.length) {
    const todayContent = sections.get(today);
    sections.set(today, todayContent ? `${freshCards.join('\n')}\n${todayContent}` : freshCards.join('\n'));
  }

  // 오래된 섹션 제거 + 최신순 정렬
  const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const kept = [...sections.entries()]
    .filter(([date]) => date >= cutoff)
    .sort((a, b) => (a[0] < b[0] ? 1 : -1));

  let output = LEDGER_HEADER;
  for (const [date, content] of kept) {
    const candidate = `${output}\n## ${date}\n${content}\n`;
    if (candidate.length > maxChars && output !== LEDGER_HEADER) break; // 총량 초과 시 오래된 섹션부터 버림
    output = candidate;
  }
  return { output, added: freshCards.length };
}

export function runMiner({ logPath, outPath, hours = 36, maxCards = 8, dryRun = false, now = new Date(), maxLines = 8000 } = {}) {
  if (!logPath || !fs.existsSync(logPath)) {
    return { ok: false, reason: `로그 없음: ${logPath}` };
  }
  const entries = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).slice(-maxLines)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  const cards = extractOwnerInterventionCards(entries, { now, windowMs: hours * 60 * 60 * 1000, maxCards });
  const existing = fs.existsSync(outPath) ? fs.readFileSync(outPath, 'utf8') : '';
  const { output, added } = mergeCorrectionsLedger(existing, cards, { now });
  if (!dryRun) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output, 'utf8');
  }
  return { ok: true, scanned: entries.length, candidates: cards.length, added, dryRun, outPath, preview: cards };
}

function argValue(argv, name, fallback) {
  const index = argv.indexOf(name);
  return index !== -1 && argv[index + 1] ? argv[index + 1] : fallback;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const argv = process.argv.slice(2);
  const result = runMiner({
    logPath: argValue(argv, '--log', process.env.AI_WORKER_AUTO_SEND_LOG || path.resolve(__dirname, '../kakao-dom-bridge/queue/auto-replies.ndjson')),
    outPath: argValue(argv, '--out', process.env.KAKAO_CORRECTIONS_PATH
      || (process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Village', 'kakao-corrections', 'corrections-latest.md') : path.resolve(__dirname, 'corrections-latest.md'))),
    hours: Number(argValue(argv, '--hours', 36)) || 36,
    maxCards: Number(argValue(argv, '--max-cards', 8)) || 8,
    dryRun: argv.includes('--dry-run')
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
