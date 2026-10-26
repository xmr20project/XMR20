//! xmr20-params-ceremony — multi-party Groth16 parameter setup for the XMR20 private-token circuits.
//!
//! WHAT THIS IS: the contribution / transition / verification / finalisation workflow that a real
//! ceremony would run, built on Penumbra's audited `penumbra-sdk-proof-setup` phase-1 (powers of tau
//! with α, β) and phase-2 (circuit-specific δ) protocol, applied to OUR circuits:
//!   normal   = XM3 private transfer: 3 Penumbra SpendCircuit + 2 OutputCircuit in one Groth16 circuit
//!   boundary = XB3 boundary record: 3 SpendCircuit + 1 OutputCircuit with public amount/asset
//! Each contribution multiplies the running elements by fresh secrets and proves knowledge of them
//! (discrete-log linking proofs). The final parameters are secure if at least ONE contributor in each
//! phase destroyed their secret. Every artifact is bound to the exact R1CS of the circuit (digest of
//! the constraint matrices), the degree, the Monero chain genesis and the protocol record shapes.
//!
//! WHAT THIS IS NOT: a production ceremony. Processes on one machine are not independent
//! participants; a rehearsal output is as disposable as the single-party setup it replaces.
//! The attestation says so in its first line and `finalize` refuses to write any other label.
//!
//! Commands (all offline):
//!   init <dir> --chain <genesis hex> [--label L]      compute both circuits' R1CS, degrees, digests; write ceremony.json
//!   contribute <dir> <circuit> <phase1|phase2> --participant <name> [--entropy <text>]
//!   transition <dir> <circuit>                        verify the phase-1 log, derive the phase-2 start (circuit-specific)
//!   finalize <dir> --out <params dir>                 verify both logs, combine -> normal/boundary.public-pk, parameters.json,
//!                                                     issuer.secret.json (fresh, 0600), attestation.json
//!   verify <dir> <params dir>                          independent re-verification from files: recompute R1CS, replay both
//!                                                     logs, recombine, compare bytes with the parameter files
use anyhow::{anyhow, bail, ensure, Context, Result};
use ark_groth16::ProvingKey;
use ark_relations::r1cs::{ConstraintMatrices, ConstraintSynthesizer, ConstraintSystem, OptimizationGoal, SynthesisMode};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Compress, Validate};
use decaf377::{Bls12_377, Fq};
use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};
use penumbra_sdk_proof_setup::single::{
    self as setup, circuit_degree,
    log::{ContributionHash, ContributionLog, Hashable, Phase},
    ExtraTransitionInformation, Phase1CRSElements, Phase1Contribution, Phase1RawContribution, Phase2CRSElements,
    Phase2Contribution, Phase2RawContribution,
};
use penumbra_sdk_shielded_pool::Note;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::Instant,
};
use xmr20_integration_lab::{boundary, native, Config};
use xmr20_multi_input_lab as xm3;

const FORMAT: &str = "XMR20-CEREMONY-REHEARSAL-1";
const LABEL: &str = "REHEARSAL — DISPOSABLE PARAMETERS — NOT A PRODUCTION CEREMONY";
const WARNING: &str = "Contributions were made by processes on one machine. They are not independent participants. The output is a disposable test parameter set with the same trust status as a single-party setup. Never for real funds.";

