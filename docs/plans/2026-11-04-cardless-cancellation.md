# Card cancellation implementation plan

Goal: staff can cancel one exact original approval, with cardless full cancellation only when supported; Hermes reports actual per-approval eligibility.
Architecture: reuse Toss Front payment SDK and existing canonical cancellation ledger route. No new server-side refund mechanism.
Stack: plain JS Toss plugin, Node Hermes audit, existing Next/Supabase ledger.
Constraints: actual observed VAN is NICEPAY (not NICE); official forum topic 61 explicitly excludes it. No live refunds during development. No cardless remote queue for an unsupported live payment environment. Hermes can audit and guide staff; terminal execution requires the original terminal and eligible SDK data.
Review focus: NICE versus NICEPAY, immutable original identity/tax split, crash/timeout repeat prevention, downstream sync warnings.

- [x] Preserve original VAN, tid, vanTransactionKey, taxExemptValue in terminal receipt history.
- [x] Recover old SDK metadata without overwriting mismatching approval identity or original tax.
- [x] Offer NICE CARD cardless cancellation and existing card-present fallback in staff settings.
- [x] Persist attempt before SDK execution; uncertain outcomes use cache readback only.
- [x] Add Hermes per-approval VAN/cancellation capability and explicit limitations.
- [x] Test mocked approval/cancellation/cache/ledger failure paths, package plugin, install Hermes, integrate source.
- [ ] Upload updated plugin through supported portal if accessible; verify version. Report external blockers precisely.

Acceptance: tests pass, original financial data untouched, source and live Hermes match; release artifact is reproducible and deployed where access permits. Unsupported NICEPAY must never be labeled cardless-ready.

Deployment blocker: first-party CUA inventory on 2026-11-04 reports `Local browser use is disabled in Work settings`. No browser UI action or terminal upload occurred. The package is ready; live terminal version remains unverified.
