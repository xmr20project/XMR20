"""Owner-run local unlock; nothing sensitive goes in arguments or shell history."""
import getpass
import json
import pathlib
import signal
import subprocess

def main():
    child = None
    def stop(_signal, _frame):
        if child is None: raise KeyboardInterrupt
        if child.poll() is None: child.terminate()
    for event in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP): signal.signal(event, stop)
    try:
        print('Private XMR20 mainnet pilot. Requires completed wallet/policy settings.')
        values = {
            'telegramPassword': getpass.getpass('Telegram vault passphrase (hidden): '),
            'turnkeyPassword': getpass.getpass('Turnkey vault passphrase (hidden): '),
            'heliusApiKey': getpass.getpass('Helius API key (hidden; this run only): '),
        }
        target = pathlib.Path(__file__).resolve().parents[1] / 'src/mainnet.mjs'
        child = subprocess.Popen(['node', str(target)], stdin=subprocess.PIPE, text=True)
        payload = json.dumps(values)
        values.clear()
        child.communicate(input=payload)
        payload = None
        return child.returncode
    except KeyboardInterrupt: return 130
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try: child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()

if __name__ == '__main__': raise SystemExit(main())
