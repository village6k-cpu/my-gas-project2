#!/usr/bin/env python3
"""Real PostgreSQL financial invariants, using a disposable local cluster only.
Run with Python containing psycopg, e.g. village-tax/.venv/bin/python this-file.
No environment database URL or production connection is read or used.
"""
from __future__ import annotations
import concurrent.futures
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import uuid
import psycopg
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / 'apps/today-dashboard/supabase/migrations/20261020090000_payment_ledger.sql'
DSN = ''
COUNT = 0


def run(sql, args=()):
    with psycopg.connect(DSN, autocommit=True) as c:
        with c.cursor() as cur:
            cur.execute(sql, args if args else None)
            result = cur.fetchone()[0] if cur.description else None
            while cur.nextset():
                if cur.description:
                    result = cur.fetchone()[0]
            return result


def account(tid, amount, status='', observed='2026-10-20T00:00:00Z', **kw):
    payload = dict(trade_id=tid, billed_amount=amount, deposit_status=status,
                   customer_name='Test', payer_name='Test', contract_status='예약', observed_at=observed, **kw)
    return run('select village.payment_refresh_accounts(%s)', (Jsonb([payload]),))


def receipt(amount, source='bank', source_id=None, occurred='2026-10-21T00:00:00Z', **kw):
    payload = dict(source=source, source_id=source_id or str(uuid.uuid4()), amount=amount, occurred_at=occurred, **kw)
    return run('select village.payment_ingest_receipt(%s,%s,%s)', (Jsonb(payload), str(uuid.uuid4()), 'test'))


def allocate(rid, entries, revision=1, req=None, allow=False):
    return run('select village.payment_set_allocations(%s,%s,%s,%s,%s,%s,%s)',
               (rid, Jsonb(entries), revision, req or str(uuid.uuid4()), 'test', 'integration test', allow))


def balance(tid):
    return run('select to_jsonb(b) from village.payment_account_balances b where trade_id=%s', (tid,))


def must_fail(fn, substring):
    try:
        fn()
    except psycopg.Error as e:
        assert substring in str(e), str(e)
    else:
        raise AssertionError('Expected rejection: '+substring)


def check(name, fn):
    global COUNT
    fn()
    COUNT += 1
    print('PASS', name, flush=True)


def partial_combined_changes():
    account('partial-a', 100); account('partial-b', 80)
    first=receipt(40)
    allocate(first['receiptId'], [dict(trade_id='partial-a', amount=40)])
    a=balance('partial-a'); assert (a['paid_amount'],a['balance'],a['status'])==(40,60,'부분입금')
    second=receipt(140)
    allocate(second['receiptId'], [dict(trade_id='partial-a',amount=60),dict(trade_id='partial-b',amount=80)])
    assert balance('partial-a')['status']=='입금완료'
    assert balance('partial-b')['paid_amount']==80
    old=balance('partial-a')['revision']
    account('partial-a',130,observed='2026-10-22T00:00:00Z')
    assert balance('partial-a')['balance']==30 and balance('partial-a')['revision']>old
    account('partial-a',70,observed='2026-10-23T00:00:00Z')
    assert balance('partial-a')['credit']==30 and balance('partial-a')['paid_amount']==100


def receipt_limits_and_atomicity():
    account('limit-a',100);account('limit-b',100)
    r=receipt(100)['receiptId']
    for entries,message in [([dict(trade_id='limit-a',amount=80),dict(trade_id='limit-b',amount=30)],'exceed receipt'),
                            ([dict(trade_id='limit-a',amount=-1)],'invalid allocation'),
                            ([dict(trade_id='limit-a',amount=1.5)],'invalid allocation'),
                            ([dict(trade_id='limit-a',amount=10)]*2,'duplicate allocation'),
                            ([dict(trade_id='nonexistent',amount=10)],'unknown account')]:
        must_fail(lambda:allocate(r,entries),message)
    assert balance('limit-a')['paid_amount']==0
    assert run('select revision from village.payment_receipts where id=%s',(r,))==1


