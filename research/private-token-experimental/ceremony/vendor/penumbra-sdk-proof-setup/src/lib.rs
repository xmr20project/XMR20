// VENDORED COPY of penumbra-sdk-proof-setup 2.1.1 for the XMR20 parameter-ceremony REHEARSAL (research/privacy-release-candidate-20261025/ceremony).
// Changes from the published crate, all mechanical: (1) the `all` module (Penumbra's seven fixed circuits and its protobuf storage) is
// removed with its heavy dependencies; (2) `CanonicalSerialize`/`CanonicalDeserialize` derives are added to `ContributionHash` and to
// the two `RawContribution` types and the phase-2 `CRSElements` so contributions and the phase-2 root can be written to and read from files. No cryptographic code is modified.
mod parallel_utils;
pub mod single;
