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
    try:
        from hermes_constants import get_hermes_home
        config_path = Path(get_hermes_home()) / 'village-master-config.json'
        if config_path.stat().st_mode & 0o077:
            raise ValueError('Private issuer configuration required')
        config = json.loads(config_path.read_text())
        source = current_source(config)
        request = {'kind':'price','scope':'standing','target':args['target'],
                   'price':args['price'],'unit':'KRW/day','source':source}
        if args.get('question_ts'):
            request['source']['questionTs'] = args['question_ts']
        env = dict(os.environ)
        env['VILLAGE_NATIVE_MASTER_TOOL'] = '1'
        result = subprocess.run([config['nodePath'], config['nativeRunnerPath'], str(config_path)],
                                input=json.dumps(request),text=True,capture_output=True,
                                timeout=180,env=env,check=False)
        if result.returncode:
            return json.dumps({'success':False,'error':result.stderr.strip() or 'verified operation failed'})
        return result.stdout
    except Exception as error:
        return json.dumps({'success':False,'error':str(error)})

SCHEMA = {'name':'village_master_price',
          'description':'Fill a missing standard per-item daily rate from the current owner Slack reply, including a short answer to one exact prior question. Verifies original Slack sender and content. Does not authorize trade discounts, existing price replacement, booking recreation or customer sending. Ambiguity returns needs_review.',
          'parameters':{'type':'object','properties':{'target':{'type':'string'},'price':{'type':'integer','minimum':0},'question_ts':{'type':'string'}},'required':['target','price'],'additionalProperties':False}}

def register(ctx):
    ctx.register_tool(name='village_master_price',toolset='village_master',schema=SCHEMA,handler=handle,emoji='🧾')
