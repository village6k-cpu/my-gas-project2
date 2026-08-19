# Slack 직원 질문 자동응답 / FAQ-RAG 자동화 노트

Use this reference when the user asks to build or operate a Village staff-facing Slack bot that learns recurring employee questions and answers on the user's behalf.

## Core lesson

Do **not** start by letting the bot auto-answer everything. The safe operating sequence is:

1. **Observation mode** — collect recurring staff questions and answer candidates; no auto-replies.
2. **Approval mode** — draft answers with evidence and ask the owner/manager to approve.
3. **Allowlisted auto-reply mode** — only approved FAQs with `auto_reply=true` may answer automatically.

This matters because Village internal workflows include exceptions around refunds, discounts, damage, settlement, unpaid balance, and customer complaints; those should not be learned into uncontrolled auto-replies.

## Recommended data ingestion pattern

For large multi-year Kakao/customer/staff chat exports, avoid Slack upload. Use local folders and keep raw CSV untouched:

```text
C:\Users\ssper\AppData\Local\hermes\village-faq-rag\incoming\kakao_customer\
C:\Users\ssper\AppData\Local\hermes\village-faq-rag\incoming\internal_groupchat\
```

Suggested processing layout:

```text
C:\Users\ssper\AppData\Local\hermes\village-faq-rag\raw\                         # raw backup/hash records
C:\Users\ssper\AppData\Local\hermes\village-faq-rag\data\messages.sqlite          # normalized messages
C:\Users\ssper\AppData\Local\hermes\village-faq-rag\data\faq_candidates.sqlite    # repeated-question candidates
C:\Users\ssper\AppData\Local\hermes\village-faq-rag\data\approved_faq.sqlite      # reviewed/allowlisted FAQ
C:\Users\ssper\AppData\Local\hermes\village-faq-rag\reports\                      # schema/candidate review reports
```

Minimum normalized message schema:

```sql
source_type TEXT        -- kakao_customer | internal_groupchat | slack_live
source_file TEXT
room_name TEXT
sender TEXT
sent_at TEXT
text TEXT
attachment_hint TEXT
message_hash TEXT UNIQUE
```

CSV parser should auto-detect:

- encoding: `utf-8-sig`, `cp949`, `euc-kr`, `utf-16`
- delimiter: comma, tab, semicolon
- likely time/sender/body/room columns

## Connecting an existing RAG system

Prefer these connection shapes in order:

1. **CLI wrapper** — easiest and most stable:

   ```bash
   python query_rag.py "견적서 다시 보내는 방법"
   ```

   Return JSON:

   ```json
   {
     "answer": "...",
     "sources": [{"room": "사내단톡방", "date": "2024-03-12", "text": "..."}],
     "confidence": 0.91
   }
   ```

2. **HTTP API** — if the RAG server is already running locally:

   ```text
   POST http://localhost:8000/query
   {"query":"...", "corpus":["kakao_customer", "internal_groupchat"]}
   ```

3. **Direct DB/index path** — Chroma/FAISS/SQLite/etc. if no wrapper exists.

## Approved FAQ policy schema

Use a reviewed FAQ DB rather than answering directly from raw RAG snippets:

```sql
CREATE TABLE approved_faq (
  id INTEGER PRIMARY KEY,
  category TEXT NOT NULL,
  question_patterns TEXT NOT NULL,
  answer TEXT NOT NULL,
  auto_reply INTEGER NOT NULL DEFAULT 0,
  confidence_threshold REAL NOT NULL DEFAULT 0.88,
  risk_level TEXT NOT NULL DEFAULT 'normal',
  reviewer TEXT,
  reviewed_at TEXT,
  evidence TEXT
);
```

Decision policy:

- `auto_reply=true` and similarity/confidence >= threshold → reply automatically.
- risk category → do not auto-reply; escalate to owner/manager.
- candidate match but low confidence → draft answer with evidence only.
- new repeated question → log as FAQ candidate.

## Good auto-answer categories

- Document-send how-to: 견적서/거래명세서/계약서/증빙 위치 and request format.
- Reservation lookup location.
- 반출/반납 checklist and responsible channel routing.
- How to ask Hermes for common document/reservation tasks in natural language.

## Do not auto-answer initially

- 환불/분쟁
- 할인/가격 예외
- 미수금/정산 예외
- 고객 컴플레인
- 장비 파손 책임
- Legal/contract-sensitive answers
- Anything that requires 대표 judgment

## Slack gateway requirements

To learn and answer messages that are not explicit mentions, the Slack app/gateway must receive channel message events. Check that the bot is invited to the target channel and that Slack app settings include, as needed:

- Event Subscriptions enabled
- Socket Mode enabled if the gateway is using Socket Mode
- Bot events such as `message.channels`
- OAuth scopes such as `channels:history`, `chat:write`, and `app_mentions:read` for mention fallback

Do not claim Hermes can search all Slack history unless the Slack app has the required history/event permissions.
