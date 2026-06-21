const TRADE_ID_RE = /\b\d{6}-\d{3}\b/;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function kstYear(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
  });
  return Number(fmt.format(now));
}

function kstDateParts(now = new Date(), offsetDays = 0) {
  const base = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(base);
}

function normalizeDate(input, { now = new Date() } = {}) {
  const text = String(input || '').normalize('NFKC');
  if (/오늘/.test(text)) return kstDateParts(now, 0);
  if (/내일/.test(text)) return kstDateParts(now, 1);
  if (/모레/.test(text)) return kstDateParts(now, 2);
  let m = text.match(/(20\d{2})\s*[년.\/-]\s*(\d{1,2})\s*[월.\/-]\s*(\d{1,2})\s*일?/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;

  m = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
  if (m) return `${kstYear(now)}-${pad2(m[1])}-${pad2(m[2])}`;

  m = text.match(/\b(\d{1,2})\s*[./-]\s*(\d{1,2})\b/);
  if (m) return `${kstYear(now)}-${pad2(m[1])}-${pad2(m[2])}`;

  return null;
}

function removeDateText(input) {
  return String(input || '')
    .normalize('NFKC')
    .replace(/오늘|내일|모레/g, ' ')
    .replace(/20\d{2}\s*[년.\/-]\s*\d{1,2}\s*[월.\/-]\s*\d{1,2}\s*일?/g, ' ')
    .replace(/\d{1,2}\s*월\s*\d{1,2}\s*일?/g, ' ')
    .replace(/\b\d{1,2}\s*[./-]\s*\d{1,2}\b/g, ' ');
}

function extractCustomerName(input) {
  let text = removeDateText(input)
    .replace(TRADE_ID_RE, ' ')
    .replace(/(견적서|견적|거래명세서|명세서|계약서|증빙|세금계산서|현금영수증|결제수단|결제|카드결제|카드|현금|계좌이체|계좌|VAT별도|VAT포함|부가세별도|부가세포함|링크|발송|발행|처리|설정|변경|기록|요청|보내줘|보내|알려줘|만들어줘|작성해줘|작성|확인|해줘|해주세요|주세요|하고|으로|로|건|예약|고객|님|감독님)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const koreanName = text.match(/[가-힣]{2,5}/);
  return koreanName ? koreanName[0] : null;
}

function classifyDocument(text) {
  if (/증빙|세금\s*계산서|현금\s*영수증/.test(text)) return 'proof';
  if (/거래\s*명세서|명세서/.test(text)) return 'statement';
  if (/계약서/.test(text)) return 'contract';
  if (/견적서|견적/.test(text)) return 'quote';
  return null;
}

function shouldSend(text) {
  return /(발송|보내줘|보내|카톡|알림톡|전송)/.test(text);
}

function hasOutOfScopePaymentUpdate(text) {
  return /(결제\s*수단|입금|카드\s*결제|카드로|현금\s*결제|계좌\s*이체|정산|VAT|부가세)/i.test(text);
}

function buildIntent(documentType, send) {
  if (documentType === 'quote') return send ? 'send_quote' : 'prepare_quote';
  if (documentType === 'statement') return send ? 'send_statement' : 'prepare_statement';
  if (documentType === 'contract') return send ? 'send_contract_link' : 'contract_link';
  if (documentType === 'proof') return send ? 'issue_proof' : 'prepare_proof';
  return 'unknown';
}

export function parseVillageDocumentCommand(input, options = {}) {
  const text = String(input || '').normalize('NFKC').trim();
  const tradeId = text.match(TRADE_ID_RE)?.[0] || null;
  const date = normalizeDate(text, options);
  const customerName = extractCustomerName(text);
  const documentType = classifyDocument(text);
  const send = shouldSend(text) || (documentType === 'proof' && /(발행|처리|요청)/.test(text));
  const intent = buildIntent(documentType, send);
  const outOfScopePaymentUpdate = hasOutOfScopePaymentUpdate(text);

  let resolver = { strategy: 'unresolved' };
  if (tradeId) {
    resolver = { strategy: 'trade_id', tradeId };
  } else if (customerName && date) {
    resolver = { strategy: 'customer_date', customerName, date };
  } else if (customerName) {
    resolver = { strategy: 'customer_only', customerName };
  }

  return {
    rawText: text,
    intent,
    documentType,
    shouldSend: send,
    outOfScopePaymentUpdate,
    tradeId,
    customerName,
    date,
    resolver,
  };
}
