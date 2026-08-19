# Staff call recordings → existing Village RAG

Session learning: when the user says staff/owner call recordings should “train” 헤이빌리 for employee questions, implement it as ingestion into the existing Village RAG, not as model fine-tuning and not as a new standalone KB.

## User preference / workflow correction

- Do **not** overemphasize privacy gates for owner↔staff call recordings. The user explicitly considers this information internally shareable within Village.
- Keep the design simple and operational: ingest reusable staff knowledge so employees stop calling the owner for repeated questions.
- Reuse existing systems whenever present; the user objected to creating a separate RAG when `dom watcher` / Village Kakao AI already has a DB/system.

## Existing system to reuse

Project:

```text
C:\Village\village-kakao-ai
```

Existing search wrapper:

```text
src/supabase-rag.js
searchSupabaseVillageReferences()
```

Supabase RPC:

```text
search_village_references(query_text, match_count)
```

The SQL in `docs/supabase/village-operating-inbox.sql` searches across:

```text
public.documents
public.knowledge
public.mistakes
public.corrections
public.pinned_answers
```

For call-derived reusable staff knowledge, prefer inserting concise records into:

```text
public.knowledge
```

Useful tags:

```text
staff_ops
call_recording
재고관리 / 스케쥴 / 서류발송 / 정산 / 기타
```

## Ingestion shape

Do not store the whole transcript as answer material if it is noisy. Extract reusable operational facts:

```text
title: 붐폴 위치
content:
  질문: 붐폴 어디 있어요?
  답변: 붐폴은 2층 음향 선반 오른쪽 검정 케이스 안에 있음
  근거: 통화에서 사장이 직원에게 안내한 내용
  출처: agent-전화문의/<file>.m4a
  기록일: YYYY-MM-DD
tags: staff_ops, call_recording, 재고관리
```

Good extraction targets:

- equipment/storage locations
- set 구성 and aliases
- checkout/checkin handling rules
- repair/failure handling
- document-send/payment operational rules
- repeated staff FAQ answers

Skip one-off customer-specific chatter unless it contains reusable policy/procedure.

## Implementation pattern used

A practical route is:

1. Slack/agent-전화문의 gets an A-dot/iPhone recording or summary.
2. STT creates transcript text.
3. LLM extracts only reusable staff ops knowledge as JSON records.
4. Insert records into `public.knowledge` through the existing Supabase service-role config.
5. Staff questions route through `search_village_references` before answering.

In the session, the implementation direction was:

- add a writer helper in `src/supabase-rag.js` for normalized `knowledge` inserts;
- add `search_internal_knowledge` to the operations agent/tool layer so “헤이빌리 붐폴 어딨어요?” can search existing RAG;
- add a script such as `scripts/ingest-staff-call-knowledge.js` / npm `knowledge:ingest-staff-call` for transcript → knowledge ingestion.

Verify with focused node tests around `supabase-rag` and operations tool wiring.
