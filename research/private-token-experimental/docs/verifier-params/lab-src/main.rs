//! Three independent process roles over stdin JSON, each replaying the public
//! chain itself: `wallet` (one holder, encrypted vault, spends), `indexer`
//! (public state plus viewing-key balances, cannot spend), `issuer` (single
//! operator credits). Synthetic keys only; offline zero-peer fakechain only.
use anyhow::{ensure, Context, Result};
use ark_serialize::CanonicalSerialize;
use decaf377_rdsa::{SigningKey, SpendAuth, VerificationKey};
use monero_wallet::interface::prelude::*;
use penumbra_sdk_keys::{
    keys::{SpendKey, SpendKeyBytes},
    Address, FullViewingKey,
};
use penumbra_sdk_shielded_pool::Note;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as J};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, BufRead, Write},
    path::Path,
    str::FromStr,
};
use penumbra_sdk_asset::asset;
use xmr20_integration_lab::{
    boundary,
    chain::{Chain, Params},
    legacy_sign, native, vault, Config,
};
use xmr20_multi_input_lab as xm3;
use zeroize::Zeroizing;

fn txt<'a>(v: &'a J, k: &str) -> Result<&'a str> {
    v[k].as_str().context(format!("Text field {k}"))
}
fn bytes32(s: &str) -> Result<[u8; 32]> {
    hex::decode(s)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("32-byte field"))
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
fn address(s: &str) -> Result<Address> {
    Address::from_str(s).map_err(|e| anyhow::anyhow!("Token address: {e}"))
}
fn carrier_json(tx: &monero_wallet::transaction::Transaction, wire: &[u8]) -> Result<J> {
    Ok(json!({"wire":hex::encode(wire),"blob":hex::encode(tx.serialize()),"txid":hex::encode(tx.hash()),"extraBytes":tx.prefix().extra.len(),"nativeBytes":tx.serialize().len(),"fee":native::fee(tx)?.to_string(),"nativeImages":native::images(tx).iter().map(hex::encode).collect::<Vec<_>>()}))
}

// ---------------------------------------------------------------- setup
#[derive(Serialize, Deserialize)]
struct IssuerSecret {
    pool_seed: [u8; 32],
    signing: [u8; 32],
    native_spend: [u8; 32],
    native_view: [u8; 32],
}
fn setup(dir: &Path, chain: String) -> Result<()> {
    ensure!(!dir.exists());
    fs::create_dir(dir)?;
    let k = xm3::fresh_key();
    let n = Note::generate(&mut OsRng, &xm3::address(&k), xm3::value(xm3::test_asset(), 1000));
    let l = xm3::Ledger::new([0; 32], &[xm3::Payload::encrypt(&n)?])?;
    let p = xm3::prepare(&l, &k, &[n.clone()], &[(xm3::address(&k), n.value()), (xm3::address(&k), xm3::value(xm3::test_asset(), 0))])?;
    let (normal, nvk, _) = xm3::setup(p.circuit)?;
    let p = boundary::prepare_credit(&l, &k, &xm3::address(&k), xm3::test_asset(), 1000, boundary::KIND_DEPOSIT, [1; 32])?;
    let (bound, bvk, _) = boundary::setup(p.circuit)?;
    let issuer_key = xm3::fresh_key();
    let issuer_sign = SigningKey::<SpendAuth>::new(OsRng);
    let issuer_native = native::Wallet::new();
    let (native_spend, native_view) = issuer_native.secrets();
    let mut config = Config { chain, domain: String::new(), normal_vk: hex::encode(nvk), boundary_vk: hex::encode(bvk), issuer_vk: hex::encode(VerificationKey::from(&issuer_sign).to_bytes()) };
    config.domain = hex::encode(config.computed_domain()?);
    normal.serialize_uncompressed(io::BufWriter::new(fs::File::create(dir.join("normal.public-pk"))?))?;
    bound.serialize_uncompressed(io::BufWriter::new(fs::File::create(dir.join("boundary.public-pk"))?))?;
    fs::write(dir.join("parameters.json"), serde_json::to_vec_pretty(&config)?)?;
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(dir.join("issuer.secret.json"))?;
        f.write_all(&serde_json::to_vec(&IssuerSecret { pool_seed: issuer_key.to_bytes().0, signing: issuer_sign.to_bytes(), native_spend, native_view })?)?;
    }
    println!("{}", json!({"ready":true,"config":config,"issuerNativeAddress":issuer_native.address().to_string(),"normalPublicKeyBytes":normal.uncompressed_size(),"boundaryPublicKeyBytes":bound.uncompressed_size()}));
    Ok(())
}

