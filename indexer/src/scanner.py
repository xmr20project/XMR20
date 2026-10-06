"""Bind the published read-only rules to an allowlisted verification gateway."""
import hashlib,json,os,re,types
from pathlib import Path

def scanner(gateway):
    root=Path(__file__).resolve().parent
    probe=dict(json=json,os=os,Path=Path,daemon=gateway.daemon)
    exec(compile((root/'probe_rules.py').read_text(),'probe_rules.py','exec'),probe)
    launch=dict(require=probe['require'],re=re)
    exec(compile((root/'launch_rules.py').read_text(),'launch_rules.py','exec'),launch)
    carrier=types.SimpleNamespace(**{k:probe[k] for k in ('require','canonical','atomic','chain','extract','MAGIC')},daemon=gateway.daemon,wallet=gateway.wallet)
    bridge=dict(carr=carrier,launch=types.SimpleNamespace(validate_record=launch['validate_record'],signing_domain=launch['signing_domain']),require=probe['require'],canonical=probe['canonical'],atomic=probe['atomic'],Path=Path,json=json,hashlib=hashlib,re=re)
    exec(compile((root/'bridge_rules.py').read_text(),'bridge_rules.py','exec'),bridge)
    return bridge
