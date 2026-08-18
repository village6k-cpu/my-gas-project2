# Windows runtime and authoritative sources

Use this reference only when an operation needs an exact Windows path or command.

## Runtime roots

- Active Kakao/Windows source: `C:/Village/runtimes/my-gas-project2-production`
- Development source: `C:/Village/my-gas-project2` on clean `main`
- Village Brain vault: `C:/Village/VILLAGE_Brain`
- Compiled Brain context: `C:/Village/VILLAGE_Brain/Ops/brain-context-latest.md`
- Brain compiler and business jobs: `C:/Village/village-ai`
- Gary Tan GBrain home: `%USERPROFILE%/.gbrain`
- Mac mirror: `C:/Village/MacMiniMirror/restored` (historical input only)
- Root Hermes home: `%LOCALAPPDATA%/hermes`
- Kakao worker profile: `%LOCALAPPDATA%/hermes/profiles/kakaoworker`

Gary Tan GBrain is an independent, lightweight MCP memory service. It never
imports, copies, or replaces Village Brain; Village Brain remains the governed
business-history vault and is consulted only through its own explicit boundary.

The production runtime is a clean, reviewed worktree promoted from `main`.
Confirm its HEAD, the scheduled-task action, and the process command line before
diagnosing or changing the worker. Historical or dirty worktrees are evidence
and rollback inputs only; never execute normal operations from them or overwrite
one worktree with another.

## Shell boundary

Hermes terminal uses Git Bash. Shell builtins may use `/c/Village/...`, but
native Windows executables must receive `C:/Village/...` paths. This includes
`node.exe`, `python.exe`, `powershell.exe`, and `cmd.exe`. In this environment
`rg` resolves to native Windows `rg.exe`, so both spellings must receive
`C:/Village/...`.

Wrap PowerShell explicitly:

```bash
powershell.exe -NoProfile -Command "Get-Item -LiteralPath 'C:\Village\VILLAGE_Brain\Ops\brain-context-latest.md' | Select-Object FullName,Length"
```

Do not use generic browser/OAuth discovery while a reviewed project read route
exists. Use the exact operation's `--help` or reference before opening source.

## Live-state boundaries

- `VILLAGE_WINDOWS_WRITES_ENABLED=0` disables Windows business writes.
- `AI_WORKER_LIVE=0` disables live worker action.
- `AI_WORKER_AUTO_SEND=0` disables automatic customer sends.
- These flags do not prove a task succeeded; verify the authoritative result.
- Interactive owner approval for an internal write never implies customer send.

## Startup ownership

Normal gateway, bridge, worker, restart, and watchdog paths validate the selected
profile but do not import skill snapshots. `sync-hermes-profile-overlay.ps1` is
reserved for an explicit migration/recovery after a verified backup and conflict
review. The live profile owns its native skills and learning between imports.

## Current information

Use the matching Sheet/GAS/API runner described by the task reference. The
aggregate read wrapper `scripts/windows/village-live-query.js` is one read route,
not a replacement for every system. A health endpoint, listening port, or saved
file is insufficient when the requested fact has a stronger readback source.
