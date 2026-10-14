#!/usr/bin/env python3
"""Owner-run handoff. Transfers encrypted state over pinned SSH, never prints secrets."""
import base64,getpass,json,os,pathlib,re,subprocess,time,sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
STATE=ROOT/'state'
VAULTS=['official-bot.vault','turnkey-connection.vault','mainnet.vault','mainnet-journal.vault','mainnet-setup-journal.vault']
FILES=VAULTS+['turnkey-public.json','mainnet-settings.json']
def main():
    target=json.loads((STATE/'hosted-target.json').read_text())
    if not re.fullmatch(r'[-A-Za-z0-9_.]+@[-A-Za-z0-9.]+',target['host']):raise ValueError()
    ssh=['ssh','-T','-i',target['identityFile'],'-o','UserKnownHostsFile='+target['knownHostsFile'],'-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','ConnectTimeout=12',target['host']]
    def remote(action,payload=None):
        r=subprocess.run(ssh+['python3 /opt/xmr20-telegram/current/hosting/owner_admin.py '+action],input=payload,text=True,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=180)
        if r.returncode:raise ValueError()
        return json.loads(r.stdout)
    enable='--open-registration' in sys.argv
    status=remote('status')
    if enable and status['configured']:
        remote('enable-registration')
    if not status['configured']:
        print('Stop the local bot with Ctrl+C first. This moves its saved wallets/orders to the XMR20 server.')
        print('Use your existing unlock password. No new API keys are needed.')
        password=getpass.getpass('Existing Turnkey vault passphrase (hidden): ')
        result=subprocess.run(['node',str(ROOT/'scripts/check_host_transfer.mjs')],input=json.dumps({'password':password}),text=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,cwd=ROOT,timeout=30)
        if result.returncode:raise ValueError()
        locks=[]
        try:
            for name in VAULTS:locks.append((STATE/(name+'.lock'),os.open(STATE/(name+'.lock'),os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600)))
            files={}
            for name in FILES:
                p=STATE/name
                if p.is_symlink() or not p.is_file() or p.stat().st_size>10000000:raise ValueError()
                files[name]=base64.b64encode(p.read_bytes()).decode()
            (STATE/'hosted-handoff.json').write_text(json.dumps({'host':target['host'],'status':'handoff-started','at':time.time()}))
            remote('import',json.dumps({'password':password,'files':files,'openRegistration':enable}))
            password=files=None
        finally:
            for path,fd in locks:os.close(fd);path.unlink()
    for _ in range(15):
        status=remote('status')
        if status.get('active') and status.get('connected') and status.get('running'):
            (STATE/'hosted-handoff.json').write_text(json.dumps({'host':target['host'],'status':'connected','at':time.time()}))
            print('XMR20 is connected on the server. You can close this Terminal and your Mac. Send /start in Telegram to see your wallet address.')
            print('Registration: '+('owner only; public Turnkey policies still required' if status.get('privateOwnerOnly') else 'open'))
            return
        time.sleep(2)
    print('Encrypted connection imported, but live polling is not confirmed. Do not start a second local bot. Run this launcher again to check.')
if __name__=='__main__':
    os.umask(0o077)
    try:main()
    except (Exception,KeyboardInterrupt):print('Handoff did not confirm success. Check the existing password, stop the local bot and retry. Saved encrypted state is preserved. No secret details logged.')
    try:input('Press Enter to close.')
    except (EOFError,KeyboardInterrupt):pass
