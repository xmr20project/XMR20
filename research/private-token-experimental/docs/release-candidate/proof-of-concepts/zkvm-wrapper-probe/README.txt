ZKVM WRAPPER PROBE — PREPARED, NOT RUN (25 Oct 2026)

Purpose: measure RISC-V zkVM guest cycles for the Poseidon377 / decaf377 operations an XM3 record needs, and local STARK proving
time on this laptop, to replace the estimates in ../../PROOF-SYSTEM-ALTERNATIVES.txt 5.3 with measurements.

Status: the RISC Zero toolchain install (rzup binary from risc0-artifacts S3, then `rzup install`, under ~/.risc0, no shell-profile
change) was refused by the session's permission policy (external code). No toolchain was installed, nothing was built, no numbers
were produced. The vendor's installer script was downloaded for inspection only and has been deleted; it is not part of the candidate.

What it cannot measure anyway: the STARK-to-Groth16 wrapping step, which RISC Zero documents as x86-only (unsupported on Apple
silicon even via Docker). The decisive wallet-compatibility finding therefore rests on documentation, not on this probe.

To run later (owner decision): allow the install, then build a guest that (1) runs N poseidon377 permutations and M decaf377
scalar multiplications with the crates already in ~/.cargo (poseidon377 1.2.0, decaf377 0.10.1), (2) reports executor cycle counts
in dev mode, (3) times one composite proof with Metal. Keep the target directory inside this folder; expect 1-2 GB of toolchain.
