<!-- WINDOWS_EXECUTION_ADAPTER -->
## Windows execution adapter

This package is the complete Mac `village-brain-first` protocol with its references preserved. The business rules below remain authoritative; only the execution layer changes on Windows.

### Windows paths and commands

- Brain vault: `C:\Village\VILLAGE_Brain`
- Compiled context: `C:\Village\VILLAGE_Brain\Ops\brain-context-latest.md`
- Authoritative Windows execution tree: `C:\Village\my-gas-project2-worktrees\ax2-hermes-final`
- Mac source mirror for historical reference only: `C:\Village\my-gas-project2`
- Brain compiler: `C:\Village\village-ai`
- Kakao/Windows runtime: the authoritative Windows execution tree above

The local `terminal` tool runs **Git Bash**, not PowerShell. Use Git Bash paths
such as `/c/Village/...` only for shell builtins and MSYS tools such as `cd`,
`test`, and `cat`. MSYS argument conversion is disabled in Hermes.
Native Windows executables must receive `C:/Village/...`, never `/c/Village/...`;
this includes `node.exe`, `python.exe`, `powershell.exe`, `cmd.exe`, and this
installation's `rg.exe`. Invoke PowerShell only explicitly as
`powershell.exe -NoProfile -Command ...`.

Load the compiled context with:

```bash
test -s '/c/Village/VILLAGE_Brain/Ops/brain-context-latest.md'
cat '/c/Village/VILLAGE_Brain/Ops/brain-context-latest.md'
```

If a preserved reference specifically needs a PowerShell cmdlet, wrap it, for
example: `powershell.exe -NoProfile -Command "Get-Item -LiteralPath 'C:\Village\VILLAGE_Brain\Ops\brain-context-latest.md' | Select-Object FullName,Length"`.

Do not use `search_files` for an absolute `C:\Village` path. Use `rg`, `find`,
`cat`, or an explicitly wrapped PowerShell command through `terminal`.

The root environment pins `VILLAGE_DASHBOARD_ENV`, `VILLAGE_TAX_ENV`,
`HERMES_ENV`, and `VILLAGE_NAME_LINK_QUEUE` to their `C:/Village` sources.
Do not fall back to `Path.home()/VILLAGE_Brain`. Preserved Mac examples that
use a bare `python3` heredoc are documentation only on Windows; use `python.exe`
or Node with the pinned paths instead.

### Runtime policy scope

- Pure Brain QA is read-only except for the owner-journal learning write defined by the original protocol.
- If the current user explicitly asks to create, fix, or mutate a reservation, schedule, payment record, document, or tax operation, load `village-operations`, switch to its narrow service-integration workflow, execute the exact requested action, and verify live readback. Do not answer that another agent is required merely because the host is Windows.
- `AI_WORKER_LIVE=0` and `AI_WORKER_AUTO_SEND=0` disable Kakao background-worker writes and automatic sends. They are not a blanket ban on an interactive operation explicitly requested by the owner.
- A normal reply in the current user-authorized Slack conversation is allowed. Proactive or cross-channel Slack delivery remains blocked unless explicitly requested. Kakao/customer-facing sends require separate, exact approval even when an internal sheet mutation was approved.

### Current live facts

The user's question authorizes the narrow read-only lookup needed to answer
current reservations, revenue, inventory, receivables, payments, tax,
equipment, customers, or other business state. Start with the compiled Brain,
then use the matching project route instead of searching the drive or falling
back to browser authentication. The existing aggregate-revenue wrapper is one
such route, not a special-purpose replacement for the rest of the system:

```bash
node 'C:/Village/my-gas-project2-worktrees/ax2-hermes-final/scripts/windows/village-live-read.js'
```

For other live facts, use the project API/CSV/Supabase routes described by `village-operations`. Generic Google Workspace OAuth, Computer Use, Chrome history/cookies, and a user-supplied Sheet link are not prerequisites while a project route exists.
