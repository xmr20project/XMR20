"""Owner-run read-only readiness check; secrets enter only through a hidden pipe."""
import getpass
import json
import pathlib
import subprocess

def main():
    print('XMR20 mainnet readiness check. No wallets created or transactions signed/sent.')
    password = getpass.getpass('Turnkey vault passphrase (hidden): ')
    helius = getpass.getpass('Helius API key (hidden; used for this check only): ')
    target = pathlib.Path(__file__).resolve().parents[1] / 'src/check-mainnet.mjs'
    result = subprocess.run(['node', str(target)], input=json.dumps({'password':password,'heliusApiKey':helius}), text=True)
    password = helius = None
    return result.returncode

if __name__ == '__main__':
    try: raise SystemExit(main())
    except KeyboardInterrupt: raise SystemExit(130)
