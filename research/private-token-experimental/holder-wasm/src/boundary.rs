//! XB3 boundary record: a private credit (Solana deposit or legacy-claim
//! migration) or a private redemption with a PUBLIC amount. UNREVIEWED.
//! Three unchanged upstream SpendCircuits plus one unchanged OutputCircuit in a
//! fresh disposable Groth16 setup. The public amount enters ONLY the binding
//! (conservation) signature as a zero-blinding commitment; the circuits are the
//! same as the ordinary XM3 transfer. No native XMR source, key image, ring
//! position, amount or mask appears in this record.
use anyhow::{ensure, Context, Result};
use ark_ff::ToConstraintField;
use ark_groth16::{Groth16, PreparedVerifyingKey, Proof, ProvingKey, VerifyingKey};
use ark_relations::r1cs::{ConstraintSynthesizer, ConstraintSystemRef};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use ark_snark::SNARK;
use decaf377::{Bls12_377, Fq, Fr};
use decaf377_rdsa::{Binding, Signature, SigningKey, SpendAuth, VerificationKey};
use penumbra_sdk_asset::{asset, balance::{Balance, Commitment}};
use penumbra_sdk_keys::{keys::SpendKey, Address};
use penumbra_sdk_proto::DomainType;
use penumbra_sdk_sct::Nullifier;
use penumbra_sdk_shielded_pool::output::{OutputProofPrivate, OutputProofPublic};
use penumbra_sdk_shielded_pool::{Note, OutputCircuit, OutputPlan, SpendCircuit};
use penumbra_sdk_tct::Root;
use rand_core::{OsRng, RngCore};
use std::collections::BTreeSet;
use crate::xm3::{self as pool, hash, Input, Output, Payload, INPUTS, PROOF_BYTES};

pub const MAGIC: &[u8; 4] = b"XB3\xfe";
pub const KIND_DEPOSIT: u8 = 1;
pub const KIND_MIGRATION: u8 = 2;
pub const KIND_REDEEM: u8 = 3;
// magic4 anchor32 inputs(3*64) rk32 output(32+176) kind1 asset32 amount8
// binding32 auth64 proof192 conservation64 issuer64
pub const WIRE_BYTES: usize = 925;
pub const KIND_OFFSET: usize = 4 + 32 + 192 + 32 + 208;
pub const ISSUER_ZERO: [u8; 64] = [0; 64];

#[derive(Clone)]
pub struct Circuit {
    pub spends: [SpendCircuit; INPUTS],
    pub output: OutputCircuit,
}
impl ConstraintSynthesizer<Fq> for Circuit {
    fn generate_constraints(self, cs: ConstraintSystemRef<Fq>) -> ark_relations::r1cs::Result<()> {
        for s in self.spends {
            s.generate_constraints(cs.clone())?;
        }
        self.output.generate_constraints(cs)
    }
}

