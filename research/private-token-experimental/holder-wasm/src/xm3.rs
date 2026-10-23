//! UNREVIEWED OFFLINE EXPERIMENT. A new Groth16 circuit/setup, not a production key.
//! Three unchanged upstream SpendCircuits plus two unchanged OutputCircuits.
//! Shared randomized authorization; new compact note codec; requires independent review.
//! Native XMR inputs/key images do not appear in the token authorization schema.
use anyhow::{ensure, Context, Result};
use ark_ff::ToConstraintField;
use ark_groth16::{Groth16, PreparedVerifyingKey, Proof, ProvingKey, VerifyingKey};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystem, ConstraintSystemRef};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use decaf377::{Bls12_377, Fq, Fr};
use decaf377_rdsa::{Binding, Signature, SigningKey, SpendAuth, VerificationKey};
use penumbra_sdk_asset::{asset, balance::Commitment, Value};
use penumbra_sdk_keys::{
    keys::{SpendKey, SpendKeyBytes},
    Address, FullViewingKey,
};
use penumbra_sdk_proto::DomainType;
use penumbra_sdk_sct::Nullifier;
use penumbra_sdk_shielded_pool::output::{OutputProofPrivate, OutputProofPublic};
use penumbra_sdk_shielded_pool::{
    Note, OutputCircuit, OutputPlan, SpendCircuit, SpendPlan, SpendProofPrivate, SpendProofPublic,
};
use penumbra_sdk_tct::{Root, Tree, Witness};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub mod compact;
pub use compact::Payload;
pub const INPUTS: usize = 3;
pub const MAGIC: &[u8; 4] = b"XM3\xfe";
pub const WIRE_BYTES: usize = 996;
pub const PROOF_BYTES: usize = 192;
pub fn hash(b: &[u8]) -> [u8; 32] {
    Sha256::digest(b).into()
}
pub fn fresh_key() -> SpendKey {
    let mut b = [0; 32];
    OsRng.fill_bytes(&mut b);
    SpendKeyBytes(b).into()
}
pub fn address(k: &SpendKey) -> Address {
    k.full_viewing_key().payment_address(0u32.into()).0
}
pub fn test_asset() -> asset::Id {
    asset::REGISTRY
        .parse_denom("uxmr20-multi-input-offline")
        .unwrap()
        .id()
}
pub fn value(a: asset::Id, n: u64) -> Value {
    Value {
        asset_id: a,
        amount: n.into(),
    }
}

#[derive(Clone)]
pub struct Combined {
    pub spends: [SpendCircuit; INPUTS],
    pub outputs: [OutputCircuit; 2],
}
impl ConstraintSynthesizer<Fq> for Combined {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fq>) -> ark_relations::r1cs::Result<()> {
        for s in self.spends {
            s.generate_constraints(cs.clone())?;
        }
        for o in self.outputs {
            o.generate_constraints(cs.clone())?;
        }
        Ok(())
    }
}
pub fn satisfied(c: Combined) -> Result<bool> {
    let cs = ConstraintSystem::new_ref();
    c.generate_constraints(cs.clone())?;
    Ok(cs.is_satisfied()?)
}

