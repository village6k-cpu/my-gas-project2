<!-- WINDOWS_EXECUTION_ADAPTER -->
## Windows execution adapter

This package is the complete Mac `village-operations` playbook with all references preserved. Keep the original business rules, approval gates, identifiers, and readback requirements. Translate only paths and host-specific commands.

### Windows path map

- Authoritative Windows execution tree: `C:\Village\my-gas-project2-worktrees\ax2-hermes-final`
- `/Users/village6k/my-gas-project2` source mirror → `C:\Village\my-gas-project2` (reference only; do not execute stale routes from it)
- `/Users/village6k/my-gas-project` → `C:\Village\my-gas-project`
- `/Users/village6k/village-ai` → `C:\Village\village-ai`
- `/Users/village6k/village-kakao-ai` → `C:\Village\village-kakao-ai`
- `/Users/village6k/VILLAGE_Brain` and `~/VILLAGE_Brain` → `C:\Village\VILLAGE_Brain`
- `~/.hermes` → `C:\Users\ssper\AppData\Local\hermes`
- Windows Kakao runtime → `C:\Village\my-gas-project2-worktrees\ax2-hermes-final`

The local `terminal` tool runs **Git Bash**. Use `/c/Village/...` for shell
builtins and MSYS tools such as `cd`, `find`, `test`, and `cat`. MSYS argument
conversion is disabled in Hermes. Native Windows executables must receive `C:/Village/...`,
never `/c/Village/...`; this includes `node.exe`,
`python.exe`, `powershell.exe`, `cmd.exe`, and this installation's `rg.exe`.
For a PowerShell-only runner or cmdlet, invoke it explicitly with
`powershell.exe -NoProfile -Command ...`;
never paste a bare `Get-Content` or `Get-ChildItem` command into `terminal`.
Do not use `search_files` for absolute `C:\Village` paths. AppleScript,
`launchctl`, macOS UI permissions, Messages, and watch-relay execution remain
on the Mac relay; their business context is still valid.

Use the root environment pointers `VILLAGE_DASHBOARD_ENV`,
`VILLAGE_TAX_ENV`, `HERMES_ENV`, and `VILLAGE_NAME_LINK_QUEUE`; do not infer
their locations from the Windows user home. A bare `python3` command is not a
valid Windows runner here—use `python.exe` or the preserved Node runners.

### Authorization and execution contract

- A question about current business state authorizes the narrow read-only project lookup needed to answer it.
- An explicit owner request to change an internal reservation, schedule, confirmation request, payment record, or ledger field authorizes only that exact narrow business action. Resolve the record, dry-run when the action supports it, execute once, and verify with the original playbook's mandatory readback. Preserve unrelated rows.
- Internal write approval does not approve a customer-facing send. Kakao, Alimtalk, invoice delivery, document delivery, proactive Slack delivery, and other external sends require separate exact approval.
- `AI_WORKER_LIVE=0`, `AI_WORKER_AUTO_SEND=0`, and `VILLAGE_WINDOWS_WRITES_ENABLED=0` govern background Kakao worker/automatic processing. They must not be interpreted as a global prohibition on a current owner-authorized interactive operation.
- A normal response in the current user-authorized Slack conversation is allowed. Proactive or cross-channel Slack delivery remains approval-gated.

### Intelligence-preserving confirmation requests

A confirmation request from owner-provided text or an image uses the **same reasoning quality** as a screenshot quote. Speed optimizations may shorten path discovery and execution, but must not replace AI interpretation, contextual judgment, or normal self-improvement.

- Read the whole request before choosing the write shape. If equipment groups have different return dates or times, split them into the minimum number of confirmation requests automatically. Do not ask whether to split when the source already makes the grouping clear.
- Resolve customer wording with broad catalog searches across both `세트마스터` and `장비마스터`, relevant preserved references, equipment knowledge, and visible context. A zero-result exact search is only a failed probe, never proof that the owner must supply the master spelling.
- Try shorter distinctive tokens, spacing/case/transliteration variants, bundle-to-quantity normalization, and the full catalog before asking. Ask only when the remaining candidates are materially different models and the source does not distinguish them.
- Verified examples from the successful quote path include `24-70 GM2` → `소니 GM 24-70mm II`, `70-200 GM2` → `소니 GM 70-200mm II`, `HBM 1/4 사각` → `Hollywood Blackmagic 1/4 사각`, `메가F22s4` → `OSEE MEGA22S4`, `RS3 Pro` → `로닌 RS3 프로`, and `파보튜브 II 30X 2KIT` → `파보튜브 II 30X` quantity 2.
- After AI has built the complete exact-name plan, use `scripts/windows/village-confirm-request.js` only as the bounded mutation/readback layer. Use `create-batch` for automatically split schedules so every group is catalog-preflighted before the first write.
- A successful new alias or workflow lesson may be retained through Hermes's normal self-improvement path after the user-facing operation. Do not disable learning to save latency.

For current-month aggregate revenue, use the existing read-only project wrapper rather than browser/OAuth fallback:

```bash
node 'C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-live-read.js'
```

For every other intent, select the relevant preserved reference, then use the named GAS/API/Supabase action and verification route documented there. Generic Google Workspace OAuth and Computer Use are not prerequisites while a project route exists.
