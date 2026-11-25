#!/bin/sh
# Start the isolated stagenet node (pruned, loopback RPC, outbound-only p2p). Only this process is ever stopped by its pidfile.
N=<workspace>/operations/stagenet-node-20261023
exec <workspace>/operations/native-market-20261016/local-chain/bin/monerod --stagenet \
  --data-dir "$N/data" --prune-blockchain --non-interactive \
  --rpc-bind-ip 127.0.0.1 --rpc-bind-port 38091 --p2p-bind-ip 127.0.0.1 --p2p-bind-port 38090 \
  --no-igd --no-zmq --in-peers 0 --out-peers 24 --db-sync-mode fastest:async:250000000bytes \
  --log-file "$N/logs/monerod.log" --log-level 0 --max-log-file-size 50000000 --max-log-files 3 \
  --pidfile "$N/monerod.pid"
