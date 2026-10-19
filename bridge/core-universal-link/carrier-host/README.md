# Owned-node carrier transport

The identity-aware J3 carrier now prefers the operator's own Monero node for native wallet synchronization and publication. An independent public node remains required for checkpoint agreement and available for bounded reconnection and exact-byte relay fallback. This is server-side infrastructure; users do not need Docker or a local bridge process.

## Components

- `treasury.py`: bounded carrier broker, signed-envelope verification, durable input reservations, recovery guards and own-node transport.
- `host-broker.py`: existing deployment integration, with the own-node mode explicitly enabled. It consumes private configuration on the host without returning it.
- `container-node-relay.py`: creates a listener only on loopback inside the carrier container's network namespace, returns to the host namespace, and permanently drops root/groups/capabilities before forwarding to the existing private SSH tunnel. It bounds connections, buffers and lifetime, logs no request content, and exits when the container exits.
- `xmr20-carrier-own-node.service`: server startup and restart supervision for that connector. It opens no public listener.

The fixed local endpoint is `http://127.0.0.1:18082`; the host endpoint must already be an authenticated SSH tunnel to the owned daemon. Public fallback uses CA/hostname verification plus a verified certificate fingerprint. The native wallet remains configured with `trusted=false`. Legacy node identifiers and persisted policies are preserved.

## Verification

Run from the repository root with Python 3:

```sh
python3 -m unittest discover -s bridge/core-universal-link/carrier-host -p 'test_*.py'
```

All 83 tests passed. Tests use synthetic wallet responses and local disposable sockets, with no real wallet or mainnet transaction. Coverage includes ownership signatures, canonical envelopes, fee limits, durable recovery/input reservations, bounded reconnects, independent checkpoint disagreement, TLS rejection, fixed-loopback routing, binary forwarding and namespace rejection.

On 20 October 2026 (Europe/London), the live server selected the owned primary, synchronized successfully, and retained an active native-wallet connection through the private connector. The relay was unprivileged with zero effective capabilities, enabled at boot, and had no host/public listener. Readiness samples were 4.174 and 6.068 seconds. These samples do not establish instant cold startup or remove network confirmation delays.

## Deployment boundary

This directory publishes the narrowly changed server components, not a self-contained server distribution. The existing identity-capable native wallet, `mainnet_launch`, `launch_fee_policy`, `treasury_adapter`, private settings, supervised SSH tunnel, approved runtime journals and independently verified indexes remain separate deployment prerequisites. The host wrapper retains its deployment-specific paths for source provenance. Do not run it as local wallet setup or deploy it alone over an incompatible bridge.

No credentials, SSH identities, wallet files, approval/recovery journals or production configuration are included. Preserve exact amounts, the single token-fee deduction, both required signatures, fresh pre-signing verification, ten Monero confirmations, custody records and durable recovery. Do not replace the identity-aware broker with older legacy carrier source. Retain exact previous source for rollback and restore a verified daemon connection before disabling the connector; never delete receipts or create replacement approvals as part of rollback.
