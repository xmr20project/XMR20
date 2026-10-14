"""Owner-unlocked read-only Turnkey identity check. Never print credentials."""
import getpass
import json
import pathlib
import subprocess

if __name__ == '__main__':
    try:
        print('Turnkey connection check: account identity, API key registration and root-quorum membership.')
        print('No wallets created; no transaction signing, sending or permission changes.')
        password = getpass.getpass('Turnkey vault passphrase (hidden) = ')
        target = pathlib.Path(__file__).resolve().parents[1] / 'src/turnkey-check.mjs'
        result = subprocess.run(['node', str(target)], input=json.dumps({'password':password}), text=True)
        raise SystemExit(result.returncode)
    except (EOFError, KeyboardInterrupt):
        raise SystemExit('\nCheck cancelled.')