// ------------------------------------------------------------------ circuits
struct CircuitDef {
    name: &'static str,
    description: &'static str,
    matrices: ConstraintMatrices<Fq>,
}
fn matrices<C: ConstraintSynthesizer<Fq>>(c: C) -> Result<ConstraintMatrices<Fq>> {
    // Exactly what ark-groth16's setup and Penumbra's generate_constraint_matrices do.
    let cs = ConstraintSystem::<Fq>::new_ref();
    cs.set_optimization_goal(OptimizationGoal::Constraints);
    cs.set_mode(SynthesisMode::Setup);
    c.generate_constraints(cs.clone())?;
    cs.finalize();
    cs.to_matrices().ok_or_else(|| anyhow!("constraint system produced no matrices"))
}
fn circuits() -> Result<Vec<CircuitDef>> {
    // Same instantiation as the lab's single-party `setup` (any satisfiable instance yields the same R1CS).
    let k = xm3::fresh_key();
    let n = Note::generate(&mut OsRng, &xm3::address(&k), xm3::value(xm3::test_asset(), 1000));
    let l = xm3::Ledger::new([0; 32], &[xm3::Payload::encrypt(&n)?])?;
    let p = xm3::prepare(&l, &k, &[n.clone()], &[(xm3::address(&k), n.value()), (xm3::address(&k), xm3::value(xm3::test_asset(), 0))])?;
    let normal = matrices(p.circuit)?;
    let p = boundary::prepare_credit(&l, &k, &xm3::address(&k), xm3::test_asset(), 1000, boundary::KIND_DEPOSIT, [1; 32])?;
    let bound = matrices(p.circuit)?;
    Ok(vec![
        CircuitDef { name: "normal", description: "XM3 private transfer: 3 Penumbra spends, 2 outputs (Groth16, BLS12-377)", matrices: normal },
        CircuitDef { name: "boundary", description: "XB3 boundary record: 3 spends, 1 output, public amount+asset (Groth16, BLS12-377)", matrices: bound },
    ])
}
fn r1cs_digest(m: &ConstraintMatrices<Fq>) -> Result<String> {
    let mut b = b"XMR20-CIRCUIT-R1CS-v1\0".to_vec();
    for n in [m.num_instance_variables, m.num_witness_variables, m.num_constraints] {
        b.extend((n as u64).to_le_bytes());
    }
    for mat in [&m.a, &m.b, &m.c] {
        b.extend((mat.len() as u64).to_le_bytes());
        for row in mat {
            b.extend((row.len() as u64).to_le_bytes());
            for (coeff, idx) in row {
                coeff.serialize_compressed(&mut b)?;
                b.extend((*idx as u64).to_le_bytes());
            }
        }
    }
    Ok(hex::encode(xm3::hash(&b)))
}

// ------------------------------------------------------------------ phases for the contribution log
struct P1;
impl Phase for P1 {
    type CRSElements = Phase1CRSElements;
    type RawContribution = Phase1RawContribution;
    type Contribution = Phase1Contribution;
    fn parent_hash(c: &Self::RawContribution) -> ContributionHash { c.parent }
    fn elements(c: &Self::Contribution) -> &Self::CRSElements { &c.new_elements }
    fn validate(_root: &Self::CRSElements, c: &Self::RawContribution) -> Option<Self::Contribution> { c.validate() }
    fn is_linked_to(c: &Self::Contribution, e: &Self::CRSElements) -> bool { c.is_linked_to(e) }
}
struct P2;
impl Phase for P2 {
    type CRSElements = Phase2CRSElements;
    type RawContribution = Phase2RawContribution;
    type Contribution = Phase2Contribution;
    fn parent_hash(c: &Self::RawContribution) -> ContributionHash { c.parent }
    fn elements(c: &Self::Contribution) -> &Self::CRSElements { &c.new_elements }
    fn validate(root: &Self::CRSElements, c: &Self::RawContribution) -> Option<Self::Contribution> { c.to_owned().validate(&mut OsRng, root) }
    fn is_linked_to(c: &Self::Contribution, e: &Self::CRSElements) -> bool { c.is_linked_to(e) }
}

