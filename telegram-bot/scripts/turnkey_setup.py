"""Owner-run local API credential generation; never display the private key."""
import getpass
import json
import pathlib
import subprocess
import os
import uuid

if __name__ == '__main__':
    root = pathlib.Path(__file__).resolve().parents[1]
    try:
        print('XMR20 Turnkey connection setup. This does not create a crypto wallet or send money.')
        print('Your API private key will be generated locally and saved encrypted.')
        print('Re-running setup unlocks the existing credential; it does not replace it.')
        password = getpass.getpass('Turnkey vault passphrase (16+ characters; hidden) = ')
        if len(password) < 16 or password != getpass.getpass('Repeat passphrase = '):
            raise SystemExit('Passphrases must match and be at least 16 characters. Nothing saved.')
        state = root / 'state'
        if state.is_symlink():
            raise SystemExit('Refusing a linked settings directory.')
        state.mkdir(mode=0o700, exist_ok=True)
        config = state / 'turnkey-public.json'
        if config.is_symlink():
            raise SystemExit('Refusing a linked settings file.')
        if not config.exists():
            try:
                organization_id = str(uuid.UUID(input('Turnkey Organization ID = ').strip()))
            except ValueError:
                raise SystemExit('Organization ID must be a UUID. Nothing saved.')
            fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as out:
                json.dump({'organizationId': organization_id}, out)
        result = subprocess.run(['node', str(root / 'src/turnkey-setup.mjs')], input=json.dumps({'password':password}), text=True)
        raise SystemExit(result.returncode)
    except (EOFError, KeyboardInterrupt):
        raise SystemExit('\nSetup cancelled.')
