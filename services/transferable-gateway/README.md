# Hosted bridge gateway

The source matches the HTTPS gateway used by the website and the installable 0.1.22 bridge-testing wallet. It listens on loopback 8935 and forwards only the listed bridge actions and public Solana reads to loopback 8934. Run its six transport checks with `node --test services/transferable-gateway/server.test.mjs`.

The admitted origins are `https://xmr20.org` and the stable public-manifest extension identity `chrome-extension://jigbpnljnmbbkebaopbnnhmiafgnofla`. Keep the manifest key unchanged when updating an installed wallet. CORS restricts browser access; cryptographic signatures, exact transactions and chain proofs remain the authority for financial operations.

No deployment, service startup, wallet operation, signing or transaction runs during installation, build or tests. The source has no keys or credentials. Starting this gateway alone does not deploy an operator, program or native transaction publisher. The retained upgrade authority and verifier trust model are unchanged.