// ------------------------------------------------------------------ ceremony state (ceremony.json)
#[derive(Serialize, Deserialize, Clone)]
struct ContribEntry { index: usize, participant: String, at: String, parent: String, hash: String, file: String, bytes: u64, sha256: String, seconds: f64, entropy_note: String, independence: String }
#[derive(Serialize, Deserialize, Clone)]
struct TransitionEntry { at: String, phase1_last: String, phase2_root: String, extra_file: String, extra_sha256: String, extra_bytes: u64, seconds: f64 }
#[derive(Serialize, Deserialize, Clone)]
struct FinalEntry { at: String, phase2_last: String, pk_file: String, pk_bytes: u64, pk_sha256: String, vk_hex: String, seconds: f64 }
#[derive(Serialize, Deserialize, Clone)]
struct CircuitEntry {
    name: String, description: String, degree: usize, num_constraints: usize, num_instance_variables: usize, num_witness_variables: usize,
    r1cs_digest: String, phase1_root: String, phase1: Vec<ContribEntry>, transition: Option<TransitionEntry>, phase2: Vec<ContribEntry>, finalised: Option<FinalEntry>,
}
#[derive(Serialize, Deserialize, Clone)]
struct Ceremony {
    format: String, label: String, warning: String, chain: String, created_at: String, tool: String, setup_crate: String,
    protocol: serde_json::Value, circuits: Vec<CircuitEntry>,
}
fn now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    let secs = d.as_secs() as i64;
    // minimal ISO-8601 UTC without a chrono dependency
    let days = secs.div_euclid(86400); let rem = secs.rem_euclid(86400);
    let (y, m, dd) = civil_from_days(days);
    format!("{y:04}-{m:02}-{dd:02}T{:02}:{:02}:{:02}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468; let era = z.div_euclid(146097); let doe = z.rem_euclid(146097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}
fn sha256_file(p: &Path) -> Result<(String, u64)> {
    let b = fs::read(p)?;
    Ok((hex::encode(xm3::hash(&b)), b.len() as u64))
}
fn write_bin<T: CanonicalSerialize>(p: &Path, t: &T) -> Result<()> {
    let mut f = std::io::BufWriter::new(fs::File::create(p)?);
    t.serialize_with_mode(&mut f, Compress::No)?;
    f.flush()?;
    Ok(())
}
fn read_bin<T: CanonicalDeserialize>(p: &Path) -> Result<T> {
    let b = fs::read(p).with_context(|| format!("reading {}", p.display()))?;
    Ok(T::deserialize_with_mode(b.as_slice(), Compress::No, Validate::Yes)?)
}
fn load(dir: &Path) -> Result<Ceremony> {
    let c: Ceremony = serde_json::from_slice(&fs::read(dir.join("ceremony.json")).context("ceremony.json")?)?;
    ensure!(c.format == FORMAT, "ceremony.json format {} is not {FORMAT}", c.format);
    Ok(c)
}
fn save(dir: &Path, c: &Ceremony) -> Result<()> {
    let tmp = dir.join("ceremony.json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(c)?)?;
    fs::rename(tmp, dir.join("ceremony.json"))?;
    Ok(())
}
fn hash_hex(h: &ContributionHash) -> String { hex::encode(h.0) }
fn circuit_entry<'a>(c: &'a mut Ceremony, name: &str) -> Result<&'a mut CircuitEntry> {
    c.circuits.iter_mut().find(|e| e.name == name).ok_or_else(|| anyhow!("unknown circuit {name}"))
}
fn def<'a>(defs: &'a [CircuitDef], name: &str) -> Result<&'a CircuitDef> {
    defs.iter().find(|d| d.name == name).ok_or_else(|| anyhow!("unknown circuit {name}"))
}

// ------------------------------------------------------------------ log replay
fn phase1_last(dir: &Path, e: &CircuitEntry) -> Result<(Phase1CRSElements, Option<Phase1Contribution>)> {
    let root = Phase1CRSElements::root(e.degree);
    ensure!(hash_hex(&root.hash()) == e.phase1_root, "phase-1 root hash differs from ceremony.json (degree or protocol changed)");
    let mut raws = Vec::new();
    for c in &e.phase1 { raws.push(read_bin::<Phase1RawContribution>(&dir.join(&c.file))?); }
    let n = raws.len();
    let last = ContributionLog::<P1>::new(raws).last_good_contribution(&root, None);
    if n > 0 { ensure!(last.is_some(), "phase-1 log: no contribution verifies against the root"); }
    Ok((root, last))
}
fn phase2_last(dir: &Path, e: &CircuitEntry, d: &CircuitDef) -> Result<(Phase2CRSElements, ExtraTransitionInformation, Option<Phase2Contribution>)> {
    let t = e.transition.as_ref().ok_or_else(|| anyhow!("circuit {} has no transition yet", e.name))?;
    let extra: ExtraTransitionInformation = read_bin(&dir.join(&t.extra_file))?;
    let (_root1, last1) = phase1_last(dir, e)?;
    let last1 = last1.ok_or_else(|| anyhow!("{}: phase 1 has no verified contribution", e.name))?;
    ensure!(t.phase1_last == hash_hex(&last1.hash()), "{}: the transition was derived from a different phase-1 result than the verified log yields", e.name);
    // The phase-2 root is cached (root.bin) and checked against the recorded hash; `finalize`/`verify` additionally recompute the whole
    // transition from the verified phase-1 result (full_recompute) so a tampered cache cannot pass.
    let root_file = dir.join(format!("{}/phase2/root.bin", e.name));
    let root: Phase2CRSElements = if root_file.exists() {
        let r: Phase2CRSElements = read_bin(&root_file)?;
        ensure!(hash_hex(&r.hash()) == t.phase2_root, "phase-2 root cache differs from ceremony.json");
        r
    } else {
        let (extra_again, r) = setup::transition(&last1.new_elements, &d.matrices)?;
        ensure!(hash_hex(&r.hash()) == t.phase2_root, "phase-2 root recomputed from the verified phase-1 result differs from ceremony.json");
        let mut a = Vec::new(); extra.serialize_with_mode(&mut a, Compress::No)?;
        let mut b = Vec::new(); extra_again.serialize_with_mode(&mut b, Compress::No)?;
        ensure!(a == b, "{}: stored transition information differs from the recomputed one", e.name);
        write_bin(&root_file, &r)?;
        r
    };
    let mut raws = Vec::new();
    for c in &e.phase2 { raws.push(read_bin::<Phase2RawContribution>(&dir.join(&c.file))?); }
    let n = raws.len();
    let last = ContributionLog::<P2>::new(raws).last_good_contribution(&root, None);
    if n > 0 { ensure!(last.is_some(), "phase-2 log: no contribution verifies against the root"); }
    Ok((root, extra, last))
}
fn every_contribution_links<P: Phase>(root: &P::CRSElements, raws: Vec<P::RawContribution>) -> Result<usize> {
    // Stricter than last_good_contribution: EVERY recorded contribution must validate and link to its predecessor.
    let mut prev_hash = root.hash();
    let mut count = 0usize;
    let mut prev_elems: Option<P::Contribution> = None;
    for raw in raws {
        ensure!(P::parent_hash(&raw) == prev_hash, "contribution {} names a parent that is not the previous contribution", count + 1);
        let c = P::validate(root, &raw).ok_or_else(|| anyhow!("contribution {} failed internal validation (tampered or malformed)", count + 1))?;
        let linked = match &prev_elems { None => P::is_linked_to(&c, root), Some(p) => P::is_linked_to(&c, P::elements(p)) };
        ensure!(linked, "contribution {} is not linked to its predecessor (linking proof fails)", count + 1);
        prev_hash = c.hash();
        prev_elems = Some(c);
        count += 1;
    }
    Ok(count)
}

