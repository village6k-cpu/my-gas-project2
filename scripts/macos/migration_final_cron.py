"""Prepare an offline cron document from latest closed source execution state.

Only the already-reviewed workdir translation is imported from staging. No
job runs here. A later activation must recheck that next_run_at is still future.
"""
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from croniter import croniter

EXECUTION_FIELDS = {'next_run_at','last_run_at','last_status','last_error',
                    'last_delivery_error','fire_claim'}


def job_index(document):
    if not isinstance(document,dict) or not isinstance(document.get('jobs'),list):
        raise ValueError('Invalid cron document')
    result={}
    for job in document['jobs']:
        if (not isinstance(job,dict) or not isinstance(job.get('id'),str)
                or not job['id'] or job['id'] in result):
            raise ValueError('Missing or duplicate cron identity')
        result[job['id']]=job
    return result


def definition(job):
    result={k:deepcopy(v) for k,v in job.items() if k not in EXECUTION_FIELDS}
    repeat=result.get('repeat')
    if isinstance(repeat,dict):repeat.pop('completed',None)
    return result


def aware(value):
    if not isinstance(value,str):raise ValueError('Missing cron timestamp')
    result=datetime.fromisoformat(value.replace('Z','+00:00'))
    if result.tzinfo is None or result.utcoffset() is None:
        raise ValueError('Cron timestamp requires timezone')
    return result


def prepare(latest, baseline, native, *, now):
    if not isinstance(now,datetime) or now.tzinfo is None or now.utcoffset() is None:
        raise ValueError('Explicit current time and timezone required')
    current,original,ported=map(job_index,(latest,baseline,native))
    if set(current)!=set(original) or set(current)!=set(ported):
        raise ValueError('Cron job set changed; review before migration')
    if {k:v for k,v in baseline.items() if k!='jobs'}!={k:v for k,v in native.items() if k!='jobs'}:
        raise ValueError('Unexpected prepared cron metadata change')
    document=deepcopy(latest)
    output=job_index(document)
    adjustments=[]
    for ident,job in current.items():
        old,new=original[ident],ported[ident]
        if definition(job)!=definition(old):
            raise ValueError('Source cron definition changed: '+ident)
        if {k:v for k,v in old.items() if k!='workdir'}!={k:v for k,v in new.items() if k!='workdir'}:
            raise ValueError('Native cron changes more than workdir: '+ident)
        target=new.get('workdir')
        if not isinstance(target,str) or not (target.startswith('/') or Path(target).is_absolute()):
            raise ValueError('Native cron workdir is not absolute')
        if job.get('fire_claim') is not None:
            raise ValueError('Unsettled cron fire claim: '+ident)
        output[ident]['workdir']=target
        if job.get('enabled') is not True or job.get('state')!='scheduled':
            continue
        schedule=job.get('schedule',{})
        if schedule.get('kind')!='cron' or not isinstance(schedule.get('expr'),str):
            raise ValueError('Unreviewed active cron schedule: '+ident)
        due=aware(job.get('next_run_at'))
        if due<=now:
            # Start after the cutover instant. Never enumerate or replay missed fires.
            future=croniter(schedule['expr'],now).get_next(datetime)
            if future<=now:raise ValueError('Cron did not advance')
            output[ident]['next_run_at']=future.isoformat()
            adjustments.append(dict(id=ident,old=job['next_run_at'],new=future.isoformat()))
    return dict(document=document,next_run_adjustments=adjustments,
                execution_history_preserved=True,backfill=False,activated=False)
