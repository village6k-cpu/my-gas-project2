# Kakao quote/PDF sending pitfalls

Use this when sending Village quotes, statements, contracts, or other customer PDFs through Kakao/Chrome automation.

## Required order for customer documents
- For customer docs, send/upload the PDF or file first, then send the explanatory text. Do **not** send a standalone “견적서 전달드립니다” text before the file is actually attached/sent.
- After the send, verify the conversation contains customer-visible evidence of the file/message, not just that an input field was typed, a send button was clicked, a file chooser opened, or a local worker returned `sent:true`.
- If the user says “전송 안됐잖아” or otherwise corrects a false-positive send report, immediately treat the prior result as unverified/failed, apologize briefly, and switch to a more reliable delivery route (official Popbill 알림톡 when a valid phone number is known, or a verified public Drive/PDF link in the target Kakao room). Do not defend the automation log.
- If a text message went out but the file did not, report that as partial completion and continue/fallback rather than saying “sent.”
- If the user says “전송 안 됐잖아” or otherwise disputes receipt, immediately acknowledge the overclaim, stop relying on the previous CDP/manual-send result, and retry through a more authoritative customer-send route (official GAS/Popbill Alimtalk or verified Drive link) before reporting completion.

## Quote correctness gate
- If a quote has mixed rental durations/rounds, confirm discount rules per section before final send. Example: a 1-day section may receive student discount only, while a 2-day section receives student + long-term discount.
- Treat earlier preview PDFs with wrong totals as discarded artifacts. Use the corrected PDF only, and mention the corrected total in the final operator report.

## Kakao/Chrome automation gotchas
- When attaching a PDF via in-page `input[type=file]` / `DataTransfer`, assign the file to **exactly one** file input, then stop. Kakao Channel Manager conversation windows often expose 2+ hidden file inputs (`inputCount: 2`); looping all inputs and dispatching `change` on each causes **duplicate file bubbles** (same PDF sent twice). Prefer CDP `DOM.setFileInputFiles` on one nodeId when available; DataTransfer fallback must `break` after the first successful assignment. Verify chat-list/conversation preview shows one filename/timestamp before reporting success.
- `--manual-send` can land on the Kakao chat list/search rather than the target conversation. Before typing, verify the DOM (via CDP `Runtime.evaluate`) shows `채팅 메시지 입력 폼` and the target room title, not `채팅방 이름 검색 폼`.
- If typed text appears in `채팅방 이름 검색 폼`, stop, clear/search state, re-select the target chat tab/row, and retry in the actual `textarea` under the message input form.
- If worker `openKakaoTargetChatFromList` returns `chat_row_not_found` even though the search field contains the target name, the page may not have fired the real search event. Use CDP `Runtime.evaluate` page JS on the owned Kakao Chrome (DevTools port 9223) to set `input[placeholder*="채팅방 이름 검색"]`, dispatch `input/change/Enter`, and click the `검색` button; then verify `document.body.innerText` shows the single target row before clicking the row's link element.
- After pressing the target row, verify a new Chrome popup/window title is exactly the customer room (e.g. `최민석 - 빌리지 - 카카오비즈니스 파트너센터`) and its body includes the recent customer request plus `채팅 메시지 입력 폼`.
- File chooser completion is not proven by `selected: true` or by a visible path in a native file dialog. Verify the chat input/file area no longer says `파일 선택: 선택된 파일 없음`, or verify a sent file bubble appears.
- If a native OS file dialog appears, it cannot be driven (CUA/screen-control is removed from this deployment) — attach the file at the DOM level via CDP `DOM.setFileInputFiles`/`DataTransfer` instead, and if neither CDP nor the kakao-dom-bridge is available, report and stop; do not assume a dialog interaction selected the file.
- Reliable fallback when the DOM is accessible: create a browser `File` from the local PDF bytes, assign it to the conversation `input[type="file"].uploadInput` using `DataTransfer`, and dispatch `input`/`change`. Kakao can immediately create the sent file bubble without a separate submit click; verify the bubble contains the filename, expiry, size, and timestamp before sending explanatory text.
- For the follow-up text, set the `textarea[placeholder="메시지 보내기"]` value through the native setter, dispatch `input/change`, confirm `button.btn_submit` is no longer disabled, click it, then verify the outgoing text bubble appears after the file bubble.

## Google Drive fallback
- Copying a PDF into Google Drive/DriveFS may produce a Drive item ID before the file is publicly downloadable. Always verify the candidate URL returns a PDF header (`%PDF`) before sending it.
- A Drive URL that returns HTML/login/preview content is not a verified customer-sendable PDF link.