#[derive(Clone)]
pub struct Output {
    pub cv: Commitment,
    pub payload: Payload,
}
#[derive(Clone)]
pub struct Input {
    pub cv: Commitment,
    pub nf: Nullifier,
}
#[derive(Clone)]
pub struct Record {
    pub anchor: Root,
    pub inputs: [Input; INPUTS],
    pub rk: VerificationKey<SpendAuth>,
    pub auth: Signature<SpendAuth>,
    pub outputs: [Output; 2],
    pub proof: [u8; PROOF_BYTES],
    pub binding: Signature<Binding>,
}
pub fn payload_bytes(p: &Payload) -> Vec<u8> {
    p.encode()
}
pub fn decode_payload(b: &[u8]) -> Result<Payload> {
    Payload::decode(b)
}
impl Record {
    fn public_body(&self) -> Vec<u8> {
        let mut b = MAGIC.to_vec();
        b.extend(Fq::from(self.anchor).to_bytes());
        for i in &self.inputs {
            b.extend(i.cv.to_bytes());
            b.extend(i.nf.0.to_bytes());
        }
        b.extend(self.rk.to_bytes());
        for o in &self.outputs {
            b.extend(o.cv.to_bytes());
            b.extend(o.payload.encode());
        }
        b
    }
    // Domain is pinned by protocol configuration and signed, not an attacker-
    // selected wire value. No shortening of cryptographic hashes or points.
    pub fn message(&self, domain: &[u8; 32]) -> [u8; 32] {
        let mut b = b"XMR20-MULTI-INPUT-LAB-AUTH-v1\0".to_vec();
        b.extend(domain);
        b.extend(self.public_body());
        hash(&b)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.public_body();
        b.extend(self.auth.to_bytes());
        b.extend(self.proof);
        b.extend(self.binding.to_bytes());
        assert_eq!(b.len(), WIRE_BYTES);
        b
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(
            b.len() == WIRE_BYTES && &b[..4] == MAGIC,
            "Fixed experimental record required"
        );
        let mut r = Reader { b, at: 4 };
        let mut root = vec![10, 32];
        root.extend(r.take(32)?);
        let anchor = Root::decode(root.as_slice())?;
        let mut inputs = vec![];
        for _ in 0..INPUTS {
            inputs.push(Input {
                cv: Commitment::try_from(r.take(32)?)?,
                nf: Nullifier::try_from(r.take(32)?)?,
            });
        }
        let rk = VerificationKey::try_from(r.take(32)?)?;
        let mut outputs = vec![];
        for _ in 0..2 {
            outputs.push(Output {
                cv: Commitment::try_from(r.take(32)?)?,
                payload: decode_payload(r.take(compact::PAYLOAD_BYTES)?)?,
            });
        }
        let record = Self {
            anchor,
            inputs: inputs
                .try_into()
                .map_err(|_| anyhow::anyhow!("Input count"))?,
            rk,
            outputs: outputs
                .try_into()
                .map_err(|_| anyhow::anyhow!("Output count"))?,
            auth: Signature::try_from(r.take(64)?)?,
            proof: r.take(PROOF_BYTES)?.try_into()?,
            binding: Signature::try_from(r.take(64)?)?,
        };
        ensure!(r.at == b.len() && record.encode() == b, "Canonical record");
        Ok(record)
    }
    pub fn public_inputs(&self) -> Result<Vec<Fq>> {
        let mut v = vec![];
        macro_rules! fields {
            ($x:expr) => {
                v.extend($x.to_field_elements().context("Public input encoding")?);
            };
        }
        for i in &self.inputs {
            fields!(Fq::from(self.anchor));
            fields!(i.cv.0);
            fields!(i.nf.0);
            fields!(decaf377::Encoding(self.rk.to_bytes())
                .vartime_decompress()
                .map_err(|_| anyhow::anyhow!("Invalid randomized key"))?);
        }
        for o in &self.outputs {
            fields!(o.payload.note_commitment.0);
            fields!(o.cv.0);
        }
        Ok(v)
    }
    pub fn verify_proof(&self, vk: &PreparedVerifyingKey<Bls12_377>) -> Result<()> {
        let p = Proof::<Bls12_377>::deserialize_compressed(self.proof.as_slice())?;
        ensure!(
            Groth16::<Bls12_377>::verify_with_processed_vk(vk, &self.public_inputs()?, &p)?,
            "Combined proof rejected"
        );
        Ok(())
    }
    pub fn verify_crypto(
        &self,
        vk: &PreparedVerifyingKey<Bls12_377>,
        domain: &[u8; 32],
    ) -> Result<()> {
        let msg = self.message(domain);
        self.rk.verify(&msg, &self.auth)?;
        let sum = self
            .inputs
            .iter()
            .fold(Commitment(decaf377::Element::IDENTITY), |s, i| s + i.cv);
        let sum = self.outputs.iter().fold(sum, |s, o| s + o.cv);
        VerificationKey::<Binding>::try_from(sum.to_bytes())?
            .verify(&msg, &self.binding)
            .context("Conservation rejected")?;
        self.verify_proof(vk)
    }
}
struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        ensure!(n <= self.b.len() - self.at, "Truncated record");
        let x = &self.b[self.at..self.at + n];
        self.at += n;
        Ok(x)
    }
}

