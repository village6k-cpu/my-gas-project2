import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isSharedHermesGatewayIdle({
  statePath = path.join(process.env.HERMES_HOME || (process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'hermes') : path.join(os.homedir(), '.hermes')), 'gateway_state.json')
} = {}) {
  // Slack Hermes uses the same CDP browser but is not in the Kakao queue.
  // Read native turn-boundary status afresh. Unknown/starting/dead state
  // defers optional cleanup; it never interrupts or restricts the AI.
  try {
    const status = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (status?.kind !== 'hermes-gateway' || !Number.isSafeInteger(status.pid) || status.pid <= 0
      || !['running', 'draining'].includes(status.gateway_state) || status.active_agents !== 0
      || !Number.isFinite(Date.parse(status.updated_at))) return false;
    process.kill(status.pid, 0);
    return true;
  } catch { return false; }
}
