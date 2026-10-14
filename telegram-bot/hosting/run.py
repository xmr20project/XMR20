"""systemd entry point; unlock data never goes into argv or environment."""
import json, os, pathlib, subprocess, signal
ROOT=pathlib.Path(__file__).resolve().parents[1]
state=pathlib.Path(os.environ['XMR20_STATE_DIR'])
# systemd owns this service's sole cgroup and has reaped any previous processes.
for name in ['official-bot.vault','mainnet.vault','mainnet-journal.vault','turnkey-connection.vault']:
    (state/(name+'.lock')).unlink(missing_ok=True)
password=(pathlib.Path(os.environ['CREDENTIALS_DIRECTORY'])/'unlock').read_text()
child=subprocess.Popen(['/usr/local/bin/node',str(ROOT/'src/mainnet.mjs')],stdin=subprocess.PIPE,text=True)
for event in [signal.SIGTERM,signal.SIGINT,signal.SIGHUP]:signal.signal(event,lambda *_:child.terminate())
try:
    child.communicate(json.dumps({'official':True,'password':password}));password=None
    raise SystemExit(child.returncode)
finally:
    if child.poll() is None:child.terminate();child.wait()
