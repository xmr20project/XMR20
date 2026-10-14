"""Owner-run encrypted state import. Fixed paths; never emits payloads/errors."""
import base64,json,os,pathlib,pwd,subprocess,sys
ROOT=pathlib.Path('/opt/xmr20-telegram/current')
STATE=pathlib.Path('/var/lib/xmr20-telegram')
CRED=pathlib.Path('/etc/credstore.encrypted/xmr20-telegram-unlock')
VAULTS=['official-bot.vault','turnkey-connection.vault','mainnet.vault','mainnet-journal.vault','mainnet-setup-journal.vault']
FILES=VAULTS+['turnkey-public.json','mainnet-settings.json']
def status():
    r=subprocess.run(['systemctl','is-active','--quiet','xmr20-telegram'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    out={'configured':CRED.exists(),'active':r.returncode==0}
    p=STATE/'mainnet-runtime.json'
    if p.exists():
        data=json.loads(p.read_text());out.update({k:data[k] for k in ['checkedAt','connected','running','privateOwnerOnly'] if k in data})
    return out

def main():
    action=sys.argv[1]
    if action=='status':print(json.dumps(status()));return
    if action=='enable-registration':
        if not CRED.exists():raise ValueError()
        decrypted=subprocess.run(['systemd-creds','decrypt','--name=unlock',str(CRED),'-'],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=20)
        if decrypted.returncode:raise ValueError()
        password=decrypted.stdout.decode();decrypted=None
        subprocess.run(['systemctl','stop','xmr20-telegram'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        try:
            r=subprocess.run(['runuser','-u','xmr20-telegram','--','/usr/local/bin/node',str(ROOT/'src/activate-mainnet.mjs')],input=json.dumps({'official':True,'password':password,'openRegistration':True,'activateOnly':True}),text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=dict(os.environ,XMR20_STATE_DIR=str(STATE)),timeout=150)
            if r.returncode:raise ValueError()
        finally:
            password=None
            subprocess.run(['systemctl','reset-failed','xmr20-telegram'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            subprocess.run(['systemctl','start','xmr20-telegram'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        print(json.dumps({'publicRegistrationEnabled':True}));return
    if action!='import' or CRED.exists():raise ValueError()
    raw=sys.stdin.read(30000001)
    if len(raw)>30000000:raise ValueError()
    data=json.loads(raw);raw=None
    if set(data['files'])!=set(FILES) or not 16<=len(data['password'])<=1024:raise ValueError()
    user=pwd.getpwnam('xmr20-telegram');STATE.mkdir(mode=0o700,exist_ok=True);os.chown(STATE,user.pw_uid,user.pw_gid)
    for name,encoded in data['files'].items():
        content=base64.b64decode(encoded,validate=True)
        if len(content)>10000000:raise ValueError()
        p=STATE/name
        # Unconfigured retries must use identical ciphertext, not overwrite receipts.
        if p.exists():
            if name!='mainnet-settings.json' and p.read_bytes()!=content:raise ValueError()
        else:
            p.write_bytes(content);p.chmod(0o600);os.chown(p,user.pw_uid,user.pw_gid)
    gateway=STATE/'gateway-settings.json';gateway.write_text(json.dumps({'transport':'local','forcedCommand':True}));gateway.chmod(0o600);os.chown(gateway,user.pw_uid,user.pw_gid)
    env=dict(os.environ,XMR20_STATE_DIR=str(STATE))
    r=subprocess.run(['runuser','-u','xmr20-telegram','--','/usr/local/bin/node',str(ROOT/'src/activate-mainnet.mjs')],input=json.dumps({'official':True,'password':data['password'],'openRegistration':data.get('openRegistration') is True,'activateOnly':True}),text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=env,timeout=150)
    if r.returncode:raise ValueError()
    CRED.parent.mkdir(mode=0o700,exist_ok=True)
    r=subprocess.run(['systemd-creds','encrypt','--with-key=host','--name=unlock','-',str(CRED)],input=data['password'].encode(),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
    if r.returncode:raise ValueError()
    CRED.chmod(0o600);data=None
    subprocess.run(['systemctl','reset-failed','xmr20-telegram'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    subprocess.run(['systemctl','start','xmr20-telegram'],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    print(json.dumps({'imported':True,'startupRequested':True}))
if __name__=='__main__':
    os.umask(0o077)
    try:main()
    except Exception:
        print('Hosted connection did not complete. Encrypted state preserved; no secret details logged.');sys.exit(1)
