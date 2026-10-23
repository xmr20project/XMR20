//! Holder-side private token engine. SYNTHETIC TEST CODE, UNREVIEWED.
//!
//! Runs inside the extension's worker as wasm32 (no wasm-bindgen: a plain C ABI
//! with JSON requests). Everything that touches note secrets happens here:
//! token key derivation from the wallet's own root secret, local trial
//! decryption of the public record history, nullifier derivation (spent
//! status), note selection, Groth16 proving and spend authorization. Only
//! public data (addresses, finished records, the viewing key on explicit
//! request) leaves through the JSON interface.
//!
//! Key derivation scheme "XMR20-TKD1" (versioned):
//!   root      = the account's 32-byte Monero private spend key (the material the
//!               25-word recovery phrase encodes). Nothing else is needed to
//!               recover the token wallet.
//!   tsk       = BLAKE2b-256(key = root, personal = "XMR20-TKD1",
//!                           msg = "xmr20/private-token/spend-key" || LE32(account))
//!   SpendKey  = penumbra_sdk_keys::keys::SpendKey::from(SpendKeyBytes(tsk))
//!   fvk, ivk, nullifier key, payment address 0: the unchanged Penumbra key
//!               schedule (established SDK primitives).
//! Keyed BLAKE2b is a PRF: the token key cannot be computed without the root,
//! and nothing public (token address, records, viewing key) relates to the
//! native Monero keys. The relationship is one-way and secret: whoever holds
//! the Monero spend key also holds the token key (one recovery phrase), but no
//! observer can verify any link between a native output and a token address.
use anyhow::{ensure, Context, Result};
use ark_groth16::{PreparedVerifyingKey, ProvingKey};
use ark_serialize::{CanonicalDeserialize, CanonicalSerialize};
use decaf377::Bls12_377;
use decaf377_rdsa::{SpendAuth, VerificationKey};
use penumbra_sdk_asset::asset;
use penumbra_sdk_keys::{
    keys::{SpendKey, SpendKeyBytes},
    Address, FullViewingKey,
};
use penumbra_sdk_sct::Nullifier;
use penumbra_sdk_shielded_pool::Note;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as J};
use std::{cell::RefCell, collections::BTreeMap, str::FromStr};
use zeroize::Zeroizing;

pub mod boundary;
pub mod native;
pub mod pool;
pub mod transport;
pub mod xm3;

pub const SCHEME: &str = "XMR20-TKD1";

// ------------------------------------------------------------ randomness
// The wasm module has no operating system: the worker supplies randomness from
// crypto.getRandomValues through this import. Host builds use the OS directly.
#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "env")]
extern "C" {
    fn xmr20_random(ptr: *mut u8, len: usize) -> u32;
}
#[cfg(target_arch = "wasm32")]
fn host_random(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    let r = unsafe { xmr20_random(buf.as_mut_ptr(), buf.len()) };
    if r == 0 {
        Ok(())
    } else {
        Err(getrandom::Error::UNSUPPORTED)
    }
}
#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(host_random);

