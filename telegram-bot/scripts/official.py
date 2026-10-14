"""One existing unlock passphrase. Secrets travel only through hidden input and stdin."""
import getpass, json, pathlib, signal, subprocess, sys

def main():
    child = None
    def stop(_signal, _frame):
        if child is None:
            raise KeyboardInterrupt
        if child.poll() is None:
            child.terminate()
    for event in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(event, stop)
    try:
        root = pathlib.Path(__file__).resolve().parents[1]
        if (root / 'state/hosted-handoff.json').exists():
            print('This bot has been handed to the XMR20 server. Use Connect Hosted XMR20 Bot to check it; starting a second poller is blocked.')
            return 1
        config = {}
        env_file = root / '.env.local'
        if env_file.exists():
            if env_file.is_symlink(): raise ValueError()
            for line in env_file.read_text().splitlines():
                line = line.strip()
                if not line or line.startswith('#'): continue
                key, separator, value = line.partition('=')
                if not separator or key not in {'TELEGRAM_BOT_USERNAME', 'TELEGRAM_OWNER_ID', 'XMR20_CREDENTIAL_STORAGE'}: raise ValueError()
                config[key] = value.strip()
            if config.get('TELEGRAM_BOT_USERNAME', 'XMR20_Bot').lower() != 'xmr20_bot': raise ValueError()
            if config.get('XMR20_CREDENTIAL_STORAGE', 'encrypted-vault') != 'encrypted-vault': raise ValueError()
        edit = '--edit' in sys.argv
        action = 'setup' if '--setup' in sys.argv or edit else 'start'
        saved = (root / 'state/official-bot.vault').is_file()
        print('XMR20 · @XMR20_Bot · Solana mainnet')
        print('One unlock password: use the EXISTING Turnkey vault passphrase.')
        print('Your old Telegram vault password is not needed.')
        values = {'action': action, 'edit': edit, 'openRegistration': '--open-registration' in sys.argv}
        if action == 'setup' and (not saved or edit):
            owner_file = root / 'state/official-owner.json'
            owner = config.get('TELEGRAM_OWNER_ID') or (json.loads(owner_file.read_text())['ownerId'] if owner_file.is_file() else input('Your numeric Telegram user ID: ').strip())
            if edit and saved: print('Leave an entry blank to keep its saved value. This edits an unfinished setup only.')
            print('Owner account:', int(owner))
            values.update(ownerId=int(owner),
                withdrawalAddress=input('Your separate Solana withdrawal address: ').strip(),
                token=getpass.getpass('@XMR20_Bot token from BotFather (hidden): ').strip(),
                heliusApiKey=getpass.getpass('Helius API key or mainnet RPC URL (hidden): ').strip())
        if saved and not edit: print('Using saved encrypted connection details. No API keys needed.')
        values['password'] = getpass.getpass('XMR20 unlock — existing Turnkey passphrase (hidden): ')
        print('Checking the connection and mainnet configuration. Financial actions need your confirmation in Telegram.')
        print('First activation verifies a zero-value signature with an invalid blockhash; it is never broadcast.')
        target = pathlib.Path(__file__).resolve().parents[1] / 'src/official.mjs'
        child = subprocess.Popen(['node', str(target)], stdin=subprocess.PIPE, text=True)
        payload = json.dumps(values); values.clear()
        child.communicate(input=payload); payload = None
        return child.returncode
    except KeyboardInterrupt:
        return 130
    except (ValueError, EOFError):
        print('Setup cancelled or invalid numeric ID. No secret details logged.')
        return 1
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill(); child.wait()

if __name__ == '__main__':
    raise SystemExit(main())
