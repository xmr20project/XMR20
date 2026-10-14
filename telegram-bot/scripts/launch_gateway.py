"""Private SSH stdin transport. No listener, wallet keys, worker or new API.

Installed/run only on the existing launch host. The existing service remains the
sole writer and performs its normal validation, Sender and Monero proof checks.
Never print configuration, bearer tokens, request bodies or provider exceptions.
"""
import json
import os
import pathlib
import fcntl
import tempfile
import re
import sys
import urllib.request
import urllib.error

ACTIONS = {
    'meteoraCatalog': set(), 'meteoraAccount': set(),
    'meteoraMetadata': {'name', 'symbol', 'imageBase64'},
    'meteoraReserve': {'id','flow','initialSolLamports','mint','creatorNft','platformNft','name','symbol','metadataHash','metadataUri'},
    'meteoraPrepare': {'id'}, 'meteoraSubmit': {'id','transactions'},
    'meteoraStatus': {'id'}, 'meteoraRecover': {'id'},
}

# Only fixed preparation errors cross this boundary, never arbitrary backend
# text, provider responses, URLs or credentials. Submission errors stay opaque.
PREPARATION_ERRORS = {
    'Insufficient SOL for pool setup and the inscription fee. Add SOL and retry preparation; nothing was sent.': 'LAUNCH_BALANCE',
    'Insufficient SOL for the initial buy and launch costs. Add SOL or reduce the initial buy; nothing was sent.': 'LAUNCH_BALANCE',
    'The balance needed for the launch is too low. Refresh your balances and retry preparation; nothing was sent.': 'LAUNCH_TOKEN_BALANCE',
    'Launch check failed during pool creation and the initial buy. Retry preparation; nothing was sent.': 'LAUNCH_POOL_CHECK',
    'Launch check failed during token creation and SOL conversion. Retry preparation; nothing was sent.': 'LAUNCH_MINT_CHECK',
    'The network could not check the launch right now. Retry preparation; nothing was sent.': 'LAUNCH_NETWORK_CHECK',
    'The network could not validate the launch timing. Retry preparation; nothing was sent.': 'LAUNCH_NETWORK_CHECK',
    'The swap does not meet the quoted minimum. Retry preparation for a fresh quote; nothing was sent.': 'LAUNCH_QUOTE_CHECK',
}

def safe_backend_error(action, payload):
    if action != 'meteoraPrepare' or not isinstance(payload, dict):
        return 'LAUNCH_GATEWAY_UNAVAILABLE'
    message = payload.get('error')
    return PREPARATION_ERRORS.get(message, 'LAUNCH_GATEWAY_UNAVAILABLE') if isinstance(message, str) else 'LAUNCH_GATEWAY_UNAVAILABLE'

def validate(message, owner):
    action = message.get('action')
    data = message.get('data')
    if action not in ACTIONS or not isinstance(data, dict) or set(data) - ACTIONS[action]:
        raise ValueError('Rejected action')
    if action == 'meteoraReserve' and data.get('flow') != 'sol-launch-buy-v1':
        raise ValueError('XMR20 flow required')
    return dict(data, action=action, owner=owner)

REGISTRY = pathlib.Path('/var/lib/xmr20-tg-pilot/wallet-bindings.json')
def binding_action(message, owner, path=REGISTRY):
    action = message.get('action')
    if action == 'capabilities' and message == {'action':'capabilities','data':{}}:
        return {'version':2,'separateWalletBindings':True}
    binding = message.get('binding')
    if action == 'registerWallet':
        data = message.get('data', {})
        if set(message) != {'action','data'} or set(data) != {'binding','walletAddress'}:
            raise ValueError()
        binding, wallet = data['binding'], data['walletAddress']
        if not isinstance(binding,str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',binding): raise ValueError()
        if not isinstance(wallet,str) or not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}',wallet) or wallet == owner: raise ValueError()
        with open(str(path)+'.lock','a') as lock:
            os.chmod(str(path)+'.lock',0o600)
            fcntl.flock(lock,fcntl.LOCK_EX)
            rows=json.loads(path.read_text()) if path.exists() else {}
            if binding in rows:
                if rows[binding] != wallet: raise ValueError()
            else:
                if len(rows)>=1000 or wallet in rows.values(): raise ValueError()
                rows[binding]=wallet
                fd,tmp=tempfile.mkstemp(dir=path.parent,prefix='.bindings-')
                try:
                    with os.fdopen(fd,'w') as output:
                        json.dump(rows,output);output.flush();os.fsync(output.fileno())
                    os.replace(tmp,path)
                finally:
                    if os.path.exists(tmp):os.unlink(tmp)
            return {'binding':binding,'walletAddress':wallet}
    if binding is not None:
        if not isinstance(binding,str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}',binding): raise ValueError()
        rows=json.loads(path.read_text())
        owner=rows[binding]
    if set(message)-{'action','data','binding'}:raise ValueError()
    return validate(message,owner)

def main():
    owner = sys.argv[1] if len(sys.argv) == 2 else ''
    if not re.fullmatch(r'[1-9A-HJ-NP-Za-km-z]{32,44}', owner):
        return 1
    # Existing host-private credential is used in memory, never copied to the
    # bot, sent through SSH stdout, logged or included in source packages.
    with open('/etc/xmr20-mainnet/service.json') as handle:
        config = json.load(handle)
    token = config.get('serviceToken')
    port = config.get('port', 8791)
    if not isinstance(port, int) or not 1024 <= port <= 65535 or config.get('network') != 'mainnet-beta':
        return 1
    if not isinstance(token, str) or len(token) < 32:
        return 1
    del config
    while True:
        line = sys.stdin.readline(370001)
        if not line: break
        try:
            if len(line) > 370000:
                raise ValueError()
            request = json.loads(line)
            body = binding_action(request, owner)
            if request.get('action') in ('registerWallet','capabilities'):
                print(json.dumps({'ok':True,'result':body}),flush=True)
                continue
            req = urllib.request.Request('http://127.0.0.1:'+str(port)+'/rpc', data=json.dumps(body).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+token}, method='POST')
            # Loopback endpoint only; no redirects to another host.
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self, *_args, **_kwargs): return None
            with urllib.request.build_opener(NoRedirect).open(req, timeout=120) as response:
                raw = response.read(2000001)
                if len(raw) > 2000000: raise ValueError()
                result = json.loads(raw)
            output = {'ok':False,'error':safe_backend_error(request.get('action'), result)} if isinstance(result,dict) and result.get('error') else {'ok':True,'result':result}
        except urllib.error.HTTPError as error:
            output = {'ok':False,'error':'LAUNCH_GATEWAY_UNAVAILABLE'}
            try:
                raw = error.read(8193)
                if len(raw) <= 8192:
                    output['error'] = safe_backend_error(request.get('action'), json.loads(raw))
            except Exception:
                pass
        except Exception:
            output = {'ok':False,'error':'LAUNCH_GATEWAY_UNAVAILABLE'}
        print(json.dumps(output, separators=(',', ':')), flush=True)
    return 0

if __name__ == '__main__':
    try: raise SystemExit(main())
    except Exception: raise SystemExit(1)
