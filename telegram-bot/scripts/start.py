"""Owner-run hidden prompts; forward shutdown to allow the vault lock to close."""
import getpass
import json
import pathlib
import signal
import subprocess


def main():
    child = None

    def stop(_signum, _frame):
        if child is None:
            raise KeyboardInterrupt
        if child.poll() is None:
            child.terminate()

    for event in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(event, stop)
    print('XMR20 Telegram TEST bot. No real money or deposit addresses.')
    try:
        password = getpass.getpass('Vault passphrase (hidden): ')
        target = pathlib.Path(__file__).resolve().parents[1] / 'src/main.mjs'
        child = subprocess.Popen(['node', str(target)], stdin=subprocess.PIPE, text=True)
        payload = json.dumps(dict(password=password))
        password = None
        child.communicate(input=payload)
        payload = None
        return child.returncode
    except KeyboardInterrupt:
        return 130
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == '__main__':
    raise SystemExit(main())
