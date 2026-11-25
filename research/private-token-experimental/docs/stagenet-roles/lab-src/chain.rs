//! Shared canonical-chain replay: every role (wallet, indexer, issuer) rebuilds
//! the public pool from genesis on each scan, caching parsed blocks by hash.
use crate::{boundary, native, pool::Pool, transport, Config};
use anyhow::{ensure, Result};
use ark_groth16::{PreparedVerifyingKey, ProvingKey};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize, Valid};
use decaf377::Bls12_377;
use decaf377_rdsa::{SpendAuth, VerificationKey};
use monero_wallet::interface::prelude::*;
use rayon::prelude::*;
use serde_json::{json, Value as J};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io, path::Path};
use xmr20_multi_input_lab as xm3;

// ---- Trusted parameter manifest (format XMR20-PARAMS-1), the verifier-side anchor.
// The manifest is given to a role as a SEPARATE path (--trusted-manifest), independent of the
// parameter directory it authenticates; optionally its own sha256 is pinned (XMR20_TRUSTED_MANIFEST_SHA256).
// Every parameter file is authenticated (exact length, sha256) BEFORE it is parsed; the configuration
// must equal the manifest's; the manifest must describe this protocol version, circuit shapes and
// network; the daemon's genesis must equal the manifest's at startup. Any failure aborts the role
// before it can accept records or issue credits: there is no fallback to unauthenticated files.
pub const MANIFEST_FORMAT: &str = "XMR20-PARAMS-1";
pub const DOMAIN_LABEL: &str = "XMR20-MIGRATION-REHEARSAL-DOMAIN-v1";
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    #[serde(default)]
    pub vk: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestShape {
    pub magic: String,
    pub bytes: usize,
    pub inputs: usize,
    pub outputs: usize,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestRecords {
    pub transfer: ManifestShape,
    pub boundary: ManifestShape,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestProtocol {
    pub scheme: String,
    #[serde(rename = "domainLabel")]
    pub domain_label: String,
    pub records: ManifestRecords,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestNetwork {
    pub kind: String,
    pub genesis: String,
    // Pool start height: records below it are ignored; replay starts there (0 = genesis).
    #[serde(rename = "startHeight", default)]
    pub start_height: u64,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ManifestFiles {
    pub normal: ManifestFile,
    pub boundary: ManifestFile,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Manifest {
    pub format: String,
    pub label: String,
    pub protocol: ManifestProtocol,
    pub network: ManifestNetwork,
    #[serde(rename = "ledgerDomain")]
    pub ledger_domain: String,
    #[serde(rename = "issuerVk")]
    pub issuer_vk: String,
    pub config: Config,
    #[serde(rename = "parametersJson")]
    pub parameters_json: ManifestFile,
    pub files: ManifestFiles,
}
impl Manifest {
    pub fn read(path: &Path) -> Result<(Self, String)> {
        let bytes = fs::read(path).map_err(|e| anyhow::anyhow!("Trusted manifest {}: {e}", path.display()))?;
        let digest = hex::encode(xm3::hash(&bytes));
        if let Ok(pin) = std::env::var("XMR20_TRUSTED_MANIFEST_SHA256") {
            ensure!(pin == digest, "Trusted manifest sha256 {} does not match the pinned value {}", &digest[..16], &pin.get(..16).unwrap_or(&pin));
        }
        let m: Manifest = serde_json::from_slice(&bytes).map_err(|e| anyhow::anyhow!("Trusted manifest: {e}"))?;
        m.validate()?;
        Ok((m, digest))
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(self.format == MANIFEST_FORMAT, "Manifest format {} is not {MANIFEST_FORMAT}", self.format);
        ensure!(self.protocol.domain_label == DOMAIN_LABEL, "Manifest protocol domain {:?} is not {DOMAIN_LABEL:?}", self.protocol.domain_label);
        let t = &self.protocol.records.transfer;
        let b = &self.protocol.records.boundary;
        ensure!(t.magic == "XM3" && t.bytes == xm3::WIRE_BYTES && t.inputs == xm3::INPUTS && t.outputs == 2, "Manifest transfer circuit shape differs from this binary");
        ensure!(b.magic == "XB3" && b.bytes == boundary::WIRE_BYTES && b.inputs == xm3::INPUTS && b.outputs == 1, "Manifest boundary circuit shape differs from this binary");
        ensure!(self.network.kind == "offline-fakechain" || self.network.kind == "stagenet", "Unsupported network {:?} (offline-fakechain or stagenet only; mainnet refused)", self.network.kind);
        ensure!(self.network.genesis == self.config.chain, "Manifest genesis differs from its configuration");
        ensure!(self.ledger_domain == self.config.domain, "Manifest ledger domain differs from its configuration");
        ensure!(self.issuer_vk == self.config.issuer_vk, "Manifest issuer key differs from its configuration");
        ensure!(self.files.normal.vk == self.config.normal_vk && self.files.boundary.vk == self.config.boundary_vk, "Manifest verifying keys differ from its configuration");
        self.config.validate()?;
        for f in [&self.parameters_json, &self.files.normal, &self.files.boundary] {
            ensure!(hex::decode(&f.sha256).map(|h| h.len() == 32).unwrap_or(false) && f.bytes > 0, "Manifest pin for {} is malformed", f.path);
        }
        Ok(())
    }
}
pub fn authenticate_file(expected: &ManifestFile, bytes: &[u8]) -> Result<()> {
    ensure!(bytes.len() as u64 == expected.bytes, "Parameter file {} refused: {} bytes, the trusted manifest pins {} (missing, truncated or substituted)", expected.path, bytes.len(), expected.bytes);
    let digest = hex::encode(xm3::hash(bytes));
    ensure!(digest == expected.sha256, "Parameter file {} refused: sha256 {}… differs from the trusted manifest ({}…)", expected.path, &digest[..16], &expected.sha256[..16]);
    Ok(())
}
pub struct Params {
    pub manifest: Manifest,
    pub manifest_sha256: String,
    pub config: Config,
    pub domain: [u8; 32],
    pub normal: Option<ProvingKey<Bls12_377>>,
    pub bound: Option<ProvingKey<Bls12_377>>,
    pub normal_vk: PreparedVerifyingKey<Bls12_377>,
    pub boundary_vk: PreparedVerifyingKey<Bls12_377>,
    pub issuer_vk: VerificationKey<SpendAuth>,
}
// The complete file is authenticated against the trusted manifest BEFORE deserialization;
// deserialization is then followed by FULL point/subgroup validation, in parallel.
pub fn load_pk(path: &Path, expected: &ManifestFile) -> Result<ProvingKey<Bls12_377>> {
    let bytes = fs::read(path).map_err(|e| anyhow::anyhow!("Parameter file {} refused: {e}", expected.path))?;
    authenticate_file(expected, &bytes)?;
    let key: ProvingKey<Bls12_377> =
        ProvingKey::deserialize_uncompressed_unchecked(bytes.as_slice())?;
    key.vk.check()?;
    key.beta_g1.check()?;
    key.delta_g1.check()?;
    for points in [&key.a_query, &key.b_g1_query, &key.h_query, &key.l_query] {
        points.par_iter().try_for_each(|p| p.check())?;
    }
    key.b_g2_query.par_iter().try_for_each(|p| p.check())?;
    Ok(key)
}
impl Params {
    pub fn load(dir: &Path, prover: bool, trusted_manifest: &Path) -> Result<Self> {
        let (manifest, manifest_sha256) = Manifest::read(trusted_manifest)?;
        // parameters.json: authenticated as bytes first, then parsed, then compared field by field.
        let raw = fs::read(dir.join("parameters.json")).map_err(|e| anyhow::anyhow!("parameters.json refused: {e}"))?;
        authenticate_file(&manifest.parameters_json, &raw)?;
        let config: Config = serde_json::from_slice(&raw)?;
        ensure!(
            config.chain == manifest.config.chain && config.domain == manifest.config.domain && config.normal_vk == manifest.config.normal_vk && config.boundary_vk == manifest.config.boundary_vk && config.issuer_vk == manifest.config.issuer_vk,
            "parameters.json describes another ledger or version than the trusted manifest"
        );
        let domain = config.domain()?;
        let (normal, bound) = if prover {
            let n = load_pk(&dir.join("normal.public-pk"), &manifest.files.normal)?;
            let b = load_pk(&dir.join("boundary.public-pk"), &manifest.files.boundary)?;
            let mut nv = vec![];
            let mut bv = vec![];
            n.vk.serialize_compressed(&mut nv)?;
            b.vk.serialize_compressed(&mut bv)?;
            ensure!(
                hex::encode(nv) == config.normal_vk && hex::encode(bv) == config.boundary_vk,
                "Local parameters mismatch"
            );
            (Some(n), Some(b))
        } else {
            (None, None)
        };
        let issuer: [u8; 32] = hex::decode(&config.issuer_vk)?
            .try_into()
            .map_err(|_| anyhow::anyhow!("Issuer key"))?;
        Ok(Self {
            normal_vk: xm3::read_vk(&hex::decode(&config.normal_vk)?)?,
            boundary_vk: boundary::read_vk(&hex::decode(&config.boundary_vk)?)?,
            issuer_vk: VerificationKey::try_from(issuer)?,
            domain,
            config,
            normal,
            bound,
            manifest,
            manifest_sha256,
        })
    }
}
struct Block {
    hash: [u8; 32],
    txs: Vec<([u8; 32], Option<Vec<u8>>)>,
}
pub struct Chain {
    cache: BTreeMap<[u8; 32], Block>,
    pub pool: Pool,
    pub public: J,
    pub tip: usize,
}
impl Chain {
    pub fn new(domain: [u8; 32]) -> Result<Self> {
        Ok(Self { cache: BTreeMap::new(), pool: Pool::new(domain)?, public: J::Null, tip: 0 })
    }
    pub async fn scan(&mut self, rpc: &native::Rpc, p: &Params) -> Result<J> {
        native::guard(rpc, &p.manifest.network.kind).await?;
        let genesis = rpc.block_by_number(0).await?;
        ensure!(hex::encode(genesis.hash()) == p.config.chain, "Wrong chain");
        let tip = rpc.latest_block_number().await?;
        let tip_hash = rpc.block_by_number(tip).await?.hash();
        let first = (p.manifest.network.start_height as usize).max(1);
        // Records below the start height are outside the pool; a start height above the tip yields an empty pool.
        let mut previous = if first <= tip { rpc.block_by_number(first - 1).await?.hash() } else { [0u8; 32] };
        let mut pool = Pool::new(p.domain)?;
        let mut events = vec![];
        let mut blocks = vec![];
        for height in first..=tip {
            let b = rpc.block_by_number(height).await?;
            ensure!(
                b.number() == height && b.header.previous == previous,
                "Inconsistent canonical chain snapshot"
            );
            previous = b.hash();
            if !self.cache.contains_key(&b.hash()) {
                let scan = rpc.expand_to_scannable_block(b.clone()).await?;
                let txs = b
                    .transactions
                    .iter()
                    .zip(&scan.transactions)
                    .map(|(id, tx)| (*id, transport::unframe(&tx.prefix().extra).ok().flatten()))
                    .collect();
                self.cache.insert(b.hash(), Block { hash: b.hash(), txs });
            }
            let block = &self.cache[&b.hash()];
            let mut ids = vec![];
            for (id, wire) in &block.txs {
                let result = pool.apply(wire.as_deref(), *id, height as u64, &p.normal_vk, &p.boundary_vk, &p.issuer_vk);
                if result["record"] != "ignored" {
                    events.push(json!({"height":height,"txid":hex::encode(id),"result":result}));
                }
                ids.push(hex::encode(id));
            }
            blocks.push(json!({"height":height,"hash":hex::encode(block.hash),"transactions":ids}));
        }
        ensure!(
            rpc.block_by_number(tip).await?.hash() == tip_hash,
            "Chain changed during replay; retry"
        );
        self.pool = pool;
        self.tip = tip;
        self.public = json!({"tip":tip,"tipHash":hex::encode(tip_hash),"state":self.pool.summary(),"events":events,"canonicalBlocks":blocks});
        Ok(self.public.clone())
    }
    pub fn confirmed(&self, txid: &str) -> Option<usize> {
        self.public["canonicalBlocks"]
            .as_array()?
            .iter()
            .find(|b| b["transactions"].as_array().is_some_and(|t| t.iter().any(|x| x == txid)))
            .and_then(|b| b["height"].as_u64())
            .map(|h| self.tip - h as usize + 1)
    }
}
