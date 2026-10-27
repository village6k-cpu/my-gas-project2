# Voice intake during the Windows to Mac handoff

The approved ten-minute Slack quiet window does not stop incoming Watch speech.
`scripts/macos/migration_voice_ingress.py` stores authenticated voice input
independently of either business gateway. It creates no Slack message itself.

The HTTP intake validates transcript forms and bearer, normalizes whitespace,
preserves the minute-bucket request-ID default and commits a private SQLite
EXTRA/fullfsync receipt before HTTP202. `queued` means durable intake, not business
completion. Delivered input retains the original relay's accepted/duplicate
response and parent timestamp. The existing relay's Slack/HMAC behavior is intact.

A process-held consumer lock and committed dispatching claim precede forwarding.
Process death, conflicting content, missing acceptance, transport uncertainty or
revoked authority blocks later forwarding. There is no retry/reset/receipt-repair
API. Inspect uncertain outcomes through relay, Slack and gateway evidence.

Windows authority requires a native-clock lease from a controller checking the
exact captured root/voice identities and gateway connection. It expires after
15seconds. STOP, source drain, closure or native activation ends renewal. Before
source closure, stop the lease, confirm HOLD and let dispatching work settle.
New speech remains queued. Native authority requires final closure, manifest and
activation hash bindings, all seven gates and absence of the inactive marker.

The separate input-preservation label is `com.village.migration.voice-ingress`.
It is not one of the sixteen future business services. Its state is outside the
trees to be promoted. A temporary SSH reverse tunnel reaches the existing Windows
relay. The new Mac `/watch/voice` preserves incumbent `/heybill` and8443 routes.
The Watch shortcut must use the Mac URL before Windows can be retired.

Eighteen voice tests pass on Windows; the native helper suite passes88/88. Cases
include real HTTP auth, durable reader visibility, disk failure, conflicting input,
process death, exclusive consumer locking and refusal to follow bearer redirects.
Independent review found no additional voice-controller findings. The empty native
intake and new route are started. Authenticated empty requests are rejected at both
ends before any Slack/business operation. The original Windows backend remains
authoritative; a real Watch input and resulting reply are not yet verified.

The approved Slack quiet window has not started. No source task fence, source stop,
profile promotion or native business activation has occurred.
