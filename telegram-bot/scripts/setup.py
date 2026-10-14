"""Owner-run encrypted token entry; standard library only. Never save plaintext secrets."""
import getpass
import json
import pathlib
import subprocess

if __name__ == '__main__':
    print('XMR20 Telegram TEST bot encrypted setup. No connection or messages will be sent.')
    token = getpass.getpass('Telegram Bot HTTP API key = ')
    password = getpass.getpass('Choose your vault passphrase (16+ characters; hidden) = ')
    if len(password) < 16 or password != getpass.getpass('Repeat vault passphrase = '):
        raise SystemExit('Passphrase too short or does not match. Nothing saved.')
    ids_text = input('Allowed Telegram numeric user IDs (comma separated; Enter to add later) = ')
    try:
        ids = [int(v.strip()) for v in ids_text.split(',')] if ids_text.strip() else []
    except ValueError:
        raise SystemExit('IDs must be numbers. Nothing saved.')
    target = pathlib.Path(__file__).resolve().parents[1] / 'src/setup.mjs'
    result = subprocess.run(['node', str(target)], input=json.dumps(dict(allowedUsers=ids,token=token,password=password)),text=True)
    raise SystemExit(result.returncode)
