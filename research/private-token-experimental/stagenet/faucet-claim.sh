#!/bin/sh
# Request worthless STAGENET coins from the public cypherfaucet.com API (0.01 sXMR per address per hour; one claim per IP
# per hour), one address per invocation, appending the sanitized response (txid, amount, error) to a JSONL log.
# Usage: faucet-claim.sh <stagenet address> <log file>
# Nothing here touches mainnet, real funds or any wallet secret. tx_key (if returned) is dropped from the log.
ADDR="$1"; LOG="$2"
[ -n "$ADDR" ] && [ -n "$LOG" ] || { echo "usage: faucet-claim.sh <address> <log>" >&2; exit 2; }
RESP=$(curl -s -m 60 -H 'Content-Type: application/json' -A 'xmr20-stagenet-rehearsal/1 (research harness)' \
  -d "{\"network\":\"xmr-stagenet\",\"address\":\"$ADDR\"}" https://cypherfaucet.com/api/v1/claim)
printf '%s\n' "$RESP" | python3 -c '
import json,sys,time
raw=sys.stdin.read()
try: r=json.loads(raw)
except Exception: r={"ok":False,"error":"non_json","message":raw[:200]}
r.pop("tx_key",None)
r["address"]=sys.argv[1]; r["at"]=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()); r["network"]="xmr-stagenet"
print(json.dumps(r))' "$ADDR" | tee -a "$LOG"
