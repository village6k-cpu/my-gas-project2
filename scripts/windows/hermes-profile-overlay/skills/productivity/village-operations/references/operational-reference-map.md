# Village operations reference map

Open only the smallest relevant reference. These files are preserved by the
explicit migration seed even when they are not repeated in the compact root.

## Confirmation requests and registration

- `bulk-kakao-confirmation-triage.md`
- `bulk-kakao-room-context-confirmation.md`
- `confirmation-request-concurrent-write-reconciliation.md`
- `confirmation-request-model-memo-guards.md`
- `confirm-request-contact-resolution.md`
- `clone-existing-reservation-registration.md`
- `kakao-confirm-request-filter-softbox-generic-pitfalls.md`
- `kakao-preview-only-reservation-drop-guard.md`
- `kakao-staff-confirmed-reservation-acceptance.md`
- `pending-request-quote-correction-registration.md`
- `reservation-missing-contact-guard.md`
- `two-week-kakao-schedule-recovery.md`
- `village-confirm-request-customer-db-priority.md`
- `village-confirm-request-validation-recovery.md`

## Quotes and registered-trade corrections

- `manual-kakao-single-quote-preview.md`
- `manual-kakao-two-option-quote-preview.md`
- `manual-kakao-quote-price-override-pending-rq.md`
- `manual-quote-draft-fallback.md`
- `manual-quote-revision-resend.md`
- `confirmation-request-manual-quote-preview.md`
- `registered-quote-extra-discount-preview.md`
- `registered-quote-personal-business-loyal-discount.md`
- `registered-quote-remove-standalone-items.md`
- `registered-quote-schedule-item-correction.md`
- `registered-quote-zero-price-and-kakao-diff.md`
- `registered-quote-stable-link-cost-control.md`
- `registered-trade-correction-send-invoice.md`
- `registered-trade-date-change-remove-item.md`
- `registered-trade-camera-set-swap-merge.md`
- `burano-direct-registration-pitfalls.md`
- `approved-manual-quote-send-verification.md`
- `corrected-manual-quote-resend-fallback.md`
- `quote-preview-urlfetch-quota-drive-fallback.md`
- `village-batch-quote-kakao-send.md`
- `windows-kakao-combined-quote-send.md`

## Documents, tax, payment, and settlement

- `village-document-send-runner.md`
- `document-send-architecture.md`
- `document-send-natural-language-resolution.md`
- `document-send-statement-preview-gap.md`
- `document-date-mismatch-day-of-month-fallback.md`
- `document-channel-misroute-cleanup.md`
- `kakao-standard-document-attachments.md`
- `kakao-quote-pdf-send-pitfalls.md`
- `tax-invoice-info-lookup.md`
- `tax-invoice-issuance-workflow.md`
- `direct-tax-invoice-issue-route.md`
- `bulk-tax-invoice-from-kakao-followup.md`
- `popbill-taxinvoice-email-resend.md`
- `payment-workflow-notes.md`
- `reservation-financial-audit.md`
- `village-payment-ledger-map.md`

## Equipment, returns, inventory, and investment

- `equipment-matching-notes.md`
- `historical-kakao-inventory-discrepancy-audit.md`
- `inventory-count-dispute-notion-overlap.md`
- `return-not-yet-due-and-missing-battery-triage.md`
- `staff-cctv-missing-accessory-report.md`
- `historical-equipment-incident-screening.md`
- `equipment-investment-analysis.md`
- `equipment-investment-prioritization.md`
- `equipment-disposal-candidate-analysis.md`
- `homepage-new-equipment-setmaster-registration.md`
- `village-network-cctv-agentdvr.md`
- `vmount-loss-restitution-lookup.md`

## Kakao, Slack, watcher, and recovery

- `kakao-auto-reply-gates.md`
- `kakao-bulk-missed-reservation-recovery.md`
- `kakao-quote-pdf-send-pitfalls.md`
- `kakao-worker-timeout-slack-delivery.md`
- `popbill-kakao-send-audit.md`
- `village-kakao-cdp-watcher-injection.md`
- `village-kakao-critical-alerts.md`
- `village-kakao-critical-watchdog.md`
- `village-kakao-document-send-dom-file-input.md`
- `village-kakao-duplicate-backstop-queue.md`
- `village-kakao-half-alive-dom-watcher.md`
- `village-kakao-login-recovery-watchdog.md`
- `village-kakao-normal-profile-cua-fallback.md`
- `village-kakao-profile-safe-room-navigation.md`
- `village-kakao-scheduled-manual-send.md`
- `village-kakao-watchdog-restart-loop.md`
- `village-kakao-windows-worker-migration.md`
- `village-kakao-worker-rag.md`
- `follow-up-slack-calculation-pitfalls.md`
- `follow-up-slack-routing-guards.md`
- `slack-faq-rag-automation.md`
- `slack-message-deletion.md`

## Maintenance and rare incident history

- `daily-audit-backfill-debugging.md`
- `gas-clasp-deploy-notes.md`
- `gateway-self-restart-recovery.md`
- `hermes-slack-followup-patch-maintenance.md`
- `report-only-audit-queue-guard.md`
- `staff-call-rag-ingestion.md`
- `legacy-village-operations-2026-08-15.md` (audit/recovery only)

If two references conflict, prefer current live readback and the more recent
owner-confirmed rule. Record the conflict instead of silently combining them.
