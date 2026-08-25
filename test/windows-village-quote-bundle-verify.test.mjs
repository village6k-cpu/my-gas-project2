import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const verifier = path.join(root, 'scripts', 'windows', 'village-quote-bundle-verify.py');
const uv = process.platform === 'win32' ? 'uv.exe' : 'uv';

function createPdfFixtures(definitions) {
  const program = String.raw`
import json
import pathlib
import sys
import pymupdf

for definition in json.loads(sys.argv[1]):
    target = pathlib.Path(definition["path"])
    target.parent.mkdir(parents=True, exist_ok=True)
    document = pymupdf.open()
    for text in definition["pages"]:
        page = document.new_page()
        page.insert_text((72, 72), text)
    document.save(target)
`;
  const created = spawnSync(
    uv,
    ['run', '--offline', '--with', 'pymupdf', 'python', '-c', program, JSON.stringify(definitions)],
    { encoding: 'utf8', timeout: 30_000 }
  );
  assert.equal(created.status, 0, created.stderr || created.stdout);
}

function makeBundle({ combinedTotals = [13_860, 27_720] } = {}) {
  const allowedRoot = mkdtempSync(path.join(tmpdir(), 'village-quote-verify-'));
  const bundle = path.join(allowedRoot, 'customer-batch');
  const individual = path.join(bundle, 'individual');
  mkdirSync(individual, { recursive: true });

  const results = [
    {
      tradeID: '260825-001', list_total: 20_000, discount: 7_400,
      supply: 12_600, vat: 1_260, total: 13_860
    },
    {
      tradeID: '260825-002', list_total: 40_000, discount: 14_800,
      supply: 25_200, vat: 2_520, total: 27_720
    }
  ];
  const summaryPath = path.join(bundle, 'summary.json');
  writeFileSync(summaryPath, JSON.stringify({
    customer: '테스트고객',
    included_count: 2,
    list_total_sum: 60_000,
    discount_sum: 22_200,
    supply_sum: 37_800,
    final_total_sum: 41_580,
    errors: [],
    results,
    artifacts: {
      combined: path.join(bundle, 'mojibake-missing-combined.pdf'),
      pages_combined: 2
    }
  }), 'utf8');

  for (const result of results) {
    writeFileSync(
      path.join(individual, `${result.tradeID}_official.csv`),
      `label,value\r\nTOTAL VAT,"${result.total.toLocaleString('en-US')}"\r\n`,
      'utf8'
    );
  }

  const combinedPath = path.join(bundle, '테스트고객_combined.pdf');
  createPdfFixtures([
    {
      path: combinedPath,
      pages: combinedTotals.map((total) => `TOTAL VAT ${total.toLocaleString('en-US')}`)
    },
    ...results.map((result) => ({
      path: path.join(individual, `${result.tradeID}_official.pdf`),
      pages: [`TOTAL VAT ${result.total.toLocaleString('en-US')}`]
    }))
  ]);

  return { allowedRoot, bundle, summaryPath };
}

function runVerifier(summaryPath, allowedRoot) {
  return spawnSync(
    uv,
    [
      'run', '--offline', '--with', 'pymupdf', 'python', verifier,
      'verify', '--summary', summaryPath, '--deadline-ms', '20_000'
    ],
    {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, VILLAGE_QUOTE_VERIFY_ALLOWED_ROOTS: allowedRoot }
    }
  );
}

test('verifies one batch total from local summary, CSVs, individual PDFs, and combined PDF', () => {
  const fixture = makeBundle();
  const result = runVerifier(fixture.summaryPath, fixture.allowedRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const verified = JSON.parse(result.stdout);
  assert.deepEqual(verified, {
    ok: true,
    source: 'local_quote_bundle',
    customer: '테스트고객',
    trade_count: 2,
    trade_ids: ['260825-001', '260825-002'],
    total: 41_580,
    evidence: {
      summary_total: 41_580,
      csv_total: 41_580,
      individual_pdf_total: 41_580,
      combined_pdf_total: 41_580,
      combined_pdf_pages: 2
    },
    network_requests: 0
  });
});

test('fails closed when the sent combined PDF total differs from summary and individual artifacts', () => {
  const fixture = makeBundle({ combinedTotals: [13_860, 99_990] });
  const result = runVerifier(fixture.summaryPath, fixture.allowedRoot);

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const failed = JSON.parse(result.stdout);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.type, 'quote_bundle_mismatch');
  assert.equal(failed.evidence.summary_total, 41_580);
  assert.equal(failed.evidence.combined_pdf_total, 113_850);
});

test('rejects quote artifacts outside the configured local preview root', () => {
  const fixture = makeBundle();
  const otherRoot = mkdtempSync(path.join(tmpdir(), 'village-other-root-'));
  const result = runVerifier(fixture.summaryPath, otherRoot);

  assert.equal(result.status, 2, result.stderr || result.stdout);
  const failed = JSON.parse(result.stdout);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.type, 'untrusted_quote_path');
});

test('returns structured invalid-summary evidence instead of a traceback for malformed artifacts metadata', () => {
  const fixture = makeBundle();
  const summary = JSON.parse(readFileSync(fixture.summaryPath, 'utf8'));
  summary.artifacts = [];
  writeFileSync(fixture.summaryPath, JSON.stringify(summary), 'utf8');

  const result = runVerifier(fixture.summaryPath, fixture.allowedRoot);

  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.equal(result.stderr, '');
  const failed = JSON.parse(result.stdout);
  assert.equal(failed.ok, false);
  assert.equal(failed.error.type, 'invalid_quote_summary');
});
