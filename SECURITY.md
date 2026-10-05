# Security

This is a developer-preview wallet. Public source and passing tests are not a substitute for an independent security audit. The built-in bridge depends on the existing operator-attested XMR20 service.

## Reporting

Do not post private keys, recovery phrases, passwords, encrypted wallet backups, or user transaction data in GitHub issues. For a suspected vulnerability involving keys, signing or funds, arrange a private report with the repository owner before sharing reproduction details. This repository does not yet advertise a dedicated security contact or response-time commitment.

## Review boundaries

Review the source in `src/`, the workers in `extension/vendor/`, and the manifest permissions. Build with the committed lockfile using the README instructions. Unit tests generate disposable keys or use explicit test sentinels. Pricing fixtures contain public API data.

The full bridge backend and indexer are outside this repository. The service integration modules under `server-patch/` are reference modules used by tests; this repository does not deploy them. Browser profiles, wallet vaults, recovery material, deployment credentials and local transfer receipts are excluded.
