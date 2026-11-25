//! Public pool indexer: ordinary XM3 transfers plus XB3 credits/redemptions.
//! Rebuilt from the canonical native chain on every scan. Accepts any known
//! historical root as an anchor so independent holders may publish concurrently.
//! A record failing admission changes nothing; the native transaction still mined.
use anyhow::{ensure, Result};
use ark_groth16::PreparedVerifyingKey;
use decaf377::{Bls12_377, Fq};
use decaf377_rdsa::{SpendAuth, VerificationKey};
use penumbra_sdk_keys::FullViewingKey;
use penumbra_sdk_tct::Witness;
use serde::Serialize;
use serde_json::{json, Value as J};
use std::collections::{BTreeMap, BTreeSet};
use crate::xm3;

use crate::boundary;

#[derive(Clone, Serialize)]
pub struct Credit {
    pub kind: u8,
    pub asset: String,
    pub amount: u64,
    pub txid: String,
    pub height: u64,
}
#[derive(Clone, Serialize)]
pub struct Redemption {
    pub asset: String,
    pub amount: u64,
    pub binding: String,
    pub txid: String,
    pub height: u64,
}
#[derive(Clone)]
pub struct Pool {
    pub ledger: xm3::Ledger,
    roots: BTreeSet<[u8; 32]>,
    pub minted: BTreeMap<String, u128>,
    pub burned: BTreeMap<String, u128>,
    pub credits: BTreeMap<[u8; 32], Credit>,
    pub redemptions: BTreeMap<[u8; 32], Redemption>,
    pub accepted: usize,
    pub rejected: usize,
}
pub fn root(l: &xm3::Ledger) -> [u8; 32] {
    Fq::from(l.tree.root()).to_bytes()
}
impl Pool {
    pub fn new(domain: [u8; 32]) -> Result<Self> {
        let ledger = xm3::Ledger::new(domain, &[])?;
        let mut roots = BTreeSet::new();
        roots.insert(root(&ledger));
        Ok(Self {
            ledger,
            roots,
            minted: BTreeMap::new(),
            burned: BTreeMap::new(),
            credits: BTreeMap::new(),
            redemptions: BTreeMap::new(),
            accepted: 0,
            rejected: 0,
        })
    }
    fn fresh_inputs<'a>(&self, nfs: impl Iterator<Item = &'a xm3::Input>) -> Result<BTreeSet<[u8; 32]>> {
        let mut set = BTreeSet::new();
        for i in nfs {
            let nf = i.nf.0.to_bytes();
            ensure!(
                set.insert(nf) && !self.ledger.nullifiers.contains(&nf),
                "Spent or duplicate token input"
            );
        }
        Ok(set)
    }
    fn fresh_output(&self, o: &xm3::Output) -> Result<()> {
        ensure!(
            self.ledger
                .tree
                .position_of(o.payload.note_commitment)
                .is_none(),
            "Output commitment already exists"
        );
        Ok(())
    }
    fn commit_outputs(&mut self, nfs: BTreeSet<[u8; 32]>, outs: &[&xm3::Output]) -> Result<()> {
        self.ledger.nullifiers.extend(nfs);
        for o in outs {
            self.ledger
                .tree
                .insert(Witness::Keep, o.payload.note_commitment)?;
            self.ledger.history.push(o.payload.clone());
        }
        self.roots.insert(root(&self.ledger));
        Ok(())
    }
    fn ordinary(&mut self, r: &xm3::Record, vk: &PreparedVerifyingKey<Bls12_377>) -> Result<()> {
        ensure!(
            self.roots.contains(&Fq::from(r.anchor).to_bytes()),
            "Unknown transfer root"
        );
        let nfs = self.fresh_inputs(r.inputs.iter())?;
        ensure!(
            r.outputs[0].payload.note_commitment != r.outputs[1].payload.note_commitment,
            "Duplicate outputs"
        );
        for o in &r.outputs {
            self.fresh_output(o)?;
        }
        r.verify_crypto(vk, &self.ledger.domain)?;
        self.commit_outputs(nfs, &[&r.outputs[0], &r.outputs[1]])
    }
    fn boundary(
        &mut self,
        r: &boundary::Record,
        txid: [u8; 32],
        height: u64,
        vk: &PreparedVerifyingKey<Bls12_377>,
        issuer_vk: &VerificationKey<SpendAuth>,
    ) -> Result<()> {
        ensure!(
            self.roots.contains(&Fq::from(r.anchor).to_bytes()),
            "Unknown boundary root"
        );
        let nfs = self.fresh_inputs(r.inputs.iter())?;
        self.fresh_output(&r.output)?;
        if boundary::is_credit(r.kind) {
            ensure!(
                !self.credits.contains_key(&r.binding),
                "Backing receipt or claim already credited"
            );
        } else {
            ensure!(
                !self.redemptions.contains_key(&txid),
                "Redemption carrier already indexed"
            );
        }
        r.verify_crypto(vk, &self.ledger.domain, issuer_vk)?;
        self.commit_outputs(nfs, &[&r.output])?;
        let asset = hex::encode(r.asset.to_bytes());
        if boundary::is_credit(r.kind) {
            *self.minted.entry(asset.clone()).or_default() += u128::from(r.amount);
            self.credits.insert(
                r.binding,
                Credit {
                    kind: r.kind,
                    asset,
                    amount: r.amount,
                    txid: hex::encode(txid),
                    height,
                },
            );
        } else {
            *self.burned.entry(asset.clone()).or_default() += u128::from(r.amount);
            self.redemptions.insert(
                txid,
                Redemption {
                    asset,
                    amount: r.amount,
                    binding: hex::encode(r.binding),
                    txid: hex::encode(txid),
                    height,
                },
            );
        }
        Ok(())
    }
    // Called with native-consensus-validated carriers in canonical chain order.
    pub fn apply(
        &mut self,
        wire: Option<&[u8]>,
        txid: [u8; 32],
        height: u64,
        normal_vk: &PreparedVerifyingKey<Bls12_377>,
        boundary_vk: &PreparedVerifyingKey<Bls12_377>,
        issuer_vk: &VerificationKey<SpendAuth>,
    ) -> J {
        let Some(b) = wire else {
            return json!({"record":"ignored"});
        };
        let mut candidate = self.clone();
        let kind;
        let admission = if b.starts_with(xm3::MAGIC) {
            kind = json!("transfer");
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                xm3::Record::decode(b).and_then(|r| candidate.ordinary(&r, normal_vk))
            }))
            .unwrap_or_else(|_| Err(anyhow::anyhow!("Malformed transfer record")))
        } else if b.starts_with(boundary::MAGIC) {
            kind = json!(b.get(boundary::KIND_OFFSET).copied());
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                boundary::Record::decode(b)
                    .and_then(|r| candidate.boundary(&r, txid, height, boundary_vk, issuer_vk))
            }))
            .unwrap_or_else(|_| Err(anyhow::anyhow!("Malformed boundary record")))
        } else {
            return json!({"record":"ignored"});
        };
        match admission {
            Ok(()) => {
                candidate.accepted += 1;
                *self = candidate;
                json!({"record":"accepted","kind":kind})
            }
            Err(e) => {
                self.rejected += 1;
                json!({"record":"rejected","kind":kind,"error":e.to_string()})
            }
        }
    }
    pub fn balance(&self, fvk: &FullViewingKey, asset: penumbra_sdk_asset::asset::Id) -> u128 {
        self.ledger.balance_asset(fvk, asset)
    }
    pub fn balances(&self, fvk: &FullViewingKey) -> BTreeMap<String, u128> {
        let mut out = BTreeMap::new();
        for n in self.ledger.notes(fvk) {
            *out.entry(hex::encode(n.asset_id().to_bytes())).or_default() += u128::from(n.amount());
        }
        out
    }
    pub fn outstanding(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        for (a, m) in &self.minted {
            out.insert(a.clone(), (m - self.burned.get(a).copied().unwrap_or(0)).to_string());
        }
        out
    }
    pub fn note_count(&self, fvk: &FullViewingKey) -> usize {
        self.ledger.notes(fvk).len()
    }
    pub fn summary(&self) -> J {
        json!({
            "root": hex::encode(root(&self.ledger)),
            "notes": self.ledger.history.len(),
            "nullifiers": self.ledger.nullifiers.len(),
            "minted": self.minted.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),
            "burned": self.burned.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),
            "outstanding": self.outstanding(),
            "accepted": self.accepted,
            "rejected": self.rejected,
            "credits": self.credits.iter().map(|(k,v)| json!({"binding":hex::encode(k),"kind":v.kind,"asset":v.asset,"amount":v.amount.to_string(),"txid":v.txid,"height":v.height})).collect::<Vec<_>>(),
            "redemptions": self.redemptions.values().map(|v| json!({"txid":v.txid,"asset":v.asset,"amount":v.amount.to_string(),"binding":v.binding,"height":v.height})).collect::<Vec<_>>(),
        })
    }
}
