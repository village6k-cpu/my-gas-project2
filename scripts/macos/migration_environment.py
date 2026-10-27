"""Pure native launch settings: retain configuration, discard turn identity."""
import re

def persistent_environment(source):
    transient=('HERMES_SESSION_','HERMES_TURN_','HERMES_CRON_AUTO_DELIVER_')
    return {key:value for key,value in source.items()
            if not key.startswith(transient) and key!='HERMES_CRON_SESSION'}

def cua_environment(root):
    wrapper=str(root/'control/village-cua-driver.py')
    return {'CUA_DRIVER_COMMAND':wrapper,
            'HERMES_CUA_DRIVER_CMD':str(root/'venv-root/bin/python')+' '+wrapper}

def profile_environment(configured,effective_native):
    return persistent_environment({**configured,**effective_native})

def relocate_text(value,pairs):
    for source,target in sorted(pairs,key=lambda row:len(row[0]),reverse=True):
        for spelling in (source,source.replace('/','\\\\'),source.replace('/','\\'),'/c/'+source[3:]):
            value=value.replace(spelling,target)
    for target in {target for _,target in pairs}:
        value=re.sub(re.escape(target)+r'''[^\s`"'<>|;]*''',
                     lambda match:re.sub(r'\\+', '/',match[0]),value)
    return value