def idempotency_and_immutable_identity():
    payload=dict(source='bank',source_id='immutable',amount=99,occurred_at='2026-10-21T00:00:00Z')
    def ingest(p,req):return run('select village.payment_ingest_receipt(%s,%s,%s)',(Jsonb(p),req,'test'))
    original=ingest(payload,'ingest-once')
    assert ingest(payload,'ingest-once')==original
    assert ingest(payload,'ingest-twice')['duplicate']
    must_fail(lambda:ingest(dict(payload,amount=100),'ingest-once'),'payload mismatch')
    must_fail(lambda:ingest(dict(payload,amount=100),'ingest-mismatch'),'identity mismatch')
    account('idem',99)
    alloc=[dict(trade_id='idem',amount=99)]
    result=allocate(original['receiptId'],alloc,req='allocate-once')
    assert allocate(original['receiptId'],alloc,req='allocate-once')==result
    must_fail(lambda:allocate(original['receiptId'],[dict(trade_id='idem',amount=98)],req='allocate-once'),'payload mismatch')
    must_fail(lambda:allocate(original['receiptId'],[],revision=1),'revision conflict')


def alias_and_cancellation():
    account('card',120)
    front=receipt(120,'front','front-1',approval_number='APP-1',merchant_id='merchant-1')
    allocate(front['receiptId'],[dict(trade_id='card',amount=120)])
    toss=receipt(120,'toss','toss-1',occurred='2026-10-21T00:01:00Z',approval_number='APP-1',merchant_id='merchant-1')
    assert toss['receiptId']==front['receiptId'] and toss['duplicate']
    assert balance('card')['paid_amount']==120
    old=balance('card')['revision']
    cancelled=receipt(120,'toss','toss-1',occurred='2026-10-21T00:01:00Z',approval_number='APP-1',merchant_id='merchant-1',status='cancelled')
    assert cancelled['status']=='cancelled'
    assert balance('card')['paid_amount']==0 and balance('card')['revision']>old
    assert receipt(120,'front','front-1',approval_number='APP-1',merchant_id='merchant-1')['status']=='cancelled'
    must_fail(lambda:allocate(front['receiptId'],[],revision=3),'cancelled receipt')


def cancellation_before_approval():
    cancellation=receipt(10,'toss','cancel-first',status='cancelled',approval_number='REVERSE')
    approval=receipt(10,'front','later-approval',approval_number='REVERSE')
    assert approval['receiptId']==cancellation['receiptId'] and approval['status']=='cancelled'


def ambiguous_approval():
    receipt(50,'front','ambiguous-1',approval_number='AMB')
    receipt(50,'front','ambiguous-2',approval_number='AMB')
    third=receipt(50,'toss','ambiguous-3',approval_number='AMB')
    assert third['reviewReason']=='ambiguous_approval_identity'
    account('ambiguous',100)
    must_fail(lambda:allocate(third['receiptId'],[dict(trade_id='ambiguous',amount=50)]),'receipt requires review')
    assert run("select count(*) from village.payment_receipts where approval_number='AMB' and review_reason is not null")==3


def historical_baseline():
    account('legacy-paid',100,'입금완료')
    assert balance('legacy-paid')['paid_amount']==100
    old=receipt(100,occurred='2026-10-19T00:00:00Z')
    must_fail(lambda:allocate(old['receiptId'],[dict(trade_id='legacy-paid',amount=100)],allow=True),'historical receipt')
    account('legacy-paid',130,'미입금',observed='2026-10-22T00:00:00Z')
    assert balance('legacy-paid')['opening_paid']==100 and balance('legacy-paid')['balance']==30
    fresh=receipt(30,occurred='2026-10-23T00:00:00Z')
    allocate(fresh['receiptId'],[dict(trade_id='legacy-paid',amount=30)])
    assert balance('legacy-paid')['paid_amount']==130
    account('legacy-partial',100,'부분입금')
    assert balance('legacy-partial')['review_required']
    must_fail(lambda:allocate(old['receiptId'],[dict(trade_id='legacy-partial',amount=100)]),'account not eligible')


def stale_snapshots_and_projection():
    account('fresh',100)
    initial=balance('fresh')['revision']
    assert not balance('fresh')['needs_projection']
    account('fresh',100,observed='2026-10-21T00:00:00Z')
    assert balance('fresh')['revision']==initial
    account('fresh',50,observed='2026-10-19T00:00:00Z')
    assert balance('fresh')['billed_amount']==100
    run("set role service_role; update village.payment_accounts set projected_revision=revision,projection_error=null where trade_id='fresh'")
    assert not balance('fresh')['needs_projection']
    r=receipt(10);allocate(r['receiptId'],[dict(trade_id='fresh',amount=10)])
    assert balance('fresh')['needs_projection']


def trusted_overpayment_only():
    account('overpay',50)
    r=receipt(60)['receiptId'];entries=[dict(trade_id='overpay',amount=60)]
    must_fail(lambda:allocate(r,entries),'exceeds account balance')
    allocate(r,entries,allow=True)
    assert balance('overpay')['credit']==10


