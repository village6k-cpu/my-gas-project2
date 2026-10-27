#!/usr/bin/env python3
"""Route the pinned native driver to its own short Unix socket.

The isolated installation HOME is too long for a macOS Unix socket. Keep the
driver's native launch/TCC behavior and explicit per-session sockets intact.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

def driver_args(args,socket):
    args=list(args) or ['mcp']
    if args[0] in {'mcp','call','serve','status','stop','config','recording'} and '--socket' not in args:
        args+=['--socket',socket]
    return args

def invocation(binary,args):
    argv=[binary,*args]
    # Display sleep makes ScreenCaptureKit report zero shareable displays.
    # Scope the assertion to the driver connection; never change pmset.
    return ['/usr/bin/caffeinate','-d','-u',*argv] if args[0] in {'mcp','call'} else argv

def scoped_manifest(manifest,socket,wrapper=None):
    invocation=manifest['mcp_invocation']
    invocation['args']=driver_args(invocation['args'],socket)
    if wrapper:invocation['command']=wrapper
    return manifest

def main():
    control=Path(__file__).resolve().parent;root=control.parent
    cfg=json.loads((control/'cua-driver.json').read_text())
    binary=Path(cfg['binary']).resolve();socket=cfg['socket']
    if not binary.is_relative_to(root) or not binary.is_file():
        raise ValueError('driver must be inside this installation')
    if socket!='/tmp/village-migrated-cua.sock':
        raise ValueError('unexpected migration driver socket')
    args=sys.argv[1:]
    if args and args[0]=='manifest':
        result=subprocess.run([str(binary),'manifest'],capture_output=True,text=True,check=True)
        print(json.dumps(scoped_manifest(json.loads(result.stdout),socket,str(Path(__file__).resolve()))))
    else:
        argv=invocation(str(binary),driver_args(args,socket))
        os.execv(argv[0],argv)

if __name__=='__main__':main()
