import { deriveVerdict, serializeProbes } from './probe-contract.mjs';
export function makeGate0Report(probes) { const rows = Array.isArray(probes) ? probes : Object.values(probes ?? {}); return { schemaVersion: 'gate0-report/v1', verdict: deriveVerdict(rows), probes: rows }; }
export function serializeGate0Report(probes) { const report = makeGate0Report(probes); return JSON.stringify({ ...report, probes: JSON.parse(serializeProbes(report.probes)) }, null, 2) + '\n'; }
if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(serializeGate0Report([]));