def reallocation_full_map():
    account('move-a',100);account('move-b',100)
    r=receipt(100)['receiptId'];allocate(r,[dict(trade_id='move-a',amount=100)])
    old=balance('move-a')['revision']
    allocate(r,[dict(trade_id='move-b',amount=100)],revision=2)
    assert balance('move-a')['paid_amount']==0 and balance('move-a')['revision']>old
    assert balance('move-b')['paid_amount']==100


def concurrency():
    account('race-balance',100)
    receipts=[receipt(100)['receiptId'] for _ in range(2)]
    def attempt(rid):
        try:return allocate(rid,[dict(trade_id='race-balance',amount=100)])
        except psycopg.Error as e:return str(e)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex: results=list(ex.map(attempt,receipts))
    assert sum(isinstance(r,dict) for r in results)==1,results
    assert balance('race-balance')['paid_amount']==100
    account('race-a',100);account('race-b',100)
    rid=receipt(100)['receiptId']
    def cas(tid):
        try:return allocate(rid,[dict(trade_id=tid,amount=100)])
        except psycopg.Error as e:return str(e)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex: results=list(ex.map(cas,['race-a','race-b']))
    assert sum(isinstance(r,dict) for r in results)==1,results
    assert balance('race-a')['paid_amount']+balance('race-b')['paid_amount']==100


def permissions():
    for role in ['anon','authenticated']:
        must_fail(lambda:run(f'set role {role}; select * from village.payment_account_balances'),'permission denied')
        must_fail(lambda:run(f"set role {role}; select village.payment_refresh_accounts('[]')"),'permission denied')
    must_fail(lambda:run("set role service_role; update village.payment_accounts set opening_paid=999 where trade_id='fresh'"),'permission denied')
    assert run("set role service_role; select village.payment_refresh_accounts('[]')")['success']


def opening_balance_reconciliation():
    account('opening-review',100,'부분입금')
    def opening(value=40, revision=1, req='opening-request', note='Verified historical bank receipt'):
        return run('select village.payment_set_opening_balance(%s,%s,%s,%s,%s,%s)',
                   ('opening-review',value,revision,req,'staff:test',note))
    must_fail(lambda:opening(note='x'),'at least 5')
    must_fail(lambda:opening(value=-1),'nonnegative')
    result=opening()
    assert opening()==result
    assert balance('opening-review')['paid_amount']==40
    assert balance('opening-review')['balance']==60
    assert not balance('opening-review')['review_required']
    must_fail(lambda:opening(value=50),'payload mismatch')
    must_fail(lambda:opening(req='stale-opening'),'revision conflict')
    account('opening-review',120,'部分입금',observed='2026-10-22T00:00:00Z')
    assert balance('opening-review')['opening_paid']==40
    assert run("select count(*) from village.payment_events where event_type='opening_balance_reconciled' and trade_id='opening-review'")==1


def conflicting_source_alias():
    f=receipt(65,'front','conflict-front',approval_number='ALIAS')
    first=receipt(65,'toss','conflict-toss1',approval_number='ALIAS')
    assert first['receiptId']==f['receiptId']
    second=receipt(65,'toss','conflict-toss2',approval_number='ALIAS')
    assert second['receiptId']!=f['receiptId'] and second['reviewReason']=='ambiguous_approval_identity'


def front_trade_binding_survives_toss_first():
    toss=receipt(75,'toss','toss-first-binding',approval_number='BIND-1')
    front=receipt(75,'front','front-later-binding',approval_number='BIND-1',raw={'tradeId':'bound-trade'})
    assert toss['receiptId']==front['receiptId']
    assert run('select explicit_trade_id from village.payment_receipt_balances where id=%s',(toss['receiptId'],))=='bound-trade'
    assert run("set role service_role; select trade_id from village.payment_receipt_aliases where source='front' and source_id='front-later-binding'")=='bound-trade'
    must_fail(lambda:receipt(75,'front','front-later-binding',approval_number='BIND-1',raw={'tradeId':'wrong-trade'}),'trade binding mismatch')
    receipt(75,'front','front-later-binding',approval_number='BIND-1')
    assert run('select explicit_trade_id from village.payment_receipt_balances where id=%s',(toss['receiptId'],))=='bound-trade'
    unbound=receipt(70,'front','bind-once',approval_number='BIND-2')
    receipt(70,'front','bind-once',approval_number='BIND-2',raw={'tradeId':'first-binding'})
    assert run('select explicit_trade_id from village.payment_receipt_balances where id=%s',(unbound['receiptId'],))=='first-binding'
    must_fail(lambda:receipt(70,'front','bind-once',approval_number='BIND-2',raw={'tradeId':'second-binding'}),'trade binding mismatch')


