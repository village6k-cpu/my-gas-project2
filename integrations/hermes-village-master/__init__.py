"""Optional user plugin. No Hermes core patch; authenticated Slack fetch remains authoritative."""
from __future__ import annotations
import contextvars
import json
import os
from pathlib import Path
import subprocess


def current_source(config):
    from agent.delegation_context import is_delegated_child_process_context
    if is_delegated_child_process_context():
        raise ValueError('Delegated children cannot apply owner corrections')
    # Deliberately do not use get_session_env: it falls back to untrusted CLI env.
    bound = {var.name: value for var, value in contextvars.copy_context().items()}
    def value(name):
        item = bound.get('HERMES_SESSION_' + name)
        if not isinstance(item, str) or not item:
            raise ValueError('Current native Slack turn required; no CLI/environment fallback')
        return item
    if value('PLATFORM') != 'slack' or value('USER_ID') != config['ownerId']:
        raise ValueError('Current sender is not the configured owner')
    channel, ts = value('CHAT_ID'), value('MESSAGE_ID')
    session_key = value('KEY')
    if config['teamId'] not in session_key.split(':'):
        raise ValueError('Current workspace is not configured')
    thread = bound.get('HERMES_SESSION_THREAD_ID')
    return {'platform':'slack', 'channel':channel, 'ts':ts,
            **({'threadTs':thread} if isinstance(thread,str) and thread else {}),
            'ref':'slack:'+channel+':'+ts, 'quote':'pending authoritative read',
            'verifiedOwner':True}


def handle(args, **kwargs):
    return _handle(args, 'price')


def handle_create(args, **kwargs):
    return _handle(args, 'create')


def _handle(args, kind):
    try:
        from hermes_constants import get_hermes_home
        config_path = Path(get_hermes_home()) / 'village-master-config.json'
        if config_path.stat().st_mode & 0o077:
            raise ValueError('Private issuer configuration required')
        config = json.loads(config_path.read_text())
        source = current_source(config)
        request = {'kind':kind,'scope':'standing','target':args['target'],
                   'price':args['price'],'unit':'KRW/day','source':source}
        if kind == 'create':
            request['components'] = args['components']
            if args.get('new_equipment'):
                request['newEquipment'] = args['new_equipment']
        if args.get('question_ts'):
            request['source']['questionTs'] = args['question_ts']
        env = dict(os.environ)
        env['VILLAGE_NATIVE_MASTER_TOOL'] = '1'
        result = subprocess.run([config['nodePath'], config['nativeRunnerPath'], str(config_path)],
                                input=json.dumps(request),text=True,capture_output=True,
                                timeout=400 if kind == 'create' else 180,env=env,check=False)
        if result.returncode:
            return json.dumps({'success':False,'error':result.stderr.strip() or 'verified operation failed'})
        return result.stdout
    except Exception as error:
        return json.dumps({'success':False,'error':str(error)})

SCHEMA = {'name':'village_master_price',
          'description':'Fill a missing standard per-item daily rate from the current owner Slack reply, including a short answer to one exact prior question. Verifies original Slack sender and content. Does not authorize trade discounts, existing price replacement, booking recreation or customer sending. Ambiguity returns needs_review.',
          'parameters':{'type':'object','properties':{'target':{'type':'string'},'price':{'type':'integer','minimum':0},'question_ts':{'type':'string'}},'required':['target','price'],'additionalProperties':False}}

CREATE_SCHEMA = {'name':'village_master_create',
    'description':'Register a missing catalog product and, when needed, explicitly owner-confirmed new physical equipment/stock. Verifies the current owner Slack reply to the exact prior question naming composition, classifications and stock counts. Reuses existing inventory ledger registration, sheet mirror, catalog append and list/template readback. Never guesses stock, overwrites existing equipment or sends customer messages.',
    'parameters':{'type':'object','properties':{
        'target':{'type':'string'},'price':{'type':'integer','minimum':0},'question_ts':{'type':'string'},
        'components':{'type':'array','minItems':1,'maxItems':50,'items':{'type':'object','properties':{'name':{'type':'string'},'qty':{'type':'integer','minimum':1,'maximum':1000}},'required':['name','qty'],'additionalProperties':False}},
        'new_equipment':{'type':'array','maxItems':50,'items':{'type':'object','properties':{'name':{'type':'string'},'major':{'type':'string'},'category':{'type':'string'},'stockTotal':{'type':'integer','minimum':0,'maximum':9999},'stockMaintenance':{'type':'integer','minimum':0,'maximum':9999}},'required':['name','major','category','stockTotal','stockMaintenance'],'additionalProperties':False}}
    },'required':['target','price','components'],'additionalProperties':False}}

def register(ctx):
    ctx.register_tool(name='village_master_price',toolset='village_master',schema=SCHEMA,handler=handle,emoji='🧾')
    ctx.register_tool(name='village_master_create',toolset='village_master',schema=CREATE_SCHEMA,handler=handle_create,emoji='🧾')
