# Popbill `registIssue` field constraints

Use before manually issuing a non-trade tax invoice through Popbill.

## Payment split invariant

`cash + chkBill + credit + note` must equal `totalAmount`.

| Situation | Required values |
|---|---|
| 청구/미입금 | `note=totalAmount`; `cash=0`, `chkBill=0`, `credit=0` |
| Empty numeric fields | Invalid; use integer zero |
| All four payment fields zero | Invalid when `totalAmount` is nonzero |

Use integers for `serialNum`, `qty`, `unitCost`, `supplyCost`, `tax`, `kwon`, `ho`, and all payment split fields. Keep the business registration number digits-only.

After `registIssue`, immediately call provider readback by the exact management key. Popbill `stateCode=300` proves Popbill acceptance, not completed Hometax transmission; report the NTS state separately.