// ------------------------------------------------------------------ commands
fn cmd_init(dir: &Path, chain: &str, label: Option<&str>) -> Result<()> {
    ensure!(!dir.exists(), "{} exists", dir.display());
    ensure!(hex::decode(chain)?.len() == 32, "--chain must be the 32-byte Monero genesis hash (hex)");
    if let Some(l) = label { ensure!(l.contains("REHEARSAL") || l.contains("DISPOSABLE"), "the label must say REHEARSAL or DISPOSABLE: this tool never produces production parameters"); }
    fs::create_dir_all(dir)?;
    let t = Instant::now();
    let defs = circuits()?;
    let mut entries = Vec::new();
    for d in &defs {
        let degree = circuit_degree(&d.matrices)?;
        let root = Phase1CRSElements::root(degree);
        fs::create_dir_all(dir.join(d.name).join("phase1"))?;
        fs::create_dir_all(dir.join(d.name).join("phase2"))?;
        entries.push(CircuitEntry {
            name: d.name.into(), description: d.description.into(), degree, num_constraints: d.matrices.num_constraints,
            num_instance_variables: d.matrices.num_instance_variables, num_witness_variables: d.matrices.num_witness_variables,
            r1cs_digest: r1cs_digest(&d.matrices)?, phase1_root: hash_hex(&root.hash()), phase1: vec![], transition: None, phase2: vec![], finalised: None,
        });
    }
    let c = Ceremony {
        format: FORMAT.into(), label: label.unwrap_or(LABEL).into(), warning: WARNING.into(), chain: chain.into(), created_at: now(),
        tool: format!("xmr20-params-ceremony {}", env!("CARGO_PKG_VERSION")),
        setup_crate: "penumbra-sdk-proof-setup 2.1.1 (vendored single-circuit subset: `all` module removed, storage derives added; no cryptographic change)".into(),
        protocol: serde_json::json!({"scheme":"XMR20-TKD1","domainLabel":xmr20_integration_lab::chain::DOMAIN_LABEL,"records":{"transfer":{"magic":"XM3","bytes":996,"inputs":3,"outputs":2},"boundary":{"magic":"XB3","bytes":925,"inputs":3,"outputs":1}}}),
        circuits: entries,
    };
    save(dir, &c)?;
    println!("{}", serde_json::json!({"ok":true,"dir":dir,"seconds":t.elapsed().as_secs_f64(),"circuits":c.circuits.iter().map(|e|serde_json::json!({"name":e.name,"degree":e.degree,"constraints":e.num_constraints,"instance":e.num_instance_variables,"r1cs":e.r1cs_digest})).collect::<Vec<_>>()}));
    Ok(())
}
fn cmd_contribute(dir: &Path, name: &str, phase: &str, participant: &str, entropy: Option<&str>) -> Result<()> {
    ensure!(!participant.is_empty() && participant.len() <= 64 && participant.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'), "participant: [A-Za-z0-9_-]{{1,64}}");
    let mut c = load(dir)?;
    let t = Instant::now();
    // Entropy from the participant is MIXED with the OS RNG (never used alone); only a note about it is recorded.
    let entropy_note = match entropy { Some(e) => format!("participant supplied {} bytes of extra entropy (mixed into the RNG, not recorded)", e.len()), None => "OS RNG only".into() };
    let mut rng = MixedRng::new(entropy.map(|e| e.as_bytes().to_vec()));
    let (file, hash, parent) = {
        let e = circuit_entry(&mut c, name)?;
        match phase {
            "phase1" => {
                ensure!(e.transition.is_none(), "phase 1 of {name} is closed (transition done)");
                let (root, last) = phase1_last(dir, e)?;
                let (parent_hash, parent_elems) = match &last { Some(l) => (l.hash(), &l.new_elements), None => (root.hash(), &root) };
                let contribution = Phase1Contribution::make(&mut rng, parent_hash, parent_elems);
                let raw: Phase1RawContribution = contribution.clone().into();
                let file = format!("{}/phase1/{:03}-{}.bin", name, e.phase1.len() + 1, participant);
                write_bin(&dir.join(&file), &raw)?;
                (file, contribution.hash(), parent_hash)
            }
            "phase2" => {
                ensure!(e.finalised.is_none(), "phase 2 of {name} is closed (finalised)");
                let defs = circuits()?;
                let (root, _extra, last) = phase2_last(dir, e, def(&defs, name)?)?;
                let (parent_hash, parent_elems) = match &last { Some(l) => (l.hash(), &l.new_elements), None => (root.hash(), &root) };
                let contribution = Phase2Contribution::make(&mut rng, parent_hash, parent_elems);
                let raw: Phase2RawContribution = contribution.clone().into();
                let file = format!("{}/phase2/{:03}-{}.bin", name, e.phase2.len() + 1, participant);
                write_bin(&dir.join(&file), &raw)?;
                (file, contribution.hash(), parent_hash)
            }
            _ => bail!("phase must be phase1 or phase2"),
        }
    };
    let (sha, bytes) = sha256_file(&dir.join(&file))?;
    let entry = ContribEntry {
        index: 0, participant: participant.into(), at: now(), parent: hash_hex(&parent), hash: hash_hex(&hash), file: file.clone(), bytes, sha256: sha,
        seconds: t.elapsed().as_secs_f64(), entropy_note, independence: "process on the same machine as the coordinator; NOT an independent participant".into(),
    };
    let e = circuit_entry(&mut c, name)?;
    let list = if phase == "phase1" { &mut e.phase1 } else { &mut e.phase2 };
    let mut entry = entry; entry.index = list.len() + 1; list.push(entry.clone());
    save(dir, &c)?;
    println!("{}", serde_json::json!({"ok":true,"circuit":name,"phase":phase,"index":entry.index,"participant":participant,"hash":entry.hash,"parent":entry.parent,"file":entry.file,"bytes":entry.bytes,"seconds":entry.seconds}));
    Ok(())
}
fn cmd_transition(dir: &Path, name: &str) -> Result<()> {
    let mut c = load(dir)?;
    let defs = circuits()?;
    let d = def(&defs, name)?;
    let t = Instant::now();
    let e = circuit_entry(&mut c, name)?;
    ensure!(e.transition.is_none(), "transition already done");
    ensure!(r1cs_digest(&d.matrices)? == e.r1cs_digest, "the circuit's R1CS changed since init (source or dependency drift): refusing");
    let (root, last) = phase1_last(dir, e)?;
    let last = last.ok_or_else(|| anyhow!("phase 1 has no verified contribution; refusing to transition from the root (that would be a trivially insecure setup)"))?;
    // every recorded phase-1 contribution must link, not just the last good one
    let raws: Result<Vec<_>> = e.phase1.iter().map(|x| read_bin::<Phase1RawContribution>(&dir.join(&x.file))).collect();
    let n = every_contribution_links::<P1>(&root, raws?)?;
    let (extra, phase2_root) = setup::transition(&last.new_elements, &d.matrices)?;
    let extra_file = format!("{name}/extra.bin");
    write_bin(&dir.join(&extra_file), &extra)?;
    write_bin(&dir.join(format!("{name}/phase2/root.bin")), &phase2_root)?;
    let (sha, bytes) = sha256_file(&dir.join(&extra_file))?;
    e.transition = Some(TransitionEntry { at: now(), phase1_last: hash_hex(&last.hash()), phase2_root: hash_hex(&phase2_root.hash()), extra_file, extra_sha256: sha, extra_bytes: bytes, seconds: t.elapsed().as_secs_f64() });
    save(dir, &c)?;
    println!("{}", serde_json::json!({"ok":true,"circuit":name,"phase1Contributions":n,"phase2Root":hash_hex(&phase2_root.hash()),"seconds":t.elapsed().as_secs_f64()}));
    Ok(())
}
#[derive(Serialize)]
struct IssuerSecret { pool_seed: [u8; 32], signing: [u8; 32], native_spend: [u8; 32], native_view: [u8; 32] }
// full = recompute the transition from the verified phase-1 result (minutes per circuit) in addition to replaying both logs;
// `finalize` and `verify --quick` use the hash-checked cached root, `verify` (default) recomputes.
fn combine_circuit(dir: &Path, d: &CircuitDef, e: &CircuitEntry, full: bool) -> Result<(ProvingKey<Bls12_377>, Phase1Contribution, Phase2Contribution)> {
    ensure!(r1cs_digest(&d.matrices)? == e.r1cs_digest, "{}: R1CS digest differs from ceremony.json", d.name);
    let (root1, last1) = phase1_last(dir, e)?;
    let last1 = last1.ok_or_else(|| anyhow!("{}: no phase-1 contribution", d.name))?;
    let raws1: Result<Vec<_>> = e.phase1.iter().map(|x| read_bin::<Phase1RawContribution>(&dir.join(&x.file))).collect();
    every_contribution_links::<P1>(&root1, raws1?)?;
    let (root2, extra, last2) = phase2_last(dir, e, d)?;
    let last2 = last2.ok_or_else(|| anyhow!("{}: no phase-2 contribution", d.name))?;
    if full {
        // Full recomputation (independent of the root cache): the transition from the verified phase-1 result must yield the same root and extra.
        let (extra_again, root_again) = setup::transition(&last1.new_elements, &d.matrices)?;
        ensure!(root_again.hash() == root2.hash(), "{}: recomputed phase-2 root differs from the cached/recorded one", d.name);
        let mut a = Vec::new(); extra.serialize_with_mode(&mut a, Compress::No)?;
        let mut b = Vec::new(); extra_again.serialize_with_mode(&mut b, Compress::No)?;
        ensure!(a == b, "{}: recomputed transition information differs from the stored one", d.name);
    }
    let raws2: Result<Vec<_>> = e.phase2.iter().map(|x| read_bin::<Phase2RawContribution>(&dir.join(&x.file))).collect();
    every_contribution_links::<P2>(&root2, raws2?)?;
    let pk = setup::combine(&d.matrices, &last1.new_elements, &last2.new_elements, &extra);
    Ok((pk, last1, last2))
}
fn cmd_finalize(dir: &Path, out: &Path) -> Result<()> {
    let mut c = load(dir)?;
    ensure!(!out.exists(), "{} exists", out.display());
    let defs = circuits()?;
    let t = Instant::now();
    fs::create_dir_all(out)?;
    let mut vks = std::collections::BTreeMap::new();
    let mut finals = Vec::new();
    for e in c.circuits.clone() {
        let d = def(&defs, &e.name)?;
        let t1 = Instant::now();
        let (pk, _l1, l2) = combine_circuit(dir, d, &e, false)?;
        let file = out.join(format!("{}.public-pk", e.name));
        pk.serialize_uncompressed(std::io::BufWriter::new(fs::File::create(&file)?))?;
        let mut vk = Vec::new(); pk.vk.serialize_compressed(&mut vk)?;
        let (sha, bytes) = sha256_file(&file)?;
        vks.insert(e.name.clone(), hex::encode(&vk));
        finals.push((e.name.clone(), FinalEntry { at: now(), phase2_last: hash_hex(&l2.hash()), pk_file: file.file_name().unwrap().to_string_lossy().into(), pk_bytes: bytes, pk_sha256: sha, vk_hex: hex::encode(&vk), seconds: t1.elapsed().as_secs_f64() }));
    }
    // parameters.json in the lab's format: the ledger domain binds chain, both verifying keys and the issuer key.
    let issuer_key = xm3::fresh_key();
    let issuer_sign = SigningKey::<SpendAuth>::new(OsRng);
    let issuer_native = native::Wallet::new();
    let (native_spend, native_view) = issuer_native.secrets();
    let mut config = Config { chain: c.chain.clone(), domain: String::new(), normal_vk: vks["normal"].clone(), boundary_vk: vks["boundary"].clone(), issuer_vk: hex::encode(VerificationKey::from(&issuer_sign).to_bytes()) };
    config.domain = hex::encode(config.computed_domain()?);
    fs::write(out.join("parameters.json"), serde_json::to_vec_pretty(&config)?)?;
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(out.join("issuer.secret.json"))?;
        f.write_all(&serde_json::to_vec(&IssuerSecret { pool_seed: issuer_key.to_bytes().0, signing: issuer_sign.to_bytes(), native_spend, native_view })?)?;
    }
    for (name, f) in &finals { circuit_entry(&mut c, name)?.finalised = Some(f.clone()); }
    save(dir, &c)?;
    let (pj_sha, pj_bytes) = sha256_file(&out.join("parameters.json"))?;
    let attestation = serde_json::json!({
        "format": "XMR20-CEREMONY-ATTESTATION-1",
        "status": "REHEARSAL — DISPOSABLE PARAMETERS — NOT A PRODUCTION CEREMONY",
        "warning": WARNING,
        "independentParticipants": 0,
        "ceremony": {"dir": dir, "ceremonyJsonSha256": sha256_file(&dir.join("ceremony.json"))?.0, "label": c.label, "chain": c.chain, "protocol": c.protocol, "tool": c.tool, "setupCrate": c.setup_crate},
        "circuits": c.circuits.iter().map(|e| serde_json::json!({
            "name": e.name, "description": e.description, "degree": e.degree, "constraints": e.num_constraints, "instanceVariables": e.num_instance_variables, "witnessVariables": e.num_witness_variables,
            "r1csDigest": e.r1cs_digest, "phase1": {"root": e.phase1_root, "contributions": e.phase1.iter().map(|x| serde_json::json!({"index":x.index,"participant":x.participant,"hash":x.hash,"parent":x.parent,"file":x.file,"sha256":x.sha256,"at":x.at,"independence":x.independence})).collect::<Vec<_>>()},
            "transition": e.transition, "phase2": {"root": e.transition.as_ref().map(|t| t.phase2_root.clone()), "contributions": e.phase2.iter().map(|x| serde_json::json!({"index":x.index,"participant":x.participant,"hash":x.hash,"parent":x.parent,"file":x.file,"sha256":x.sha256,"at":x.at,"independence":x.independence})).collect::<Vec<_>>()},
            "output": e.finalised,
        })).collect::<Vec<_>>(),
        "parametersJson": {"sha256": pj_sha, "bytes": pj_bytes, "domain": config.domain, "issuerVk": config.issuer_vk, "issuerSecretNote": "issuer.secret.json generated fresh here (0600); it is the lab issuer's key, not part of the ceremony"},
        "generatedAt": now(),
    });
    fs::write(out.join("attestation.json"), serde_json::to_vec_pretty(&attestation)?)?;
    println!("{}", serde_json::json!({"ok":true,"out":out,"seconds":t.elapsed().as_secs_f64(),"domain":config.domain,"files":finals.iter().map(|(n,f)|serde_json::json!({"circuit":n,"pk":f.pk_file,"bytes":f.pk_bytes,"sha256":f.pk_sha256})).collect::<Vec<_>>()}));
    Ok(())
}
fn cmd_verify(dir: &Path, params: &Path, quick: bool) -> Result<()> {
    let c = load(dir)?;
    let defs = circuits()?;
    let t = Instant::now();
    let raw = fs::read(params.join("parameters.json")).context("parameters.json")?;
    let config: Config = serde_json::from_slice(&raw)?;
    ensure!(config.chain == c.chain, "parameters.json chain {} is not the ceremony's {}", config.chain, c.chain);
    config.validate()?;
    let attestation: serde_json::Value = serde_json::from_slice(&fs::read(params.join("attestation.json")).context("attestation.json")?)?;
    ensure!(attestation["ceremony"]["ceremonyJsonSha256"] == serde_json::json!(sha256_file(&dir.join("ceremony.json"))?.0), "attestation.json was made for a different ceremony.json");
    let mut report = Vec::new();
    for e in &c.circuits {
        let d = def(&defs, &e.name)?;
        let digest = r1cs_digest(&d.matrices)?;
        ensure!(digest == e.r1cs_digest, "{}: the circuit compiled from the current source has R1CS digest {}…, ceremony.json says {}…", e.name, &digest[..16], &e.r1cs_digest[..16]);
        let (pk, l1, l2) = combine_circuit(dir, d, e, !quick)?;
        let mut bytes = Vec::new(); pk.serialize_uncompressed(&mut bytes)?;
        let file = params.join(format!("{}.public-pk", e.name));
        let on_disk = fs::read(&file).with_context(|| format!("{}", file.display()))?;
        ensure!(on_disk == bytes, "{}: {} differs from the key recombined from the verified logs (substituted, truncated or from another setup)", e.name, file.display());
        let mut vk = Vec::new(); pk.vk.serialize_compressed(&mut vk)?;
        let expected_vk = if e.name == "normal" { &config.normal_vk } else { &config.boundary_vk };
        ensure!(hex::encode(&vk) == *expected_vk, "{}: parameters.json verifying key is not the one recombined from the logs", e.name);
        let f = e.finalised.as_ref().ok_or_else(|| anyhow!("{}: not finalised", e.name))?;
        ensure!(f.pk_sha256 == hex::encode(xm3::hash(&on_disk)), "{}: pk sha256 differs from the recorded finalisation", e.name);
        ensure!(f.phase2_last == hash_hex(&l2.hash()), "{}: finalisation names a different last phase-2 contribution", e.name);
        report.push(serde_json::json!({"circuit":e.name,"r1cs":digest,"degree":e.degree,"phase1Contributions":e.phase1.len(),"phase1Last":hash_hex(&l1.hash()),"phase2Contributions":e.phase2.len(),"phase2Last":hash_hex(&l2.hash()),"pkBytes":on_disk.len(),"pkSha256":f.pk_sha256,"vkMatches":true}));
    }
    println!("{}", serde_json::json!({"ok":true,"mode":if quick {"quick: logs replayed, keys recombined from the hash-checked cached transition"} else {"full: logs replayed, transition recomputed, keys recombined"},"verified":report,"seconds":t.elapsed().as_secs_f64(),"status":c.label,"independentParticipants":0}));
    Ok(())
}

