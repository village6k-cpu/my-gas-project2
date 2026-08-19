> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village network-change CCTV / AgentDVR recovery

Use this when the user changes ISP/router/modem wiring and worries that CCTV/NAS/card terminals or local AI automations broke.

## Fast diagnosis pattern

1. Establish the current LAN identity from the Mac:
   - current interface IP
   - default gateway
   - public IP
   - AgentDVR listen ports (`8090`, `3478`)
2. Compare that against AgentDVR's stored CCTV configuration:
   - `~/Library/Application Support/AgentDVR/Media/XML/config.json`
   - `~/Library/Application Support/AgentDVR/Media/XML/objects.json`
   - `~/Library/Application Support/AgentDVR/Media/XML/NetworkDeviceList.json`
3. If current LAN is different from stored camera LAN, treat CCTV as a network-isolation issue before editing camera credentials.
   - Example: Mac/gateway now `192.168.1.x`, but AgentDVR camera RTSP still points to `192.168.45.117`.
4. Scan the new LAN for likely camera ports before assuming the camera DHCP-renumbered:
   - RTSP: `554`, `8554`
   - common camera/NVR admin: `80`, `81`, `88`, `8000`, `8080`, `37777`, `34567`
   - If no RTSP candidate appears on the new LAN, the camera is probably still static on the old subnet.
5. Check AgentDVR logs for `SourceError` / reconnect loops and verify whether any recordings/photos were produced.

## Preferred recovery order

1. **Best/root fix:** put the existing router LAN back onto the old subnet used by static CCTV devices.
   - If cameras were configured as `192.168.45.117`, set router LAN to `192.168.45.1/24` and DHCP to the same subnet.
   - This is safer than changing every camera/AgentDVR/NAS/card-terminal IP one by one.
2. **Fast temporary test:** add a secondary IP alias on the Mac in the old subnet, then probe the old camera IP.
   - Example: `sudo ifconfig en1 alias 192.168.45.142 netmask 255.255.255.0`
   - Requires user/admin approval; do not type or request passwords directly.
   - This is temporary and can disappear after reboot/interface reset.
3. **AgentDVR local config fixes:** while AgentDVR is stopped, patch stale local settings, then restart AgentDVR.
   - Stop: `launchctl bootout gui/$(id -u)/com.ispy.agent.dvr` when that label exists.
   - Patch `config.json` `TurnPublicIP` to the current public IP.
   - Patch obvious RTSP typos in `objects.json` only after making a timestamped backup.
   - Start: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.ispy.agent.dvr.plist`.
   - Verify the app did not rewrite the file back to its previous in-memory value.

## Pitfalls

- Do not assume "internet works" means CCTV works. Static-IP cameras can be isolated by a LAN subnet change while cloud/Slack/Hermes/Kakao continue working.
- AgentDVR can be healthy on `*:8090` while the camera source is dead. Always inspect camera logs and media/DB output.
- Editing AgentDVR XML/JSON while the AgentDVR process is running can be overwritten by its in-memory state. Stop the service first, patch, then start.
- `TurnPublicIP` being stale affects remote/WebRTC/TURN behavior, but it does not fix local RTSP reachability by itself.
- Router admin UI and sudo prompts require the user to enter credentials; do not type passwords or claim recovery if credentialed steps were not completed.

## Report shape

Keep it short and operational:

```text
상태:
- 인터넷/AI 자동화: 정상/문제
- CCTV: 정상/끊김
- 현재 LAN: x.x.x.x / gateway y.y.y.y
- AgentDVR camera target: old.ip.addr

원인:
- 공유기 LAN 대역 변경으로 static CCTV IP와 Mac이 다른 subnet

조치:
- 로컬에서 고친 설정
- 사용자/공유기에서 필요한 남은 조치

다음:
- 공유기 LAN을 old subnet으로 되돌리기 OR Mac 보조 IP로 임시복구
```
