import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Recovery metadata lives beside the incident audit, never inside old jobs.
export function loadRecoveryHoldManifest(file, { directory, readFileSync = fs.readFileSync } = {}) {
  if (!String(file || '').trim()) return null;
  if (!path.isAbsolute(file)) throw new Error('Recovery hold manifest requires an absolute path');
  const raw = readFileSync(file, 'utf8');
  const value = JSON.parse(raw);
  if (!value || value.schema !== 'village-gateway-held-jobs/v1'
    || typeof value.queueDirectory !== 'string'
    || path.resolve(value.queueDirectory).toLowerCase() !== path.resolve(directory, 'hermes-gateway').toLowerCase()
    || typeof value.freezeBefore !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.freezeBefore) || !Number.isFinite(Date.parse(value.freezeBefore)) || new Date(value.freezeBefore).toISOString() !== value.freezeBefore
    || !Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > 10000) {
    throw new Error('Recovery hold manifest scope or schema is invalid');
  }
  const seen = new Set();
  const heldJobs = value.entries.map(entry => {
    if (!entry || Object.keys(entry).some(key => !['jobId', 'sha256'].includes(key))
      || typeof entry.jobId !== 'string' || !entry.jobId.trim() || entry.jobId.length > 240
      || !/^[a-f0-9]{64}$/.test(String(entry.sha256 || '')) || seen.has(entry.jobId)) {
      throw new Error('Recovery hold manifest entry is invalid or duplicate');
    }
    seen.add(entry.jobId);
    return { jobId: entry.jobId, sha256: entry.sha256 };
  });
  return { file: path.resolve(file), sha256: crypto.createHash('sha256').update(raw).digest('hex'), heldJobs, freezeBefore: value.freezeBefore };
}

export function recoveryRuntimeConfig(config, enabled) {
  return enabled ? { ...config, autoSendEnabled: false, slackFollowUpEnabled: false } : config;
}

export function recoveryGeneralPostAllowed(pathname) {
  return pathname === '/events';
}