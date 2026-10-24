ISOLATED STAGENET NODE for the private-token rehearsal (research/privacy-stagenet-roles-20261023), 23 Oct 2026.
Binary: operations/native-market-20261016/local-chain/bin/monerod (Monero v0.18.5.3, sha256 28c233e0…6518; archive
7a083ed2…54ab verified against binaryFate's GPG-signed hashes.txt, fingerprint 81AC 591F E9C4 B65C 5806 AFC3 F0AF 4D46 2A0B DF92).
Network: STAGENET only (worthless test coins). Pruned blockchain. Data: ./data. Logs: ./logs. Pid: ./monerod.pid.
Ports: RPC 127.0.0.1:38091 (loopback only, unrestricted), P2P 127.0.0.1:38090 (outbound only, 0 inbound peers, no IGD, no ZMQ).
Storage plan (23 Oct 2026): 38 GB free before sync; public stagenet node reports database_size 16.1 GB at height 2,235,747;
pruned estimate 5-8 GB; reserve kept >= 25 GB. Nothing else was deleted or changed. No production service touched.
Stop: kill $(cat monerod.pid)  — only this process.
MINING (authorised by the owner on 24 Oct 2026): after the sync, this node mines STAGENET blocks with 6 CPU threads to the
rehearsal issuer address (57niMTvo…4FQM) to speed up the slow stagenet block pace. Blocks found by this node are recorded by
the harness (mining-status step) and are NOT independent third-party mining; relay evidence comes from a third-party public
stagenet node instead. Stop mining: curl -s http://127.0.0.1:38091/stop_mining -d '{}'. Log: logs/mining.log.
