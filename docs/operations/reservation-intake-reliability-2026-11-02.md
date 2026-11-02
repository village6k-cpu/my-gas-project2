# 예약 문의 접수 누락 방지

## 원인

직원이 예약을 승인한 뒤에도, AI가 잘못된 반납일을 이유로 신규 확인요청을 쓰지 않고 후속업무만 남길 수 있었다. 이후 감사·도착 메시지도 기존 미등록 문의를 해결하지 못했다. 복구 모드에서는 일반 자동발송과 기존 즉시 알림이 중지되어, AI가 만든 확인 질문까지 실행되지 않았다.

## 동작

- AI가 `new_inquiry`, 실제 장비 문의, 미등록으로 명시한 건은 native 접수/등록 receipt 없이 정상 완료할 수 없다. 같은 근거와 보정 지침으로 기존 no-final 재시도 경로를 사용한다. FINAL JSON 자체로 예약을 쓰지는 않는다.
- 날짜 모순은 해당 필드만 공란으로 접수한다. 장비·고객·알려진 반출 일시는 보존한다. 일정 미완성 접수는 가용/등록 성공을 뜻하지 않는다.
- `AI_WORKER_RESERVATION_CLARIFICATION_AUTO_SEND=1`과 `AI_WORKER_RESERVATION_RECOVERY_ENABLED_AFTER` 이후의 새 live job만 별도 확인 질문 경로를 사용할 수 있다. 정확히 성공한 일정 미완성 접수 receipt, high confidence, contact_request, visible_conversation이 필요하다. 기존 kill switch·freshness·중복 방지·위험 문구 검사를 모두 적용한다.
- 미해결 일정/재고 업무와 질문 전송 여부는 기존 대표 Slack outbox에 남긴다. 접수 재시도 소진도 별도로 알린다. 같은 업무의 감사 메시지는 알림을 다시 만들지 않는다.
- 기존 과거 작업 보류 manifest, 일반 autoSend=false, 문서/가격 경로와 권한은 유지한다.

## 검증

접수 없이 정상 완료되는 실패와 복구 모드의 확인 질문 차단을 수정 전에 재현했다. 수정 후 native receipt 완료, 동일 근거 재시도, 모순 날짜 부분 접수, 차단/과거 job, 기존 HTTP·브리지·가격·서류 동작을 회귀 검증한다. 운영 배포는 저장소 통합과 별개인 migrated runtime의 정확한 파일 패치·해시 갱신·서비스 재시작까지 필요하다.