pub struct Prepared {
    pub record: Record,
    pub circuit: Combined,
    pub randomizer: Fr,
    pub binding_blind: Fr,
}
// Standard wallet selection: at most three positive notes of the chosen asset.
// Largest-first finds a covering set whenever any set of <=3 can cover it.
pub fn select(
    ledger: &Ledger,
    key: &SpendKey,
    asset: asset::Id,
    amount: u128,
) -> Result<Vec<Note>> {
    ensure!(amount > 0, "Positive send required");
    let mut notes = ledger
        .notes(key.full_viewing_key())
        .into_iter()
        .filter(|n| n.asset_id() == asset && u128::from(n.amount()) > 0)
        .collect::<Vec<_>>();
    notes.sort_by_key(|n| std::cmp::Reverse(u128::from(n.amount())));
    let mut selected = vec![];
    let mut total = 0u128;
    for note in notes.into_iter().take(INPUTS) {
        total = total
            .checked_add(u128::from(note.amount()))
            .context("Amount overflow")?;
        selected.push(note);
        if total >= amount {
            return Ok(selected);
        }
    }
    anyhow::bail!("No set of up to three notes covers amount; consolidation or more funds required")
}
pub fn spend_parts(
    ledger: &Ledger,
    key: &SpendKey,
    note: &Note,
    randomizer: Fr,
    blind: Fr,
) -> Result<(SpendProofPublic, SpendProofPrivate)> {
    // Zero-value padding is permitted by upstream constraints; it has no real
    // pool membership requirement. Its commitment still needs a matching proof
    // object and its nullifier, key ownership, and randomized key are constrained.
    let mut scratch = Tree::new();
    let (pos, path) = if u128::from(note.amount()) == 0 {
        scratch.insert(Witness::Keep, note.commit())?;
        (
            scratch.position_of(note.commit()).unwrap(),
            scratch.witness(note.commit()).unwrap(),
        )
    } else {
        (
            ledger
                .tree
                .position_of(note.commit())
                .context("Note absent")?,
            ledger
                .tree
                .witness(note.commit())
                .context("Missing witness")?,
        )
    };
    let fvk = key.full_viewing_key();
    let mut plan = SpendPlan::new(&mut OsRng, note.clone(), pos);
    plan.randomizer = randomizer;
    plan.value_blinding = blind;
    Ok((
        SpendProofPublic {
            anchor: ledger.tree.root(),
            balance_commitment: plan.balance().commit(blind),
            nullifier: plan.nullifier(fvk),
            rk: plan.rk(fvk),
        },
        SpendProofPrivate {
            state_commitment_proof: path,
            note: note.clone(),
            v_blinding: blind,
            spend_auth_randomizer: randomizer,
            ak: *fvk.spend_verification_key(),
            nk: *fvk.nullifier_key(),
        },
    ))
}
pub fn prepare(
    ledger: &Ledger,
    key: &SpendKey,
    notes: &[Note],
    payments: &[(Address, Value); 2],
) -> Result<Prepared> {
    ensure!(
        !notes.is_empty() && notes.len() <= INPUTS,
        "One to three actual inputs required"
    );
    let asset = notes[0].asset_id();
    let mut seen = BTreeSet::new();
    for n in notes {
        ensure!(
            n.controlled_by(key.full_viewing_key()),
            "Input belongs to another holder"
        );
        ensure!(
            n.asset_id() == asset && u128::from(n.amount()) > 0,
            "Positive same-asset inputs required"
        );
        ensure!(seen.insert(n.commit().0.to_bytes()), "Duplicate input");
        let pos = ledger.tree.position_of(n.commit()).context("Note absent")?;
        ensure!(
            !ledger.nullifiers.contains(
                &Nullifier::derive(key.full_viewing_key().nullifier_key(), pos, &n.commit())
                    .0
                    .to_bytes()
            ),
            "Input spent"
        );
    }
    let total = notes.iter().try_fold(0u128, |s, n| {
        s.checked_add(u128::from(n.amount()))
            .context("Input amount overflow")
    })?;
    ensure!(
        payments.iter().all(|(_, v)| v.asset_id == asset),
        "Output asset mismatch"
    );
    let sent = payments.iter().try_fold(0u128, |s, (_, v)| {
        s.checked_add(u128::from(v.amount))
            .context("Output amount overflow")
    })?;
    ensure!(total == sent, "Value must be conserved");
    let randomizer = Fr::rand(&mut OsRng);
    let mut blind = Fr::from(0u64);
    let mut padded = notes.to_vec();
    while padded.len() < INPUTS {
        padded.push(Note::generate(&mut OsRng, &address(key), value(asset, 0)));
    }
    // Hide the position as well as the number of zero-value padding spends.
    for i in (1..padded.len()).rev() {
        let j = (OsRng.next_u32() as usize) % (i + 1);
        padded.swap(i, j);
    }
    let mut inputs = vec![];
    let mut spends = vec![];
    let mut shared_rk = None;
    for n in &padded {
        let vb = Fr::rand(&mut OsRng);
        blind += vb;
        let (public, private) = spend_parts(ledger, key, n, randomizer, vb)?;
        shared_rk = Some(public.rk);
        inputs.push(Input {
            cv: public.balance_commitment,
            nf: public.nullifier,
        });
        spends.push(SpendCircuit::from_parts(public, private));
    }
    let mut outs = vec![];
    let mut circuits = vec![];
    let mut routes = payments.clone();
    if OsRng.next_u32() & 1 != 0 {
        routes.swap(0, 1);
    }
    for (addr, val) in &routes {
        let o = OutputPlan::new(&mut OsRng, *val, addr.clone());
        let n = o.output_note();
        let cv = o.balance().commit(o.value_blinding);
        blind += o.value_blinding;
        circuits.push(OutputCircuit::new(
            OutputProofPublic {
                balance_commitment: cv,
                note_commitment: n.commit(),
            },
            OutputProofPrivate {
                note: n.clone(),
                balance_blinding: o.value_blinding,
            },
        ));
        outs.push(Output {
            cv,
            payload: Payload::encrypt(&n)?,
        });
    }
    Ok(Prepared {
        record: Record {
            anchor: ledger.tree.root(),
            inputs: inputs.try_into().ok().unwrap(),
            rk: shared_rk.unwrap(),
            auth: [0; 64].into(),
            outputs: outs.try_into().ok().unwrap(),
            proof: [0; PROOF_BYTES],
            binding: [0; 64].into(),
        },
        circuit: Combined {
            spends: spends.try_into().ok().unwrap(),
            outputs: circuits.try_into().ok().unwrap(),
        },
        randomizer,
        binding_blind: blind,
    })
}
pub fn prove(
    mut p: Prepared,
    pk: &ProvingKey<Bls12_377>,
    key: &SpendKey,
    domain: &[u8; 32],
) -> Result<Record> {
    let proof =
        Groth16::<Bls12_377>::create_random_proof_with_reduction(p.circuit, pk, &mut OsRng)?;
    let mut bytes = vec![];
    proof.serialize_compressed(&mut bytes)?;
    ensure!(bytes.len() == PROOF_BYTES);
    p.record.proof = bytes.try_into().unwrap();
    let msg = p.record.message(domain);
    p.record.auth = key
        .spend_auth_key()
        .randomize(&p.randomizer)
        .sign(OsRng, &msg);
    p.record.binding = SigningKey::<Binding>::from(p.binding_blind).sign(OsRng, &msg);
    Ok(p.record)
}
pub fn setup(c: Combined) -> Result<(ProvingKey<Bls12_377>, Vec<u8>, [u8; 32])> {
    // Fresh single-party setup for disposable testing. No toxic setup values or
    // proving key are saved; this is not a reviewed multiparty ceremony.
    let pk = Groth16::<Bls12_377>::generate_random_parameters_with_reduction(c, &mut OsRng)?;
    let mut vk = vec![];
    pk.vk.serialize_compressed(&mut vk)?;
    let mut d = b"XMR20-MULTI-INPUT-LAB-DISPOSABLE-SETUP-v1\0".to_vec();
    d.extend(&vk);
    Ok((pk, vk, hash(&d)))
}
pub fn read_vk(b: &[u8]) -> Result<PreparedVerifyingKey<Bls12_377>> {
    let vk = VerifyingKey::<Bls12_377>::deserialize_compressed(b)?;
    Ok(ark_groth16::prepare_verifying_key(&vk))
}