// ---------------------------------------------------------------- wallet
#[derive(Serialize, Deserialize, Clone)]
struct Pending {
    kind: String,
    amount: String,
    wire: String,
    blob: String,
    status: String,
    // Note commitments consumed by this carrier; excluded from selection until
    // the carrier is confirmed or its record was rejected, so concurrent or
    // retried operations never build conflicting spends of the same notes.
    #[serde(default)]
    reserved: Vec<String>,
}
#[derive(Serialize, Deserialize)]
struct WalletFile {
    pool_seed: [u8; 32],
    native_spend: [u8; 32],
    native_view: [u8; 32],
    spent: Vec<String>,
    pending: BTreeMap<String, Pending>,
    sequence: u64,
}
impl Drop for WalletFile {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.pool_seed.zeroize();
        self.native_spend.zeroize();
        self.native_view.zeroize();
    }
}
struct WalletRole {
    key: SpendKey,
    native: native::Wallet,
    vault: vault::Vault,
    pending: BTreeMap<String, Pending>,
    sequence: u64,
    chain: Chain,
}
impl WalletRole {
    fn open(dir: &Path, p: &Params, path: &Path, create: bool) -> Result<Self> {
        let key = vault::unlock_pipe()?;
        let v = vault::Vault::new(path, key, p.domain);
        let _ = dir;
        if create {
            ensure!(!v.exists(), "Vault exists");
            let mut w = Self { key: xm3::fresh_key(), native: native::Wallet::new(), vault: v, pending: BTreeMap::new(), sequence: 0, chain: Chain::new(p.domain)? };
            w.save()?;
            Ok(w)
        } else {
            let bytes = v.load()?;
            let f: WalletFile = serde_json::from_slice(&bytes)?;
            let key: SpendKey = SpendKeyBytes(f.pool_seed).into();
            let mut native = native::Wallet::from_secrets(f.native_spend, f.native_view)?;
            for s in &f.spent {
                native.mark_spent(bytes32(s)?);
            }
            Ok(Self { key, native, vault: v, pending: f.pending.clone(), sequence: f.sequence, chain: Chain::new(p.domain)? })
        }
    }
    fn save(&mut self) -> Result<()> {
        self.sequence += 1;
        let (native_spend, native_view) = self.native.secrets();
        let f = WalletFile { pool_seed: self.key.to_bytes().0, native_spend, native_view, spent: self.native.spent_images().iter().map(hex::encode).collect(), pending: self.pending.clone(), sequence: self.sequence };
        let bytes = Zeroizing::new(serde_json::to_vec(&f)?);
        self.vault.save(&bytes)
    }
    fn fvk(&self) -> &FullViewingKey {
        self.key.full_viewing_key()
    }
    fn reserved(&self) -> std::collections::BTreeSet<[u8; 32]> {
        self.pending
            .values()
            .filter(|p| p.status != "confirmed" && p.status != "mined-record-rejected")
            .flat_map(|p| p.reserved.iter().filter_map(|h| bytes32(h).ok()))
            .collect()
    }
    // Largest-first over unreserved notes, at most three inputs.
    fn select(&self, asset: asset::Id, amount: u128) -> Result<Vec<Note>> {
        ensure!(amount > 0, "Positive amount required");
        let reserved = self.reserved();
        let mut notes = self
            .chain
            .pool
            .ledger
            .notes(self.fvk())
            .into_iter()
            .filter(|n| n.asset_id() == asset && u128::from(n.amount()) > 0 && !reserved.contains(&n.commit().0.to_bytes()))
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
    async fn refresh(&mut self, rpc: &native::Rpc, p: &Params) -> Result<J> {
        self.chain.scan(rpc, p).await?;
        self.native.refresh(rpc).await?;
        // Pending carriers that now appear in canonical history are settled;
        // records the pool rejected are reported, never silently dropped.
        let mut statuses = BTreeMap::new();
        for (txid, pend) in self.pending.iter_mut() {
            if let Some(c) = self.chain.confirmed(txid) {
                let rejected = self.chain.public["events"].as_array().unwrap().iter().any(|e| e["txid"] == *txid && e["result"]["record"] == "rejected");
                pend.status = if rejected { "mined-record-rejected".into() } else if c >= 10 { "confirmed".into() } else { format!("mined:{c}") };
            } else if pend.status == "confirmed" || pend.status.starts_with("mined") {
                pend.status = "orphaned".into();
            }
            statuses.insert(txid.clone(), pend.status.clone());
        }
        self.save()?;
        let notes = self.chain.pool.ledger.notes(self.fvk());
        let balances = self.chain.pool.balances(self.fvk());
        Ok(json!({"balances":balances.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"tokens":balances.values().sum::<u128>().to_string(),"notes":notes.len(),"noteAmounts":notes.iter().map(|n|json!({"asset":hex::encode(n.asset_id().to_bytes()),"amount":u128::from(n.amount()).to_string()})).collect::<Vec<_>>(),"native":self.native.balance().to_string(),"pending":statuses,"tip":self.chain.tip,"root":self.chain.public["state"]["root"]}))
    }
    async fn build(&mut self, rpc: &native::Rpc, wire: Vec<u8>, kind: &str, amount: u64, notes: &[Note], crash: Option<&str>) -> Result<J> {
        let tx = self.native.single(rpc, Some(&wire)).await?;
        let mut r = carrier_json(&tx, &wire)?;
        let txid = r["txid"].as_str().unwrap().to_string();
        if crash == Some("beforeSave") {
            // Simulated crash before any durable write: nothing of this carrier survives.
            std::process::exit(3);
        }
        let reserved = notes.iter().map(|n| hex::encode(n.commit().0.to_bytes())).collect();
        self.pending.insert(txid.clone(), Pending { kind: kind.into(), amount: amount.to_string(), wire: hex::encode(&wire), blob: hex::encode(tx.serialize()), status: "built".into(), reserved });
        self.save()?;
        if crash == Some("afterBuild") || crash == Some("afterSave") {
            // Simulated crash: durable state saved, no reply escapes.
            std::process::exit(3);
        }
        r["pendingId"] = json!(txid);
        Ok(r)
    }
    async fn handle(&mut self, rpc: &native::Rpc, p: &Params, q: &J) -> Result<J> {
        match txt(q, "op")? {
            "info" => Ok(json!({"tokenAddress":xm3::address(&self.key).to_string(),"nativeAddress":self.native.address().to_string(),"viewingKey":self.fvk().to_string(),"pending":self.pending.iter().map(|(k,v)|json!({"txid":k,"kind":v.kind,"amount":v.amount,"status":v.status})).collect::<Vec<_>>()})),
            "scan" => self.refresh(rpc, p).await,
            "send" => {
                self.refresh(rpc, p).await?;
                let to = address(txt(q, "to")?)?;
                let n = amount(q, "amount")?;
                let asset = asset_of(q)?;
                let notes = self.select(asset, u128::from(n))?;
                let total: u128 = notes.iter().map(|x| u128::from(x.amount())).sum();
                let change = u64::try_from(total - u128::from(n))?;
                let prepared = xm3::prepare(&self.chain.pool.ledger, &self.key, &notes, &[(to, xm3::value(asset, n)), (xm3::address(&self.key), xm3::value(asset, change))])?;
                let record = xm3::prove(prepared, p.normal.as_ref().context("prover")?, &self.key, &p.domain)?;
                let mut r = self.build(rpc, record.encode(), "send", n, &notes, q["crash"].as_str()).await?;
                r["inputs"] = json!(notes.len());
                r["change"] = json!(change.to_string());
                Ok(r)
            }
            "redeem" => {
                self.refresh(rpc, p).await?;
                let n = amount(q, "amount")?;
                let binding = bytes32(txt(q, "binding")?)?;
                let notes = self.select(asset_of(q)?, u128::from(n))?;
                let prepared = boundary::prepare_redeem(&self.chain.pool.ledger, &self.key, &notes, n, binding)?;
                let record = boundary::prove(prepared, p.bound.as_ref().context("prover")?, &self.key, &p.domain, None)?;
                let mut r = self.build(rpc, record.encode(), "redeem", n, &notes, q["crash"].as_str()).await?;
                r["inputs"] = json!(notes.len());
                Ok(r)
            }
            // Publish a pending carrier by id. Idempotent: already-published or
            // already-mined entries return their recorded state without a new submission.
            "publish" => {
                let id = txt(q, "pendingId")?.to_string();
                let pend = self.pending.get(&id).context("Unknown pending carrier")?.clone();
                if pend.status != "built" && pend.status != "orphaned" {
                    return Ok(json!({"txid":id,"status":pend.status,"resubmitted":false}));
                }
                native::guard(rpc).await?;
                let tx = native::decode(&pend.blob)?;
                rpc.publish_transaction(&tx).await?;
                if q["crash"] == "afterPublish" {
                    // Published but the status write never happened; resume must
                    // treat the daemon as the source of truth.
                    std::process::exit(3);
                }
                self.pending.get_mut(&id).unwrap().status = "published".into();
                self.save()?;
                Ok(json!({"txid":id,"status":"published","resubmitted":true,"extraBytes":tx.prefix().extra.len(),"fee":native::fee(&tx)?.to_string()}))
            }
            "carrier" => {
                let wire = hex::decode(txt(q, "wire")?)?;
                let tx = self.native.single(rpc, Some(&wire)).await?;
                self.save()?;
                carrier_json(&tx, &wire)
            }
            "tamper" => {
                let mut wire = hex::decode(txt(q, "wire")?)?;
                let at = q["offset"].as_u64().context("offset")? as usize;
                ensure!(at >= 4 && at < wire.len(), "Offset inside record body");
                wire[at] ^= 1;
                Ok(json!({"wire":hex::encode(wire)}))
            }
            "publishBlob" => {
                native::guard(rpc).await?;
                let tx = native::decode(txt(q, "blob")?)?;
                rpc.publish_transaction(&tx).await?;
                Ok(json!({"txid":hex::encode(tx.hash())}))
            }
            // Rehearsal scaffolding: a wallet restored from an older backup has no
            // memory of inputs another instance used; this marks one so the
            // conflicting-history tests exercise the TOKEN rule, not a native
            // double spend (which the daemon already rejects).
            // The wallet's own one-time output keys (owner-known public data) so a
            // legacy snapshot can be built from REAL wallet outputs.
            "outputs" => Ok(json!(self.native.all_outputs().iter().map(|(k,a,u)|json!({"key":k,"amount":a.to_string(),"unspent":u})).collect::<Vec<_>>())),
            // Legacy claim signature with the wallet's own derived output secret
            // (spend + key_offset). Monero generate_signature; no key image.
            "legacySign" => {
                let key = bytes32(txt(q, "outputKey")?)?;
                let hash = bytes32(txt(q, "messageHash")?)?;
                let secret = Zeroizing::new(self.native.output_secret(key).context("Not this wallet's output")?);
                let sig = legacy_sign::generate_signature(&hash, &secret);
                ensure!(legacy_sign::check_signature(&hash, &key, &sig), "Self-check failed");
                Ok(json!({"signature":hex::encode(sig),"outputKey":hex::encode(key)}))
            }
            "avoidNative" => {
                self.native.mark_spent(bytes32(txt(q, "image")?)?);
                self.save()?;
                Ok(json!({"avoided":true}))
            }
            other => anyhow::bail!("Unknown wallet op {other}"),
        }
    }
}

// ---------------------------------------------------------------- indexer
struct IndexerRole {
    chain: Chain,
}
impl IndexerRole {
    async fn handle(&mut self, rpc: &native::Rpc, p: &Params, q: &J) -> Result<J> {
        match txt(q, "op")? {
            "scan" => Ok(json!({"public":self.chain.scan(rpc, p).await?})),
            // Viewing access: balance/notes for a full viewing key. No spend
            // authority exists in this process; there is no send/redeem op.
            "view" => {
                let fvk = FullViewingKey::from_str(txt(q, "viewingKey")?).map_err(|e| anyhow::anyhow!("Viewing key: {e}"))?;
                ensure!(self.chain.public != J::Null, "Scan first");
                let notes = self.chain.pool.ledger.notes(&fvk);
                let balances = self.chain.pool.balances(&fvk);
                Ok(json!({"balances":balances.iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"tokens":balances.values().sum::<u128>().to_string(),"notes":notes.len(),"tip":self.chain.tip}))
            }
            "verify" => {
                let wire = hex::decode(txt(q, "wire")?)?;
                let mut candidate = self.chain.pool.clone();
                Ok(candidate.apply(Some(&wire), [0; 32], 0, &p.normal_vk, &p.boundary_vk, &p.issuer_vk))
            }
            "publishBlob" => {
                native::guard(rpc).await?;
                let tx = native::decode(txt(q, "blob")?)?;
                rpc.publish_transaction(&tx).await?;
                Ok(json!({"txid":hex::encode(tx.hash())}))
            }
            "send" | "redeem" | "credit" => anyhow::bail!("Indexer holds no spending or issuing key"),
            other => anyhow::bail!("Unknown indexer op {other}"),
        }
    }
}

// ---------------------------------------------------------------- issuer
struct IssuerRole {
    key: SpendKey,
    sign: SigningKey<SpendAuth>,
    native: native::Wallet,
    chain: Chain,
}
impl IssuerRole {
    async fn handle(&mut self, rpc: &native::Rpc, p: &Params, q: &J) -> Result<J> {
        match txt(q, "op")? {
            "scan" => {
                let public = self.chain.scan(rpc, p).await?;
                self.native.refresh(rpc).await?;
                Ok(json!({"public":public,"issuerNative":self.native.balance().to_string()}))
            }
            "credit" => {
                self.chain.scan(rpc, p).await?;
                let to = address(txt(q, "to")?)?;
                let kind = q["kind"].as_u64().context("kind")? as u8;
                let binding = bytes32(txt(q, "binding")?)?;
                let n = amount(q, "amount")?;
                let prepared = boundary::prepare_credit(&self.chain.pool.ledger, &self.key, &to, asset_of(q)?, n, kind, binding)?;
                let forged = SigningKey::<SpendAuth>::new(OsRng);
                let signer = if q["forgeIssuer"] == true { &forged } else { &self.sign };
                let record = boundary::prove(prepared, p.bound.as_ref().context("prover")?, &self.key, &p.domain, Some(signer))?;
                let wire = record.encode();
                let tx = self.native.single(rpc, Some(&wire)).await?;
                let mut r = carrier_json(&tx, &wire)?;
                r["recordId"] = json!(hex::encode(record.id()));
                Ok(r)
            }
            "publishBlob" => {
                native::guard(rpc).await?;
                let tx = native::decode(txt(q, "blob")?)?;
                rpc.publish_transaction(&tx).await?;
                Ok(json!({"txid":hex::encode(tx.hash())}))
            }
            other => anyhow::bail!("Unknown issuer op {other}"),
        }
    }
}

enum Role {
    Wallet(WalletRole),
    Indexer(IndexerRole),
    Issuer(IssuerRole),
}
async fn dispatch(role: &mut Role, rpc: &native::Rpc, p: &Params, q: &J) -> Result<J> {
    if q["op"] == "asset" {
        // Deterministic asset id from a lowercase alphanumeric base denom.
        let denom = txt(q, "denom")?;
        let id = asset::REGISTRY.parse_denom(denom).context("Unparseable denom")?.id();
        return Ok(json!({"asset":hex::encode(id.to_bytes()),"denom":denom}));
    }
    match role {
        Role::Wallet(w) => w.handle(rpc, p, q).await,
        Role::Indexer(i) => i.handle(rpc, p, q).await,
        Role::Issuer(i) => i.handle(rpc, p, q).await,
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    ensure!(std::env::var("XMR20_INTEGRATION_LAB").as_deref() == Ok("offline-synthetic-only"));
    rayon::ThreadPoolBuilder::new().num_threads(4).build_global()?;
    let args = std::env::args().collect::<Vec<_>>();
    let mode = args.get(1).context("Mode")?.clone();
    let dir = Path::new(args.get(2).context("Parameter directory")?);
    if mode == "setup" {
        return setup(dir, args.get(3).context("Chain genesis")?.clone());
    }
    // Verifier-side parameter authentication: a trusted manifest path independent of the parameter
    // directory is REQUIRED for every role; without it, or with any mismatch, the role never starts.
    let trusted = args.iter().position(|a| a == "--trusted-manifest").and_then(|i| args.get(i + 1)).context("--trusted-manifest <path> is required (no unauthenticated parameter loading)")?;
    let p = Params::load(dir, mode != "indexer", Path::new(trusted))?;
    let mut rpc = native::rpc().await?;
    // Network identity: the daemon's genesis must be the manifest's.
    {
        let genesis = hex::encode(rpc.block_by_number(0).await?.hash());
        ensure!(genesis == p.manifest.network.genesis, "Daemon genesis {}… is not the trusted manifest's network {}…", &genesis[..16], &p.manifest.network.genesis[..16]);
    }
    let mut role = match mode.as_str() {
        "wallet" => {
            let path = Path::new(args.get(3).context("Vault file")?);
            let create = args.get(4).map(|s| s == "create").unwrap_or(false);
            Role::Wallet(WalletRole::open(dir, &p, path, create)?)
        }
        "indexer" => Role::Indexer(IndexerRole { chain: Chain::new(p.domain)? }),
        "issuer" => {
            let secret: IssuerSecret = serde_json::from_slice(&fs::read(dir.join("issuer.secret.json"))?)?;
            let sign = SigningKey::<SpendAuth>::try_from(secret.signing)?;
            ensure!(VerificationKey::from(&sign) == p.issuer_vk, "Issuer key mismatch");
            Role::Issuer(IssuerRole { key: SpendKeyBytes(secret.pool_seed).into(), sign, native: native::Wallet::from_secrets(secret.native_spend, secret.native_view)?, chain: Chain::new(p.domain)? })
        }
        _ => anyhow::bail!("Unknown mode"),
    };
    let ready = match &role {
        Role::Wallet(w) => json!({"ready":true,"mode":"wallet","tokenAddress":xm3::address(&w.key).to_string(),"nativeAddress":w.native.address().to_string(),"viewingKey":w.fvk().to_string(),"pending":w.pending.len(),"sequence":w.sequence}),
        Role::Indexer(_) => json!({"ready":true,"mode":"indexer","domain":p.config.domain,"trustedManifest":{"label":p.manifest.label,"sha256":p.manifest_sha256}}),
        Role::Issuer(i) => json!({"ready":true,"mode":"issuer","issuerNativeAddress":i.native.address().to_string(),"issuerTokenAddress":xm3::address(&i.key).to_string(),"trustedManifest":{"label":p.manifest.label,"sha256":p.manifest_sha256}}),
    };
    println!("{ready}");
    let stdout = io::stdout();
    for line in io::stdin().lock().lines() {
        let line = line?;
        ensure!(line.len() < 2_000_000);
        let q: J = serde_json::from_str(&line)?;
        let mut attempt = dispatch(&mut role, &rpc, &p, &q).await;
        // A daemon restart leaves a dead pooled connection: rebuild the
        // transport once and retry. Any other error is returned as-is.
        if attempt.as_ref().is_err_and(|e| e.to_string().contains("interface error")) {
            if let Ok(fresh) = native::rpc().await {
                rpc = fresh;
                attempt = dispatch(&mut role, &rpc, &p, &q).await;
            }
        }
        let out = match attempt {
            Ok(result) => json!({"result":result}),
            Err(e) => json!({"error":e.to_string()}),
        };
        let mut lock = stdout.lock();
        lock.write_all(out.to_string().as_bytes())?;
        lock.write_all(b"\n")?;
        lock.flush()?;
    }
    Ok(())
}
#[allow(dead_code)]
fn _unused(_: &mut dyn RngCore) {}
