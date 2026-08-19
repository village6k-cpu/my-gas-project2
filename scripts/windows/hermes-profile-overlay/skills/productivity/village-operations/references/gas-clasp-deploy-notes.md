> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village GAS clasp deployment notes

Use this when deploying changes for the two local Village Apps Script projects, especially `/Users/village6k/my-gas-project` document-send/payment code.

## Safe deployment sequence

1. Install clasp if missing:
   ```bash
   npm install -g @google/clasp
   clasp --version
   ```
2. Confirm the repo has `.clasp.json` and the expected script is connected:
   ```bash
   clasp status
   ```
3. Before `clasp pull`, back up local uncommitted GAS edits because pull can replace files:
   ```bash
   mkdir -p .hermes-backups
   git diff -- agreement.js Code.js Quote.js Sidebar.html StatementSidebar.html > .hermes-backups/before-clasp-pull-$(date +%Y%m%d-%H%M%S).patch
   ```
4. If not authenticated, run clasp login in a PTY:
   ```bash
   clasp login --no-localhost
   ```
   Tell the user to approve in the browser, then paste the full `http://localhost:8888/?code=...` callback URL. Submit that full URL to the waiting clasp process. The browser may show a localhost error page; that is normal for `--no-localhost` as long as the address bar contains `code=`.
5. Pull before push:
   ```bash
   clasp pull
   git status --short
   git diff -- agreement.js
   ```
6. Reapply/merge local changes if pull removed them. For the document-send workflow, verify `agreement.js` still has:
   - `doPost` branch for `action === "sendStatement"`
   - `sendStatementByTradeId_(body)` calling `executeSendStatement(target.row)`
   - existing remote changes such as `sendEstimateByTradeId_` using `executeSendQuote(target.row)` are preserved.
7. Run syntax checks where possible:
   ```bash
   node --check agreement.js
   node --check Code.js
   node --check Quote.js
   ```
8. Push and deploy the existing webapp deployment, not a random new deployment:
   ```bash
   clasp push
   clasp deployments
   clasp deploy -i <existing-webapp-deployment-id> -d "short operational description"
   ```
9. Verify with a non-customer side-effect test first. For `sendStatement`, use a nonexistent trade ID so the route and auth are checked without sending anything:
   ```bash
   curl -sS -X POST "$WEBAPP_URL" \
     -H 'Content-Type: application/json' \
     -d '{"action":"sendStatement","key":"...","id":"NO-SUCH-TRADE-ID"}'
   ```
   Expected shape: `{"error":"거래ID 없음: NO-SUCH-TRADE-ID"}`.

## Pitfalls

- Do not run `clasp push` before `clasp pull` on Village GAS repos; remote Apps Script may have newer files like `Quote.js`/`QuoteSidebar.html`.
- Do not treat the browser `localhost refused` page during `clasp login --no-localhost` as failure. The callback URL in the address bar is the credential handoff.
- Do not test document-send APIs with a real customer trade unless the user explicitly asked to send. Use nonexistent IDs or read-only/info routes for route checks.
- Apps Script version history cleanup is not the same as deployment cleanup. `clasp undeploy <deploymentId>` can archive/delete old deployments, but `clasp versions` / the public Apps Script API do not expose a supported version-delete command. If `clasp deploy` fails with `Cannot create more versions: Script has reached the limit of 200 versions`, first archive unused deployments, then delete immutable project-history versions from the Apps Script editor Project history UI (or have the user approve that UI/destructive cleanup path). A `clasp redeploy -V <existingVersion>` only repoints the deployment to an existing version; it does not publish current HEAD changes.