#[derive(Clone)]
pub struct Ledger {
    pub tree: Tree,
    pub nullifiers: BTreeSet<[u8; 32]>,
    pub history: Vec<Payload>,
    pub domain: [u8; 32],
}
impl Ledger {
    pub fn new(domain: [u8; 32], initial: &[Payload]) -> Result<Self> {
        let mut s = Self {
            tree: Tree::new(),
            nullifiers: BTreeSet::new(),
            history: vec![],
            domain,
        };
        for p in initial {
            s.tree.insert(Witness::Keep, p.note_commitment)?;
            s.history.push(p.clone());
        }
        Ok(s)
    }
    pub fn verify(&self, b: &Record, vk: &PreparedVerifyingKey<Bls12_377>) -> Result<()> {
        ensure!(b.anchor == self.tree.root(), "Stale/foreign root");
        let mut distinct = BTreeSet::new();
        for i in &b.inputs {
            ensure!(
                distinct.insert(i.nf.0.to_bytes()),
                "Duplicate input nullifier"
            );
            ensure!(
                !self.nullifiers.contains(&i.nf.0.to_bytes()),
                "Already spent"
            );
        }
        ensure!(
            b.outputs[0].payload.note_commitment != b.outputs[1].payload.note_commitment,
            "Duplicate outputs"
        );
        for o in &b.outputs {
            ensure!(
                self.tree.position_of(o.payload.note_commitment).is_none(),
                "Output already present"
            );
        }
        b.verify_crypto(vk, &self.domain)
    }
    pub fn apply(&mut self, b: &Record, vk: &PreparedVerifyingKey<Bls12_377>) -> Result<()> {
        self.verify(b, vk)?;
        let mut next = self.clone();
        for i in &b.inputs {
            next.nullifiers.insert(i.nf.0.to_bytes());
        }
        for o in &b.outputs {
            next.tree.insert(Witness::Keep, o.payload.note_commitment)?;
            next.history.push(o.payload.clone());
        }
        *self = next;
        Ok(())
    }
    pub fn notes(&self, fvk: &FullViewingKey) -> Vec<Note> {
        self.history
            .iter()
            .filter_map(|p| p.decrypt(fvk).ok())
            .filter(|n| {
                let pos = self.tree.position_of(n.commit()).expect("Indexed note");
                !self.nullifiers.contains(
                    &Nullifier::derive(fvk.nullifier_key(), pos, &n.commit())
                        .0
                        .to_bytes(),
                )
            })
            .collect()
    }
    pub fn balance(&self, fvk: &FullViewingKey) -> u128 {
        self.balance_asset(fvk, test_asset())
    }
    pub fn balance_asset(&self, fvk: &FullViewingKey, asset: asset::Id) -> u128 {
        self.notes(fvk)
            .iter()
            .filter(|n| n.asset_id() == asset)
            .map(|n| u128::from(n.amount()))
            .sum()
    }
}
#[derive(Serialize, Deserialize)]
pub struct Scenario {
    pub scope: String,
    pub verifying_key: String,
    pub domain: String,
    pub initial_notes: Vec<String>,
    pub records: Vec<String>,
}
pub fn replay(s: &Scenario) -> Result<serde_json::Value> {
    ensure!(s.records.len() <= 256 && s.initial_notes.len() <= 256);
    let vkbytes = hex::decode(&s.verifying_key)?;
    let vk = read_vk(&vkbytes)?;
    let domain: [u8; 32] = hex::decode(&s.domain)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Domain size"))?;
    let mut d = b"XMR20-MULTI-INPUT-LAB-DISPOSABLE-SETUP-v1\0".to_vec();
    d.extend(&vkbytes);
    ensure!(hash(&d) == domain);
    let initial = s
        .initial_notes
        .iter()
        .map(|b| decode_payload(&hex::decode(b)?))
        .collect::<Result<Vec<_>>>()?;
    let mut l = Ledger::new(domain, &initial)?;
    for b in &s.records {
        l.apply(&Record::decode(&hex::decode(b)?)?, &vk)?;
    }
    Ok(
        serde_json::json!({"records":s.records.len(),"notes":l.history.len(),"nullifiers":l.nullifiers.len(),"root":l.tree.root().to_string()}),
    )
}