// RNG that mixes optional participant entropy into the OS RNG (XOR of OS randomness with a hash stream of the entropy).
struct MixedRng { extra: Option<Vec<u8>>, counter: u64 }
impl MixedRng { fn new(extra: Option<Vec<u8>>) -> Self { Self { extra, counter: 0 } } }
impl rand_core::RngCore for MixedRng {
    fn next_u32(&mut self) -> u32 { let mut b = [0u8; 4]; self.fill_bytes(&mut b); u32::from_le_bytes(b) }
    fn next_u64(&mut self) -> u64 { let mut b = [0u8; 8]; self.fill_bytes(&mut b); u64::from_le_bytes(b) }
    fn fill_bytes(&mut self, dest: &mut [u8]) {
        OsRng.fill_bytes(dest);
        if let Some(e) = &self.extra {
            let mut i = 0;
            while i < dest.len() {
                let mut m = e.clone(); m.extend(self.counter.to_le_bytes()); self.counter += 1;
                let h = xm3::hash(&m);
                for (d, x) in dest[i..].iter_mut().zip(h.iter()) { *d ^= x; }
                i += h.len();
            }
        }
    }
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), rand_core::Error> { self.fill_bytes(dest); Ok(()) }
}
impl rand_core::CryptoRng for MixedRng {}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let flag = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).map(|s| s.as_str());
    match args.get(1).map(|s| s.as_str()) {
        Some("init") => cmd_init(Path::new(args.get(2).context("dir")?), flag("--chain").context("--chain <genesis hex>")?, flag("--label")),
        Some("contribute") => cmd_contribute(Path::new(args.get(2).context("dir")?), args.get(3).context("circuit")?, args.get(4).context("phase1|phase2")?, flag("--participant").context("--participant <name>")?, flag("--entropy")),
        Some("transition") => cmd_transition(Path::new(args.get(2).context("dir")?), args.get(3).context("circuit")?),
        Some("finalize") => cmd_finalize(Path::new(args.get(2).context("dir")?), &PathBuf::from(flag("--out").context("--out <params dir>")?)),
        Some("verify") => cmd_verify(Path::new(args.get(2).context("dir")?), Path::new(args.get(3).context("params dir")?), args.iter().any(|a| a == "--quick")),
        _ => bail!("usage: xmr20-params-ceremony init|contribute|transition|finalize|verify … (see source header)"),
    }
}