// ------------------------------------------------------------ parameters
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Config {
    pub chain: String,
    pub domain: String,
    pub normal_vk: String,
    pub boundary_vk: String,
    pub issuer_vk: String,
}
impl Config {
    // Identical to the integration lab: the ledger domain binds the chain
    // genesis, both verifying keys and the issuer key.
    pub fn computed_domain(&self) -> Result<[u8; 32]> {
        let mut b = b"XMR20-MIGRATION-REHEARSAL-DOMAIN-v1\0".to_vec();
        for f in [&self.chain, &self.normal_vk, &self.boundary_vk, &self.issuer_vk] {
            let bytes = hex::decode(f)?;
            b.extend((bytes.len() as u32).to_le_bytes());
            b.extend(bytes);
        }
        Ok(xm3::hash(&b))
    }
    pub fn domain(&self) -> Result<[u8; 32]> {
        ensure!(hex::decode(&self.chain)?.len() == 32, "Chain genesis");
        ensure!(hex::decode(&self.issuer_vk)?.len() == 32, "Issuer key");
        ensure!(hex::encode(self.computed_domain()?) == self.domain, "Domain mismatch");
        Ok(hex::decode(&self.domain)?.try_into().unwrap())
    }
}
// ------------------------------------------------------------ shipped manifest
// The parameter manifest (format XMR20-PARAMS-1) is shipped WITH the build
// (params/<set>/manifest.json -> extension vendor/parameters-manifest.json,
// sha256 compiled into the worker bundle). It is the only trust anchor for the
// proving and verifying parameter files: expected byte length and sha256 of
// every file, the verifying keys, the ledger domain, the chain genesis and the
// protocol version/circuits. Anything the parameter server says about its own
// files (checksums, sizes, configuration) is checked AGAINST the manifest and
// never trusted on its own.
pub const MANIFEST_FORMAT: &str = "XMR20-PARAMS-1";
pub const DOMAIN_LABEL: &str = "XMR20-MIGRATION-REHEARSAL-DOMAIN-v1";
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ParamFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub vk: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RecordShape {
    pub magic: String,
    pub bytes: usize,
    pub inputs: usize,
    pub outputs: usize,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Records {
    pub transfer: RecordShape,
    pub boundary: RecordShape,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Protocol {
    pub scheme: String,
    #[serde(rename = "domainLabel")]
    pub domain_label: String,
    pub records: Records,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Network {
    pub kind: String,
    pub genesis: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Files {
    pub normal: ParamFile,
    pub boundary: ParamFile,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct JsonFile {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Manifest {
    pub format: String,
    pub label: String,
    pub protocol: Protocol,
    pub network: Network,
    #[serde(rename = "ledgerDomain")]
    pub ledger_domain: String,
    #[serde(rename = "issuerVk")]
    pub issuer_vk: String,
    pub config: Config,
    #[serde(rename = "parametersJson")]
    pub parameters_json: JsonFile,
    pub files: Files,
}
impl Manifest {
    // Internal consistency: format, protocol version (domain label, scheme,
    // record shapes compiled into this engine), network, and the ledger domain
    // recomputed from the embedded configuration.
    pub fn validate(&self) -> Result<[u8; 32]> {
        ensure!(self.format == MANIFEST_FORMAT, "Parameter manifest format {} is not {MANIFEST_FORMAT}", self.format);
        ensure!(self.protocol.domain_label == DOMAIN_LABEL, "Parameter manifest is for protocol domain {:?}, this engine implements {DOMAIN_LABEL:?}", self.protocol.domain_label);
        ensure!(self.protocol.scheme == SCHEME, "Parameter manifest key scheme {} is not {SCHEME}", self.protocol.scheme);
        let t = &self.protocol.records.transfer;
        let b = &self.protocol.records.boundary;
        ensure!(t.magic == "XM3" && t.bytes == xm3::WIRE_BYTES && t.inputs == xm3::INPUTS && t.outputs == 2, "Parameter manifest transfer circuit does not match this engine");
        ensure!(b.magic == "XB3" && b.bytes == boundary::WIRE_BYTES && b.inputs == xm3::INPUTS && b.outputs == 1, "Parameter manifest boundary circuit does not match this engine");
        ensure!(self.network.kind == "offline-fakechain", "This test engine only accepts offline-fakechain parameters");
        ensure!(self.network.genesis == self.config.chain, "Parameter manifest genesis differs from its configuration");
        ensure!(self.ledger_domain == self.config.domain, "Parameter manifest ledger domain differs from its configuration");
        ensure!(self.issuer_vk == self.config.issuer_vk, "Parameter manifest issuer key differs from its configuration");
        ensure!(self.files.normal.vk == self.config.normal_vk, "Parameter manifest transfer verifying key differs from its configuration");
        ensure!(self.files.boundary.vk == self.config.boundary_vk, "Parameter manifest boundary verifying key differs from its configuration");
        for f in [&self.files.normal, &self.files.boundary] {
            ensure!(hex::decode(&f.sha256).map(|h| h.len() == 32).unwrap_or(false), "Parameter manifest file hash is not a sha256");
            ensure!(f.bytes > 0, "Parameter manifest file length");
        }
        ensure!(hex::decode(&self.parameters_json.sha256).map(|h| h.len() == 32).unwrap_or(false), "Parameter manifest parameters.json hash is not a sha256");
        self.config.domain()
    }
}
pub struct Params {
    pub config: Config,
    pub domain: [u8; 32],
    pub manifest: Manifest,
    pub normal_vk: PreparedVerifyingKey<Bls12_377>,
    pub boundary_vk: PreparedVerifyingKey<Bls12_377>,
    pub issuer_vk: VerificationKey<SpendAuth>,
}
impl Params {
    // `served` is the configuration the parameter server handed out; it must be
    // byte-for-byte the configuration pinned by the shipped manifest.
    pub fn new(manifest: Manifest, served: Option<Config>) -> Result<Self> {
        let domain = manifest.validate()?;
        if let Some(s) = served {
            ensure!(
                s.chain == manifest.config.chain && s.domain == manifest.config.domain && s.normal_vk == manifest.config.normal_vk && s.boundary_vk == manifest.config.boundary_vk && s.issuer_vk == manifest.config.issuer_vk,
                "The parameter server serves a different ledger or version (domain {}…) than the parameters shipped with this build (domain {}…)",
                &s.domain[..16],
                &manifest.config.domain[..16]
            );
        }
        let config = manifest.config.clone();
        let issuer: [u8; 32] = hex::decode(&config.issuer_vk)?.try_into().map_err(|_| anyhow::anyhow!("Issuer key"))?;
        Ok(Self {
            normal_vk: xm3::read_vk(&hex::decode(&config.normal_vk)?)?,
            boundary_vk: boundary::read_vk(&hex::decode(&config.boundary_vk)?)?,
            issuer_vk: VerificationKey::try_from(issuer)?,
            domain,
            config,
            manifest,
        })
    }
    pub fn expected(&self, slot: u32) -> Result<&ParamFile> {
        match slot {
            0 => Ok(&self.manifest.files.normal),
            1 => Ok(&self.manifest.files.boundary),
            _ => anyhow::bail!("Unknown parameter slot"),
        }
    }
}
// Authenticate a complete parameter file against the shipped manifest BEFORE
// anything parses it: exact length, then sha256 over every byte.
pub fn authenticate_file(expected: &ParamFile, bytes: &[u8]) -> Result<String> {
    ensure!(
        bytes.len() as u64 == expected.bytes,
        "Parameter file {} rejected: {} bytes received, the shipped manifest pins {} bytes (missing, truncated or substituted file)",
        expected.path,
        bytes.len(),
        expected.bytes
    );
    let digest = hex::encode(xm3::hash(bytes));
    ensure!(digest == expected.sha256, "Parameter file {} rejected: sha256 {}… does not match the shipped manifest ({}…); the file was not used", expected.path, &digest[..16], &expected.sha256[..16]);
    Ok(digest)
}

// ------------------------------------------------------------ key schedule
pub fn derive_token_spend_key(root: &[u8; 32], account: u32) -> Zeroizing<[u8; 32]> {
    let h = blake2b_simd::Params::new()
        .hash_length(32)
        .key(root)
        .personal(b"XMR20-TKD1")
        .to_state()
        .update(b"xmr20/private-token/spend-key")
        .update(&account.to_le_bytes())
        .finalize();
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(h.as_bytes());
    out
}

// ------------------------------------------------------------ engine
#[derive(Clone, Serialize)]
pub struct RecordInfo {
    pub height: u64,
    pub txid: String,
    pub status: String,
    pub kind: J,
    pub error: Option<String>,
}
#[derive(Default)]
pub struct Engine {
    key: Option<SpendKey>,
    fvk: Option<FullViewingKey>,
    params: Option<Params>,
    pool: Option<pool::Pool>,
    records: BTreeMap<String, RecordInfo>,
    tip: u64,
    normal_pk: Option<ProvingKey<Bls12_377>>,
    boundary_pk: Option<ProvingKey<Bls12_377>>,
    // Holder's native Monero wallet (carrier construction); None for viewing-only engines.
    native: Option<native::NativeWallet>,
}
fn txt<'a>(v: &'a J, k: &str) -> Result<&'a str> {
    v[k].as_str().context(format!("Text field {k}"))
}
fn bytes32(s: &str) -> Result<[u8; 32]> {
    hex::decode(s)?.try_into().map_err(|_| anyhow::anyhow!("32-byte field"))
}
fn amount(v: &J, k: &str) -> Result<u64> {
    let s = txt(v, k)?;
    ensure!(
        !s.is_empty() && s.len() <= 20 && s.bytes().all(|b| b.is_ascii_digit()) && (s == "0" || !s.starts_with('0')),
        "Canonical atomic amount"
    );
    Ok(s.parse()?)
}
fn asset_of(q: &J) -> Result<asset::Id> {
    asset::Id::try_from(bytes32(txt(q, "asset")?)?).map_err(|_| anyhow::anyhow!("Asset id"))
}
fn hexset(v: &J) -> Result<std::collections::BTreeSet<[u8; 32]>> {
    let mut s = std::collections::BTreeSet::new();
    if let Some(a) = v.as_array() {
        for x in a {
            s.insert(bytes32(x.as_str().context("Commitment hex")?)?);
        }
    }
    Ok(s)
}
pub struct Owned {
    pub note: Note,
    pub position: u64,
    pub spent: bool,
}
impl Engine {
    fn params(&self) -> Result<&Params> {
        self.params.as_ref().context("Set the public parameters first")
    }
    fn pool(&self) -> Result<&pool::Pool> {
        self.pool.as_ref().context("Set the public parameters first")
    }
    fn fvk(&self) -> Result<&FullViewingKey> {
        self.fvk.as_ref().context("No wallet open in the engine")
    }
    fn key(&self) -> Result<&SpendKey> {
        self.key.as_ref().context("This engine holds a viewing key only: it cannot spend")
    }
    // Every decryptable note in the public history, with its spent status from
    // the public nullifier set (nullifier derived locally with our own key).
    pub fn owned(&self) -> Result<Vec<Owned>> {
        let fvk = self.fvk()?;
        let l = &self.pool()?.ledger;
        let mut out = vec![];
        for p in &l.history {
            if let Ok(note) = p.decrypt(fvk) {
                let position: u64 = l.tree.position_of(note.commit()).context("Indexed note")?.into();
                let nf = Nullifier::derive(fvk.nullifier_key(), position.into(), &note.commit()).0.to_bytes();
                out.push(Owned { note, position, spent: l.nullifiers.contains(&nf) });
            }
        }
        Ok(out)
    }
    fn note_json(o: &Owned) -> J {
        json!({"commitment":hex::encode(o.note.commit().0.to_bytes()),"asset":hex::encode(o.note.asset_id().to_bytes()),"amount":u128::from(o.note.amount()).to_string(),"position":o.position,"spent":o.spent})
    }
    fn select(&self, asset: asset::Id, amount: u128, exclude: &std::collections::BTreeSet<[u8; 32]>) -> Result<Vec<Note>> {
        ensure!(amount > 0, "Positive amount required");
        let mut notes = self
            .owned()?
            .into_iter()
            .filter(|o| !o.spent && o.note.asset_id() == asset && u128::from(o.note.amount()) > 0 && !exclude.contains(&o.note.commit().0.to_bytes()))
            .map(|o| o.note)
            .collect::<Vec<_>>();
        notes.sort_by_key(|n| std::cmp::Reverse(u128::from(n.amount())));
        let available: u128 = notes.iter().map(|n| u128::from(n.amount())).sum();
        ensure!(available >= amount, "Insufficient unreserved balance of this asset: {available} available");
        let mut selected = vec![];
        let mut total = 0u128;
        for n in notes.into_iter().take(xm3::INPUTS) {
            total += u128::from(n.amount());
            selected.push(n);
            if total >= amount {
                return Ok(selected);
            }
        }
        anyhow::bail!("No set of up to three unreserved notes covers {amount}; consolidate smaller notes first (fragmented balance)")
    }
    fn notes_by_commitment(&self, cms: &J) -> Result<Vec<Note>> {
        let want = cms.as_array().context("notes array")?;
        ensure!(!want.is_empty() && want.len() <= xm3::INPUTS, "One to three inputs required");
        let owned = self.owned()?;
        let mut out = vec![];
        for c in want {
            let cm = bytes32(c.as_str().context("Commitment hex")?)?;
            let o = owned.iter().find(|o| o.note.commit().0.to_bytes() == cm).context("Selected note is not in this wallet")?;
            ensure!(!o.spent, "Selected note is already spent");
            out.push(o.note.clone());
        }
        Ok(out)
    }
    pub fn set_blob(&mut self, slot: u32, bytes: &[u8]) -> Result<J> {
        let p = self.params()?;
        let expected = p.expected(slot)?;
        // 1. Authenticate the complete file against the shipped manifest (length,
        //    sha256) BEFORE deserializing a single field. A substituted, truncated
        //    or corrupted file - including one whose query vectors were altered
        //    while the embedded verifying key was kept - never reaches the parser,
        //    the prover or the network.
        let digest = authenticate_file(expected, bytes)?;
        // 2. Parse. 3. Defence in depth: the embedded verifying key must still be
        //    the one pinned by the ledger domain.
        let pk: ProvingKey<Bls12_377> = ProvingKey::deserialize_uncompressed_unchecked(bytes).context("Proving key format")?;
        let mut vk = vec![];
        pk.vk.serialize_compressed(&mut vk)?;
        ensure!(hex::encode(&vk) == expected.vk, "Proving key does not match the pinned verifying key");
        let label = p.manifest.label.clone();
        if slot == 0 {
            self.normal_pk = Some(pk);
        } else {
            self.boundary_pk = Some(pk);
        }
        Ok(json!({"slot":slot,"bytes":bytes.len(),"sha256":digest,"authenticated":true,"manifest":MANIFEST_FORMAT,"label":label}))
    }
    pub fn proving_key_loaded(&self, slot: u32) -> bool {
        match slot {
            0 => self.normal_pk.is_some(),
            _ => self.boundary_pk.is_some(),
        }
    }
    fn apply_extra(&mut self, height: u64, txid: String, extra: &[u8]) -> Result<J> {
        let wire = transport::unframe(extra).ok().flatten();
        let p = self.params.as_ref().context("params")?;
        let pool = self.pool.as_mut().context("params")?;
        let result = pool.apply(wire.as_deref(), bytes32(&txid)?, height, &p.normal_vk, &p.boundary_vk, &p.issuer_vk);
        if result["record"] == "ignored" {
            return Ok(json!({"record":"ignored"}));
        }
        let id = hex::encode(xm3::hash(wire.as_deref().unwrap()));
        let info = RecordInfo { height, txid, status: result["record"].as_str().unwrap_or("?").into(), kind: result["kind"].clone(), error: result["error"].as_str().map(String::from) };
        self.records.insert(id.clone(), info.clone());
        Ok(json!({"record":info.status,"kind":info.kind,"recordId":id,"error":info.error}))
    }
    pub fn call(&mut self, q: &J) -> Result<J> {
        match txt(q, "op")? {
            "version" => Ok(json!({"scheme":SCHEME,"engine":"xmr20-holder-wasm 0.0.1-params","records":{"transfer":xm3::WIRE_BYTES,"boundary":boundary::WIRE_BYTES},"inputs":xm3::INPUTS,"parameterManifest":MANIFEST_FORMAT,"domainLabel":DOMAIN_LABEL,"parameters":self.params.as_ref().map(|p|json!({"label":p.manifest.label,"domain":p.config.domain,"normalLoaded":self.normal_pk.is_some(),"boundaryLoaded":self.boundary_pk.is_some()}))})),
            // Derive the token spend key from the wallet's root secret. The root
            // arrives once, is used once and is wiped here.
            "derive" => {
                let mut root = Zeroizing::new(bytes32(txt(q, "root")?)?);
                let account = q["account"].as_u64().unwrap_or(0) as u32;
                let tsk = derive_token_spend_key(&root, account);
                // The same root is the account's Monero private spend key: the native
                // wallet for carrier fees is derived here too (view = Hs(spend)).
                let native_wallet = native::NativeWallet::from_root(&root)?;
                root.fill(0);
                let key: SpendKey = SpendKeyBytes(*tsk).into();
                let fvk = key.full_viewing_key().clone();
                let address = xm3::address(&key).to_string();
                let native_address = native_wallet.address();
                self.key = Some(key);
                self.fvk = Some(fvk);
                self.native = Some(native_wallet);
                Ok(json!({"scheme":SCHEME,"account":account,"tokenAddress":address,"nativeAddress":native_address}))
            }
            // View-only engine (what an indexer given the viewing key can do).
            "openViewing" => {
                let fvk = FullViewingKey::from_str(txt(q, "viewingKey")?).map_err(|e| anyhow::anyhow!("Viewing key: {e}"))?;
                let address = fvk.payment_address(0u32.into()).0.to_string();
                self.key = None;
                self.fvk = Some(fvk);
                Ok(json!({"tokenAddress":address,"canSpend":false}))
            }
            // Explicit export: only on request from the popup's share action.
            "viewingKey" => Ok(json!({"viewingKey":self.fvk()?.to_string()})),
            // Public parameters: the SHIPPED manifest is required; the server's
            // configuration (if given) must equal the manifest's. Loading new
            // parameters drops any proving key loaded under the previous ones.
            "params" => {
                ensure!(!q["manifest"].is_null(), "Shipped parameter manifest required (no server-supplied configuration is trusted on its own)");
                let manifest: Manifest = serde_json::from_value(q["manifest"].clone()).context("Parameter manifest")?;
                let served: Option<Config> = if q["served"].is_null() { None } else { Some(serde_json::from_value(q["served"].clone()).context("served configuration")?) };
                let p = Params::new(manifest, served)?;
                self.pool = Some(pool::Pool::new(p.domain)?);
                self.records.clear();
                self.tip = 0;
                self.normal_pk = None;
                self.boundary_pk = None;
                let domain = p.config.domain.clone();
                self.params = Some(p);
                Ok(json!({"domain":domain}))
            }
            "reset" => {
                let d = self.params()?.domain;
                self.pool = Some(pool::Pool::new(d)?);
                self.records.clear();
                self.tip = 0;
                if let Some(n) = self.native.as_mut() {
                    n.reset();
                }
                Ok(json!({"reset":true}))
            }
            // One complete block (blob + every transaction blob) in canonical order:
            // native scanning (owned outputs, key images, local RingCT index) and
            // the token pool (each transaction's extra) in one pass.
            "applyBlock" => {
                let height = q["height"].as_u64().context("height")?;
                let txs: Vec<(String, String)> = q["txs"].as_array().context("txs")?.iter().map(|t| Ok((txt(t, "txid")?.to_string(), txt(t, "hex")?.to_string()))).collect::<Result<_>>()?;
                let (extras, native_stats) = match self.native.as_mut() {
                    Some(n) => n.apply_block(height as usize, txt(q, "block")?, &txs)?,
                    None => {
                        // Viewing-only engine: still needs each transaction's extra.
                        let mut out = vec![];
                        for (txid, hex_tx) in &txs {
                            let b = hex::decode(hex_tx)?;
                            let tx = monero_wallet::transaction::Transaction::read(&mut b.as_slice()).map_err(|e| anyhow::anyhow!("Transaction: {e}"))?;
                            ensure!(hex::encode(tx.hash()) == *txid, "Transaction hash mismatch");
                            out.push((txid.clone(), tx.prefix().extra.clone()));
                        }
                        (out, json!(null))
                    }
                };
                let mut records = vec![];
                for (txid, extra) in extras {
                    let r = self.apply_extra(height, txid, &extra)?;
                    if r["record"] != "ignored" {
                        records.push(r);
                    }
                }
                self.tip = self.tip.max(height);
                Ok(json!({"height":height,"records":records,"native":native_stats}))
            }
            "nativeStatus" => {
                let exclude = hexset(&q["exclude"])?;
                Ok(self.native.as_ref().context("No native wallet in this engine")?.status(&exclude))
            }
            "nativeReserve" => {
                let kis: Vec<[u8; 32]> = hexset(&q["keyImages"])?.into_iter().collect();
                self.native.as_mut().context("No native wallet")?.reserve(&kis);
                Ok(json!({"reserved":kis.len()}))
            }
            "nativeRelease" => {
                let kis: Vec<[u8; 32]> = hexset(&q["keyImages"])?.into_iter().collect();
                self.native.as_mut().context("No native wallet")?.release(&kis);
                Ok(json!({"released":kis.len()}))
            }
            // Carrier fee quote: picks the native input, runs decoy selection against
            // the host-supplied daemon answers (see native.rs) and returns the exact fee.
            "carrierQuote" => {
                let kind = txt(q, "kind")?;
                let wire_len = match kind { "send" => xm3::WIRE_BYTES, "redeem" => boundary::WIRE_BYTES, other => anyhow::bail!("Unknown carrier kind {other}") };
                let per_weight = q["feeRate"]["perWeight"].as_str().context("feeRate.perWeight")?.parse::<u64>()?;
                let mask = q["feeRate"]["mask"].as_str().context("feeRate.mask")?.parse::<u64>()?;
                let fee_rate = monero_wallet::interface::FeeRate::new(per_weight, mask).context("Invalid fee rate")?;
                let distribution: Vec<u64> = q["distribution"].as_array().context("distribution")?.iter().map(|v| v.as_u64().context("distribution entry")).collect::<Result<_>>()?;
                let exclude = hexset(&q["exclude"])?;
                self.native.as_mut().context("No native wallet")?.quote(kind, wire_len, fee_rate, distribution, &exclude)
            }
            "carrierOuts" => {
                let id = txt(q, "quoteId")?;
                let mut outs = vec![];
                for o in q["outs"].as_array().context("outs")? {
                    let index = o["index"].as_u64().context("index")?;
                    let unlocked = o["unlocked"].as_bool().unwrap_or(false);
                    let point = |k: &str| -> Result<monero_wallet::ed25519::Point> { monero_wallet::ed25519::CompressedPoint::from(bytes32(txt(o, k)?)?).decompress().context("Invalid point from daemon") };
                    let v = if unlocked { Some([point("key")?, point("mask")?]) } else { None };
                    outs.push((index, v));
                }
                self.native.as_mut().context("No native wallet")?.quote_outs(id, &outs)
            }
            "carrierSign" => {
                let wire = hex::decode(txt(q, "wire")?)?;
                // The record must be one this engine admits before a fee is paid for it.
                let p = self.params()?;
                let mut candidate = self.pool()?.clone();
                let check = candidate.apply(Some(&wire), [0; 32], self.tip, &p.normal_vk, &p.boundary_vk, &p.issuer_vk);
                ensure!(check["record"] == "accepted", "Record fails local admission; no carrier built: {}", check["error"]);
                self.native.as_mut().context("No native wallet")?.sign(txt(q, "quoteId")?, &wire)
            }
            "carrierCancel" => Ok(json!({"cancelled":self.native.as_mut().context("No native wallet")?.cancel(txt(q, "quoteId")?)})),
            // Apply one native transaction's tx_extra in canonical order. The
            // record is admitted with the same rules as the public indexer.
            "apply" => {
                let height = q["height"].as_u64().context("height")?;
                let txid = txt(q, "txid")?.to_string();
                let extra = hex::decode(txt(q, "extra")?)?;
                let r = self.apply_extra(height, txid, &extra)?;
                self.tip = self.tip.max(height);
                Ok(r)
            }
            "tip" => {
                self.tip = q["height"].as_u64().context("height")?;
                Ok(json!({"tip":self.tip}))
            }
            // Zero-value change notes (a self-send with no remainder) are real but unspendable value: listed separately, never counted.
            "status" => {
                let owned = self.owned()?;
                let mut balances: BTreeMap<String, u128> = BTreeMap::new();
                for o in owned.iter().filter(|o| !o.spent) {
                    *balances.entry(hex::encode(o.note.asset_id().to_bytes())).or_default() += u128::from(o.note.amount());
                }
                let records = self.records.iter().map(|(id, r)| (id.clone(), json!({"height":r.height,"txid":r.txid,"status":r.status,"kind":r.kind,"error":r.error,"confirmations":self.tip+1-r.height}))).collect::<BTreeMap<_, _>>();
                Ok(json!({"tokenAddress":self.fvk()?.payment_address(0u32.into()).0.to_string(),"canSpend":self.key.is_some(),"tip":self.tip,"balances":balances.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"notes":owned.iter().filter(|o|!o.spent&&u128::from(o.note.amount())>0).map(Self::note_json).collect::<Vec<_>>(),"spent":owned.iter().filter(|o|o.spent).map(Self::note_json).collect::<Vec<_>>(),"zeroNotes":owned.iter().filter(|o|!o.spent&&u128::from(o.note.amount())==0).count(),"records":records,"pool":self.pool()?.summary()}))
            }
            "select" => {
                let asset = asset_of(q)?;
                let n = amount(q, "amount")?;
                let exclude = hexset(&q["exclude"])?;
                let notes = self.select(asset, u128::from(n), &exclude)?;
                let total: u128 = notes.iter().map(|x| u128::from(x.amount())).sum();
                Ok(json!({"notes":notes.iter().map(|x|hex::encode(x.commit().0.to_bytes())).collect::<Vec<_>>(),"total":total.to_string(),"change":(total-u128::from(n)).to_string()}))
            }
            // Build a finished record from explicitly selected notes. Proving
            // keys must have been loaded (slot 0 transfers, slot 1 boundary).
            "build" => {
                let key = self.key()?;
                let p = self.params()?;
                let ledger = &self.pool()?.ledger;
                let notes = self.notes_by_commitment(&q["notes"])?;
                let n = amount(q, "amount")?;
                let asset = notes[0].asset_id();
                ensure!(notes.iter().all(|x| x.asset_id() == asset), "Mixed assets");
                let total: u128 = notes.iter().map(|x| u128::from(x.amount())).sum();
                ensure!(total >= u128::from(n), "Selected notes do not cover the amount");
                let change = u64::try_from(total - u128::from(n))?;
                let reserved = notes.iter().map(|x| hex::encode(x.commit().0.to_bytes())).collect::<Vec<_>>();
                let (wire, kind) = match txt(q, "kind")? {
                    "send" => {
                        let to = Address::from_str(txt(q, "to")?).map_err(|e| anyhow::anyhow!("Token address: {e}"))?;
                        let pk = self.normal_pk.as_ref().context("Transfer proving key not loaded")?;
                        let prepared = xm3::prepare(ledger, key, &notes, &[(to, xm3::value(asset, n)), (xm3::address(key), xm3::value(asset, change))])?;
                        (xm3::prove(prepared, pk, key, &p.domain)?.encode(), "send")
                    }
                    "redeem" => {
                        let binding = bytes32(txt(q, "binding")?)?;
                        let pk = self.boundary_pk.as_ref().context("Boundary proving key not loaded")?;
                        let prepared = boundary::prepare_redeem(ledger, key, &notes, n, binding)?;
                        (boundary::prove(prepared, pk, key, &p.domain, None)?.encode(), "redeem")
                    }
                    other => anyhow::bail!("Unknown build kind {other}"),
                };
                // Self-check against our own replica before anything leaves.
                let mut candidate = self.pool()?.clone();
                let check = candidate.apply(Some(&wire), [0; 32], self.tip, &p.normal_vk, &p.boundary_vk, &p.issuer_vk);
                ensure!(check["record"] == "accepted", "Built record fails local admission: {}", check["error"]);
                Ok(json!({"kind":kind,"wire":hex::encode(&wire),"recordId":hex::encode(xm3::hash(&wire)),"bytes":wire.len(),"inputs":notes.len(),"amount":n.to_string(),"change":change.to_string(),"reserved":reserved,"asset":hex::encode(asset.to_bytes())}))
            }
            "verify" => {
                let p = self.params()?;
                let wire = hex::decode(txt(q, "wire")?)?;
                let mut candidate = self.pool()?.clone();
                Ok(candidate.apply(Some(&wire), [0; 32], self.tip, &p.normal_vk, &p.boundary_vk, &p.issuer_vk))
            }
            "close" => {
                self.key = None;
                self.fvk = None;
                self.native = None;
                Ok(json!({"closed":true}))
            }
            other => anyhow::bail!("Unknown engine op {other}"),
        }
    }
}

// ------------------------------------------------------------ C ABI
thread_local! {
    static ENGINE: RefCell<Engine> = RefCell::new(Engine::default());
    static OUT: RefCell<Vec<u8>> = RefCell::new(Vec::new());
    static PANIC: RefCell<String> = RefCell::new(String::new());
}
fn respond(v: J) -> u32 {
    OUT.with(|o| {
        let mut o = o.borrow_mut();
        *o = v.to_string().into_bytes();
        o.len() as u32
    })
}
#[no_mangle]
pub extern "C" fn xmr20_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}
#[no_mangle]
pub unsafe extern "C" fn xmr20_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}
#[no_mangle]
pub extern "C" fn xmr20_out_ptr() -> *const u8 {
    OUT.with(|o| o.borrow().as_ptr())
}
#[no_mangle]
pub extern "C" fn xmr20_init() {
    std::panic::set_hook(Box::new(|info| {
        PANIC.with(|p| *p.borrow_mut() = info.to_string());
    }));
}
#[no_mangle]
pub extern "C" fn xmr20_panic_len() -> u32 {
    PANIC.with(|p| p.borrow().len() as u32)
}
#[no_mangle]
pub extern "C" fn xmr20_panic_ptr() -> *const u8 {
    PANIC.with(|p| p.borrow().as_ptr())
}
// JSON request in, JSON response out ({"result":..} or {"error":..}); returns the
// response length; bytes at xmr20_out_ptr(). The request buffer is freed here.
#[no_mangle]
pub unsafe extern "C" fn xmr20_call(ptr: *mut u8, len: usize) -> u32 {
    let req = Vec::from_raw_parts(ptr, len, len);
    let out = match serde_json::from_slice::<J>(&req) {
        Ok(q) => ENGINE.with(|e| match e.borrow_mut().call(&q) {
            Ok(r) => json!({"result":r}),
            Err(err) => json!({"error":err.to_string()}),
        }),
        Err(err) => json!({"error":format!("Request JSON: {err}")}),
    };
    respond(out)
}
// Binary parameter upload (proving keys): slot 0 = transfer, 1 = boundary.
#[no_mangle]
pub unsafe extern "C" fn xmr20_blob(slot: u32, ptr: *mut u8, len: usize) -> u32 {
    let bytes = Vec::from_raw_parts(ptr, len, len);
    let out = ENGINE.with(|e| match e.borrow_mut().set_blob(slot, &bytes) {
        Ok(r) => json!({"result":r}),
        Err(err) => json!({"error":err.to_string()}),
    });
    respond(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    const SET: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../params/test-v1/");
    const OTHER: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../params/test-other/");
    fn manifest(dir: &str) -> Manifest {
        serde_json::from_slice(&std::fs::read(format!("{dir}manifest.json")).unwrap()).unwrap()
    }
    // The parameter tests need the generated test sets (params/test-v1, params/test-other: 147 MB of
    // disposable proving keys, generated once with the lab `setup`; not shipped in public copies).
    fn params_present() -> bool {
        let ok = std::path::Path::new(SET).join("normal.public-pk").exists() && std::path::Path::new(OTHER).join("normal.public-pk").exists();
        if !ok {
            eprintln!("SKIPPED: parameter sets not present (see docs/REPRODUCE.txt to generate params/test-v1 and params/test-other)");
        }
        ok
    }
    fn engine_with_params() -> Engine {
        let mut e = Engine::default();
        e.call(&json!({"op":"params","manifest":manifest(SET)})).unwrap();
        e
    }
    // Offset of a_query[0] inside the uncompressed ProvingKey serialization:
    // vk, beta_g1, delta_g1, then the a_query vector (8-byte length prefix).
    fn a_query_offset(pk: &ProvingKey<Bls12_377>) -> usize {
        let mut vk = vec![];
        pk.vk.serialize_uncompressed(&mut vk).unwrap();
        let mut g1 = vec![];
        pk.beta_g1.serialize_uncompressed(&mut g1).unwrap();
        vk.len() + 2 * g1.len() + 8
    }
    #[test]
    fn shipped_manifest_authenticates_the_real_files_and_server_config_must_match() {
        if !params_present() {
            return;
        }
        let m = manifest(SET);
        let d = m.validate().unwrap();
        assert_eq!(hex::encode(d), m.ledger_domain);
        let mut e = Engine::default();
        // Server config identical -> accepted; other setup's config -> refused.
        let served: Config = serde_json::from_slice(&std::fs::read(format!("{SET}parameters.json")).unwrap()).unwrap();
        e.call(&json!({"op":"params","manifest":m,"served":served})).unwrap();
        let other: Config = serde_json::from_slice(&std::fs::read(format!("{OTHER}parameters.json")).unwrap()).unwrap();
        let err = e.call(&json!({"op":"params","manifest":manifest(SET),"served":other})).unwrap_err().to_string();
        assert!(err.contains("different ledger or version"), "{err}");
        // No manifest at all -> refused (a server-supplied config is not a trust anchor).
        let err = e.call(&json!({"op":"params","config":manifest(SET).config})).unwrap_err().to_string();
        assert!(err.contains("manifest required"), "{err}");
        // Tampered manifest fields are detected.
        let mut bad = manifest(SET);
        bad.protocol.domain_label = "XMR20-SOMETHING-ELSE-v2".into();
        assert!(bad.validate().unwrap_err().to_string().contains("protocol domain"));
        let mut bad = manifest(SET);
        bad.config.issuer_vk = manifest(OTHER).config.issuer_vk;
        assert!(bad.validate().is_err());
        // Genuine files are accepted (boundary slot checked here; the transfer file is exercised below).
        let mut e = engine_with_params();
        let b = std::fs::read(format!("{SET}boundary.public-pk")).unwrap();
        let r = e.set_blob(1, &b).unwrap();
        assert_eq!(r["authenticated"], true);
        assert_eq!(r["sha256"], manifest(SET).files.boundary.sha256);
        assert!(e.proving_key_loaded(1));
    }
    #[test]
    fn missing_truncated_substituted_and_foreign_files_are_rejected_before_parsing() {
        if !params_present() {
            return;
        }
        let mut e = engine_with_params();
        let normal = std::fs::read(format!("{SET}normal.public-pk")).unwrap();
        let boundary = std::fs::read(format!("{SET}boundary.public-pk")).unwrap();
        // Empty (missing) file.
        assert!(e.set_blob(0, &[]).unwrap_err().to_string().contains("0 bytes received"));
        // Truncated by one byte / by half.
        assert!(e.set_blob(0, &normal[..normal.len() - 1]).unwrap_err().to_string().contains("truncated"));
        assert!(e.set_blob(0, &normal[..normal.len() / 2]).unwrap_err().to_string().contains("truncated"));
        // Padded.
        let mut padded = normal.clone();
        padded.push(0);
        assert!(e.set_blob(0, &padded).is_err());
        // Substituted: the boundary file in the transfer slot and vice versa.
        assert!(e.set_blob(0, &boundary).is_err());
        assert!(e.set_blob(1, &normal).is_err());
        // Foreign: the other setup's transfer key has the SAME length; only the hash catches it.
        let foreign = std::fs::read(format!("{OTHER}normal.public-pk")).unwrap();
        assert_eq!(foreign.len(), normal.len());
        let err = e.set_blob(0, &foreign).unwrap_err().to_string();
        assert!(err.contains("sha256") && err.contains("not used"), "{err}");
        assert!(!e.proving_key_loaded(0), "nothing was loaded by any rejected file");
        // Build must fail without a loaded key (rejection happens before any proof).
        let err = e.call(&json!({"op":"build","kind":"send","to":"penumbra1x","amount":"1","notes":[]})).unwrap_err().to_string();
        assert!(!err.is_empty());
        // The genuine file is then accepted.
        assert!(e.set_blob(0, &normal).is_ok());
        assert!(e.proving_key_loaded(0));
    }
    #[test]
    fn altered_query_vector_with_the_expected_verifying_key_is_rejected_and_would_have_broken_proofs() {
        if !params_present() {
            return;
        }
        let normal = std::fs::read(format!("{SET}normal.public-pk")).unwrap();
        let honest: ProvingKey<Bls12_377> = ProvingKey::deserialize_uncompressed_unchecked(normal.as_slice()).unwrap();
        // Flip one byte inside a_query[5]; the verifying key bytes are untouched.
        let at = a_query_offset(&honest) + 5 * 96 + 7;
        let mut tampered_bytes = normal.clone();
        tampered_bytes[at] ^= 0x40;
        let tampered: ProvingKey<Bls12_377> = ProvingKey::deserialize_uncompressed_unchecked(tampered_bytes.as_slice()).unwrap();
        assert_eq!(tampered.vk, honest.vk, "the embedded verifying key is still the expected one");
        assert_ne!(tampered.a_query[5], honest.a_query[5], "a query-vector element changed");
        // The previous candidate's check (embedded vk == pinned vk) would accept this
        // file. The manifest check refuses it before parsing.
        let mut e = engine_with_params();
        let err = e.set_blob(0, &tampered_bytes).unwrap_err().to_string();
        assert!(err.contains("sha256"), "{err}");
        assert!(!e.proving_key_loaded(0));
        // Why it matters: proofs made with the altered key do not verify (and an
        // adversarial key can be chosen to leak witness bits through such proofs).
        let m = manifest(SET);
        let domain = m.validate().unwrap();
        let vk = xm3::read_vk(&hex::decode(&m.config.normal_vk).unwrap()).unwrap();
        let k = xm3::fresh_key();
        let n = Note::generate(&mut rand_core::OsRng, &xm3::address(&k), xm3::value(xm3::test_asset(), 1000));
        let ledger = xm3::Ledger::new(domain, &[xm3::Payload::encrypt(&n).unwrap()]).unwrap();
        let payments = [(xm3::address(&k), xm3::value(xm3::test_asset(), 400)), (xm3::address(&k), xm3::value(xm3::test_asset(), 600))];
        let good = xm3::prove(xm3::prepare(&ledger, &k, &[n.clone()], &payments).unwrap(), &honest, &k, &domain).unwrap();
        good.verify_proof(&vk).unwrap();
        let bad = xm3::prove(xm3::prepare(&ledger, &k, &[n], &payments).unwrap(), &tampered, &k, &domain).unwrap();
        assert!(bad.verify_proof(&vk).is_err(), "proof from the altered proving key must not verify");
    }
    #[test]
    fn derivation_is_deterministic_domain_separated_and_one_way_in_form() {
        let root = [7u8; 32];
        let a = derive_token_spend_key(&root, 0);
        let b = derive_token_spend_key(&root, 0);
        let c = derive_token_spend_key(&root, 1);
        let d = derive_token_spend_key(&[8u8; 32], 0);
        assert_eq!(*a, *b);
        assert_ne!(*a, *c);
        assert_ne!(*a, *d);
        assert_ne!(*a, root, "token key is not the native key");
    }
    #[test]
    fn engine_derives_and_exports_only_public_data() {
        let mut e = Engine::default();
        let r = e.call(&json!({"op":"derive","root":hex::encode([9u8;32]),"account":0})).unwrap();
        assert!(r["tokenAddress"].as_str().unwrap().starts_with("penumbra1"));
        let s = r.to_string();
        assert!(!s.contains(&hex::encode([9u8; 32])));
        let vk = e.call(&json!({"op":"viewingKey"})).unwrap();
        let mut v = Engine::default();
        let o = v.call(&json!({"op":"openViewing","viewingKey":vk["viewingKey"]})).unwrap();
        assert_eq!(o["tokenAddress"], r["tokenAddress"]);
        assert!(v.key().is_err(), "viewing engine cannot spend");
    }
}