def historical_cancellation_requires_review():
    account('historical-cancel',100,'입금완료')
    initial=balance('historical-cancel')['revision']
    def require(note='Historical cancellation needs opening balance reconciliation',req='historical-review-1',tid='historical-cancel'):
        return run('select village.payment_require_review(%s,%s,%s)',(tid,req,note))
    result=require()
    assert result==require() and result['revision']==initial+1
    b=balance('historical-cancel')
    assert b['review_required'] and b['status']=='확인필요' and b['needs_projection']
    assert b['opening_paid']==100
    assert run("select count(*) from village.payment_events where event_type='account_review_required' and trade_id='historical-cancel'")==1
    must_fail(lambda:require(note='A different financial incident'),'payload mismatch')
    must_fail(lambda:require(req='bad-review',note='x'),'at least 5')
    must_fail(lambda:require(req='missing-review',tid='missing-review-account'),'account not found')
    new=receipt(20)['receiptId']
    must_fail(lambda:allocate(new,[dict(trade_id='historical-cancel',amount=20)],allow=True),'account not eligible')
    for role in ['anon','authenticated']:
        must_fail(lambda:run(f"set role {role}; select village.payment_require_review('historical-cancel','forbidden','Not authorized')"),'permission denied')


def missing_contract_and_cancelled_account():
    for tid, status in [('missing-contract','계약누락'),('cancelled-account','취소')]:
        run('select village.payment_refresh_accounts(%s)', (Jsonb([dict(trade_id=tid,billed_amount=100,
            deposit_status='',contract_status=status,observed_at='2026-10-20T00:00:00Z')]),))
        r=receipt(100)['receiptId']
        must_fail(lambda:allocate(r,[dict(trade_id=tid,amount=100)]),'account not eligible')


def invalid_inputs_and_merchant_scope():
    must_fail(lambda:receipt(0),'positive')
    must_fail(lambda:receipt(1,occurred=None),'occurred_at')
    must_fail(lambda:account('bad',-1),'nonnegative integer')
    f=receipt(25,'front','merchant-front',approval_number='SAME',merchant_id='merchant-a')
    t=receipt(25,'toss','merchant-toss',approval_number='SAME',merchant_id='merchant-b')
    assert f['receiptId']!=t['receiptId']
    late=receipt(25,'toss','far-time',approval_number='SAME',merchant_id='merchant-a',occurred='2026-10-22T00:00:00Z')
    assert late['receiptId']!=f['receiptId']


def main():
    global DSN
    for name in ['initdb','pg_ctl']:
        if not shutil.which(name):raise SystemExit(f'{name} is required for the disposable PostgreSQL test')
    with tempfile.TemporaryDirectory(prefix='payment-ledger-test-') as tmp:
        data=Path(tmp)/'data'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        subprocess.run(['initdb','-D',str(data),'-A','trust','--no-locale','-E','UTF8'],check=True,stdout=subprocess.DEVNULL)
        subprocess.run(['pg_ctl','-D',str(data),'-l',str(Path(tmp)/'postgres.log'),'-o',f'-h 127.0.0.1 -p {port} -k {tmp}','start'],check=True,stdout=subprocess.DEVNULL)
        try:
            DSN=f'host=127.0.0.1 port={port} dbname=postgres'
            run('create schema village; create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema village to service_role')
            run(MIGRATION.read_text())
            run(MIGRATION.read_text())  # Safe to reapply before activation.
            for fn in [partial_combined_changes,receipt_limits_and_atomicity,idempotency_and_immutable_identity,
                       alias_and_cancellation,cancellation_before_approval,ambiguous_approval,historical_baseline,
                       stale_snapshots_and_projection,trusted_overpayment_only,reallocation_full_map,concurrency,
                       permissions,opening_balance_reconciliation,conflicting_source_alias,front_trade_binding_survives_toss_first,historical_cancellation_requires_review,missing_contract_and_cancelled_account,invalid_inputs_and_merchant_scope]:check(fn.__name__,fn)
            print(f'{COUNT} PostgreSQL financial scenarios passed (including concurrent transactions).')
        finally:subprocess.run(['pg_ctl','-D',str(data),'-m','immediate','stop'],check=True,stdout=subprocess.DEVNULL)

if __name__=='__main__':main()
