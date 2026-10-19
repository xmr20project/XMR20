"""Fixed J3 service transport; consume existing settings only on their host.

No owner key is accepted. Only the broker's narrow method set can run. Errors
export fixed stages, never private settings, RPC headers or exception text.
"""
import importlib.util
import json
import sys
from pathlib import Path

STAGE = Path('/opt/xmr20-joint-transferable-stage-20261009')


def main():
    global active_broker
    raw = sys.stdin.buffer.read(200001)
    if len(raw) > 200000:
        raise ValueError('Request too large')
    request = json.loads(raw)
    if type(request) is not dict or set(request) != {'method', 'params'}:
        raise ValueError('Unexpected fields')
    if request['method'] not in {
        'joint-capabilities', 'carrier-address', 'node-identities', 'node',
        'verify', 'funding-status', 'sync-status', 'reconnect-configured-daemon',
        'transfer', 'probe', 'send_raw_transaction'
    } or type(request['params']) is not dict:
        raise ValueError('Method not permitted')
    spec = importlib.util.spec_from_file_location('joint_v3_treasury', STAGE / 'treasury.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.path.insert(0, '/opt/xmr20-v3-canary-20260930/packages/xmr20-bridge')
    sys.path.insert(0, '/opt/xmr20-nft-submit/release-f8f18c8a0d0f/submission')
    import mainnet_launch as launch
    import launch_fee_policy as fees
    import treasury_adapter
    # Settings never leave this ordinary host-side service process.
    settings = json.loads(Path('/etc/xmr20-mainnet/monero.json').read_text())
    settings.update(json.loads(Path('/etc/xmr20-nft-submit/nft-settings.json').read_text()))
    broker = module.Broker(settings, launch, treasury_adapter.Adapter(settings, launch.carrier, launch, fees), own_node=True)
    active_broker = broker
    print(module.ordered({'result': broker.call(request['method'], request['params'])}))


if __name__ == '__main__':
    try:
        main()
    except BaseException:
        print(json.dumps({
            'error': 'J3 treasury operation did not complete; preserve its saved outcome.',
            'phase': getattr(globals().get('active_broker'), 'phase', 'startup')
        }))
        sys.exit(1)