#[derive(Clone)]
pub struct Record {
    pub anchor: Root,
    pub inputs: [Input; INPUTS],
    pub rk: VerificationKey<SpendAuth>,
    pub output: Output,
    pub kind: u8,
    pub asset: asset::Id,
    pub amount: u64,
    pub binding: [u8; 32],
    pub auth: Signature<SpendAuth>,
    pub proof: [u8; PROOF_BYTES],
    pub conservation: Signature<Binding>,
    pub issuer: [u8; 64],
}
pub fn is_credit(kind: u8) -> bool {
    kind == KIND_DEPOSIT || kind == KIND_MIGRATION
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
        b.extend(self.output.cv.to_bytes());
        b.extend(self.output.payload.encode());
        b.push(self.kind);
        b.extend(self.asset.to_bytes());
        b.extend(self.amount.to_le_bytes());
        b.extend(self.binding);
        b
    }
    pub fn message(&self, domain: &[u8; 32]) -> [u8; 32] {
        let mut b = b"XMR20-MIGRATION-REHEARSAL-BOUNDARY-AUTH-v1\0".to_vec();
        b.extend(domain);
        b.extend(self.public_body());
        hash(&b)
    }
    pub fn issuer_message(&self, domain: &[u8; 32]) -> [u8; 32] {
        let mut b = b"XMR20-MIGRATION-REHEARSAL-ISSUER-v1\0".to_vec();
        b.extend(domain);
        b.extend(self.public_body());
        hash(&b)
    }
    pub fn encode(&self) -> Vec<u8> {
        let mut b = self.public_body();
        b.extend(self.auth.to_bytes());
        b.extend(self.proof);
        b.extend(self.conservation.to_bytes());
        b.extend(self.issuer);
        assert_eq!(b.len(), WIRE_BYTES);
        b
    }
    pub fn id(&self) -> [u8; 32] {
        hash(&self.encode())
    }
    pub fn decode(b: &[u8]) -> Result<Self> {
        ensure!(
            b.len() == WIRE_BYTES && &b[..4] == MAGIC,
            "Fixed boundary record required"
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
        let output = Output {
            cv: Commitment::try_from(r.take(32)?)?,
            payload: Payload::decode(r.take(pool::compact::PAYLOAD_BYTES)?)?,
        };
        let kind = r.take(1)?[0];
        let asset = asset::Id::try_from(r.take(32)?).map_err(|_| anyhow::anyhow!("Asset id"))?;
        let amount = u64::from_le_bytes(r.take(8)?.try_into()?);
        let binding: [u8; 32] = r.take(32)?.try_into()?;
        let record = Self {
            anchor,
            inputs: inputs
                .try_into()
                .map_err(|_| anyhow::anyhow!("Input count"))?,
            rk,
            output,
            kind,
            asset,
            amount,
            binding,
            auth: Signature::try_from(r.take(64)?)?,
            proof: r.take(PROOF_BYTES)?.try_into()?,
            conservation: Signature::try_from(r.take(64)?)?,
            issuer: r.take(64)?.try_into()?,
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
        fields!(self.output.payload.note_commitment.0);
        fields!(self.output.cv.0);
        Ok(v)
    }
    pub fn verify_proof(&self, vk: &PreparedVerifyingKey<Bls12_377>) -> Result<()> {
        let p = Proof::<Bls12_377>::deserialize_compressed(self.proof.as_slice())?;
        ensure!(
            Groth16::<Bls12_377>::verify_with_processed_vk(vk, &self.public_inputs()?, &p)?,
            "Boundary proof rejected"
        );
        Ok(())
    }
    // The public amount is enforced here: inputs + output + public adjustment
    // must commit to zero under the binding key. Issuer consent is required for
    // credits; redemptions carry an all-zero issuer field.
    pub fn verify_crypto(
        &self,
        vk: &PreparedVerifyingKey<Bls12_377>,
        domain: &[u8; 32],
        issuer_vk: &VerificationKey<SpendAuth>,
    ) -> Result<()> {
        ensure!(
            is_credit(self.kind) || self.kind == KIND_REDEEM,
            "Unknown boundary kind"
        );
        ensure!(self.amount > 0, "Positive public amount required");
        ensure!(self.binding != [0; 32], "Nonzero binding required");
        let msg = self.message(domain);
        self.rk.verify(&msg, &self.auth)?;
        let public = Balance::from(pool::value(self.asset, self.amount));
        let adjust = if is_credit(self.kind) {
            public.commit(Fr::from(0u64))
        } else {
            (-public).commit(Fr::from(0u64))
        };
        let sum = self
            .inputs
            .iter()
            .fold(Commitment(decaf377::Element::IDENTITY), |s, i| s + i.cv);
        let sum = sum + self.output.cv + adjust;
        VerificationKey::<Binding>::try_from(sum.to_bytes())?
            .verify(&msg, &self.conservation)
            .context("Public amount conservation rejected")?;
        if is_credit(self.kind) {
            issuer_vk
                .verify(
                    &self.issuer_message(domain),
                    &Signature::<SpendAuth>::try_from(self.issuer.as_slice())?,
                )
                .context("Issuer signature rejected")?;
        } else {
            ensure!(self.issuer == ISSUER_ZERO, "Redemption carries no issuer");
        }
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
    pub circuit: Circuit,
    pub randomizer: Fr,
    pub binding_blind: Fr,
}
fn spends(
    ledger: &pool::Ledger,
    key: &SpendKey,
    notes: &[Note],
    randomizer: Fr,
    blind: &mut Fr,
) -> Result<(Vec<Input>, Vec<SpendCircuit>, VerificationKey<SpendAuth>)> {
    ensure!(notes.len() == INPUTS);
    let mut inputs = vec![];
    let mut circuits = vec![];
    let mut rk = None;
    for n in notes {
        let vb = Fr::rand(&mut OsRng);
        *blind += vb;
        let (public, private) = pool::spend_parts(ledger, key, n, randomizer, vb)?;
        rk = Some(public.rk);
        inputs.push(Input {
            cv: public.balance_commitment,
            nf: public.nullifier,
        });
        circuits.push(SpendCircuit::from_parts(public, private));
    }
    Ok((inputs, circuits, rk.unwrap()))
}
fn output(
    to: &Address,
    asset: asset::Id,
    amount: u64,
    blind: &mut Fr,
) -> Result<(Output, OutputCircuit)> {
    let o = OutputPlan::new(&mut OsRng, pool::value(asset, amount), to.clone());
    let n = o.output_note();
    let cv = o.balance().commit(o.value_blinding);
    *blind += o.value_blinding;
    Ok((
        Output {
            cv,
            payload: Payload::encrypt(&n)?,
        },
        OutputCircuit::new(
            OutputProofPublic {
                balance_commitment: cv,
                note_commitment: n.commit(),
            },
            OutputProofPrivate {
                note: n,
                balance_blinding: o.value_blinding,
            },
        ),
    ))
}
fn zero_note(key: &SpendKey, asset: asset::Id) -> Note {
    Note::generate(&mut OsRng, &pool::address(key), pool::value(asset, 0))
}
fn assemble(
    anchor: Root,
    inputs: Vec<Input>,
    rk: VerificationKey<SpendAuth>,
    out: Output,
    spends: Vec<SpendCircuit>,
    out_circuit: OutputCircuit,
    kind: u8,
    asset: asset::Id,
    amount: u64,
    binding: [u8; 32],
    randomizer: Fr,
    blind: Fr,
) -> Prepared {
    Prepared {
        record: Record {
            anchor,
            inputs: inputs.try_into().ok().unwrap(),
            rk,
            output: out,
            kind,
            asset,
            amount,
            binding,
            auth: [0; 64].into(),
            proof: [0; PROOF_BYTES],
            conservation: [0; 64].into(),
            issuer: ISSUER_ZERO,
        },
        circuit: Circuit {
            spends: spends.try_into().ok().unwrap(),
            output: out_circuit,
        },
        randomizer,
        binding_blind: blind,
    }
}
// Credits consume three zero-value padding spends owned by the issuer's pool
// key and create one encrypted note for the recipient. Zero-value padding has no
// membership requirement upstream; its nullifiers are still unique and recorded.
pub fn prepare_credit(
    ledger: &pool::Ledger,
    issuer_key: &SpendKey,
    recipient: &Address,
    asset: asset::Id,
    amount: u64,
    kind: u8,
    binding: [u8; 32],
) -> Result<Prepared> {
    ensure!(is_credit(kind), "Credit kind required");
    ensure!(amount > 0 && binding != [0; 32], "Positive bound credit required");
    let randomizer = Fr::rand(&mut OsRng);
    let mut blind = Fr::from(0u64);
    let notes = [
        zero_note(issuer_key, asset),
        zero_note(issuer_key, asset),
        zero_note(issuer_key, asset),
    ];
    let (inputs, spends, rk) = spends(ledger, issuer_key, &notes, randomizer, &mut blind)?;
    let (out, out_circuit) = output(recipient, asset, amount, &mut blind)?;
    Ok(assemble(
        ledger.tree.root(),
        inputs,
        rk,
        out,
        spends,
        out_circuit,
        kind,
        asset,
        amount,
        binding,
        randomizer,
        blind,
    ))
}
// Redemptions spend one to three real notes, burn `amount` publicly and return
// exact change (possibly zero) to the holder's own address.
pub fn prepare_redeem(
    ledger: &pool::Ledger,
    key: &SpendKey,
    notes: &[Note],
    amount: u64,
    binding: [u8; 32],
) -> Result<Prepared> {
    ensure!(
        !notes.is_empty() && notes.len() <= INPUTS,
        "One to three actual inputs required"
    );
    ensure!(amount > 0 && binding != [0; 32], "Positive bound redemption required");
    let asset = notes[0].asset_id();
    let fvk = key.full_viewing_key();
    let mut seen = BTreeSet::new();
    let mut total = 0u128;
    for n in notes {
        ensure!(n.controlled_by(fvk), "Input belongs to another holder");
        ensure!(
            n.asset_id() == asset && u128::from(n.amount()) > 0,
            "Positive same-asset inputs required"
        );
        ensure!(seen.insert(n.commit().0.to_bytes()), "Duplicate input");
        let pos = ledger.tree.position_of(n.commit()).context("Note absent")?;
        ensure!(
            !ledger.nullifiers.contains(
                &Nullifier::derive(fvk.nullifier_key(), pos, &n.commit())
                    .0
                    .to_bytes()
            ),
            "Input spent"
        );
        total = total
            .checked_add(u128::from(n.amount()))
            .context("Amount overflow")?;
    }
    ensure!(total >= u128::from(amount), "Insufficient selected balance");
    let change = u64::try_from(total - u128::from(amount))?;
    let randomizer = Fr::rand(&mut OsRng);
    let mut blind = Fr::from(0u64);
    let mut padded = notes.to_vec();
    while padded.len() < INPUTS {
        padded.push(zero_note(key, asset));
    }
    for i in (1..padded.len()).rev() {
        let j = (OsRng.next_u32() as usize) % (i + 1);
        padded.swap(i, j);
    }
    let (inputs, spends, rk) = spends(ledger, key, &padded, randomizer, &mut blind)?;
    let (out, out_circuit) = output(&pool::address(key), asset, change, &mut blind)?;
    Ok(assemble(
        ledger.tree.root(),
        inputs,
        rk,
        out,
        spends,
        out_circuit,
        KIND_REDEEM,
        asset,
        amount,
        binding,
        randomizer,
        blind,
    ))
}
pub fn prove(
    mut p: Prepared,
    pk: &ProvingKey<Bls12_377>,
    key: &SpendKey,
    domain: &[u8; 32],
    issuer: Option<&SigningKey<SpendAuth>>,
) -> Result<Record> {
    ensure!(
        is_credit(p.record.kind) == issuer.is_some(),
        "Issuer consent exactly for credits"
    );
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
    p.record.conservation = SigningKey::<Binding>::from(p.binding_blind).sign(OsRng, &msg);
    if let Some(k) = issuer {
        p.record.issuer = k.sign(OsRng, &p.record.issuer_message(domain)).to_bytes();
    }
    Ok(p.record)
}
pub fn setup(c: Circuit) -> Result<(ProvingKey<Bls12_377>, Vec<u8>, [u8; 32])> {
    // Fresh single-party setup for disposable testing; no toxic values retained.
    let pk = Groth16::<Bls12_377>::generate_random_parameters_with_reduction(c, &mut OsRng)?;
    let mut vk = vec![];
    pk.vk.serialize_compressed(&mut vk)?;
    let mut d = b"XMR20-MIGRATION-REHEARSAL-BOUNDARY-DISPOSABLE-SETUP-v1\0".to_vec();
    d.extend(&vk);
    Ok((pk, vk, hash(&d)))
}
pub fn read_vk(b: &[u8]) -> Result<PreparedVerifyingKey<Bls12_377>> {
    let vk = VerifyingKey::<Bls12_377>::deserialize_compressed(b)?;
    Ok(ark_groth16::prepare_verifying_key(&vk))
}
