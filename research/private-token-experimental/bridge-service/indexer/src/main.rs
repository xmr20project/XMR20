//! Persistent incremental indexer (stdio JSON service). Replaces the lab's replay-everything-on-every-scan indexer role
//! for long-running operation. Same admission rules (the reviewed core Pool), same trusted-manifest parameter
//! authentication (the format crate's Params), plus:
//!   - append-only STATE LOG in --state <dir>: blocks.jsonl {height, hash} and records.jsonl {height, txid, wire}
//!     (only records the framing recognised; their admission result is recomputed on replay) and meta.json;
//!   - restart: the pool is rebuilt from the record log (no block is fetched again), then syncing continues at the stored tip;
//!   - reorganisation: the stored tip hash is compared with the daemon's; on a mismatch the fork point is found by walking back
//!     over stored hashes, both logs are truncated at the fork (atomic rewrite), the pool is rebuilt and syncing resumes;
//!   - every sync verifies the hash chain (each new block's previous hash equals the stored one) and that the daemon's
//!     network and genesis are the manifest's. Mainnet is refused unless the manifest says so (it never does in this candidate).
//! Ops: sync · status · summary · owner · record · tx · verify · view · events · close
use anyhow::{ensure, Context, Result};
use monero_wallet::interface::prelude::*;
use penumbra_sdk_keys::FullViewingKey;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as J};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, BufRead, Write},
    path::{Path, PathBuf},
    str::FromStr,
};
use xmr20_unshielded_core::{self as core, keys::owner_vk, pool::Pool};
use xmr20_unshielded_lab::{chain::Params, native};

fn txt<'a>(v: &'a J, k: &str) -> Result<&'a str> {
    v[k].as_str().context(format!("Text field {k}"))
}
#[derive(Serialize, Deserialize, Clone)]
struct BlockRow {
    height: u64,
    hash: String,
}
#[derive(Serialize, Deserialize, Clone)]
struct RecordRow {
    height: u64,
    txid: String,
    wire: String,
}
#[derive(Serialize, Deserialize, Clone)]
struct Meta {
    domain: String,
    manifest_sha256: String,
    network: String,
    genesis: String,
    start_height: u64,
}
#[derive(Clone, Serialize)]
struct RecordInfo {
    height: u64,
    txid: String,
    record: String,
    kind: J,
    error: Option<String>,
    detail: J,
}
struct Follower {
    dir: PathBuf,
    blocks: Vec<BlockRow>,
    records: Vec<RecordRow>,
    pool: Pool,
    index: BTreeMap<String, RecordInfo>,
    by_tx: BTreeMap<String, String>,
    events: Vec<J>,
    start: u64,
}
fn read_lines<T: for<'a> Deserialize<'a>>(p: &Path) -> Result<Vec<T>> {
    if !p.exists() {
        return Ok(vec![]);
    }
    let mut out = vec![];
    for (i, line) in fs::read_to_string(p)?.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str(line).with_context(|| format!("{}:{}", p.display(), i + 1))?);
    }
    Ok(out)
}
fn write_lines<T: Serialize>(p: &Path, rows: &[T]) -> Result<()> {
    let tmp = p.with_extension("jsonl.tmp");
    {
        let mut f = io::BufWriter::new(fs::File::create(&tmp)?);
        for r in rows {
            serde_json::to_writer(&mut f, r)?;
            f.write_all(b"\n")?;
        }
        f.flush()?;
        f.get_ref().sync_all()?;
    }
    fs::rename(&tmp, p)?;
    Ok(())
}
fn append_line<T: Serialize>(p: &Path, row: &T) -> Result<()> {
    let mut f = fs::OpenOptions::new().create(true).append(true).open(p)?;
    serde_json::to_writer(&mut f, row)?;
    f.write_all(b"\n")?;
    f.sync_data()?;
    Ok(())
}
impl Follower {
    fn open(dir: &Path, p: &Params) -> Result<Self> {
        fs::create_dir_all(dir)?;
        let meta_path = dir.join("meta.json");
        let meta = Meta { domain: p.config.domain.clone(), manifest_sha256: p.manifest_sha256.clone(), network: p.manifest.network.kind.clone(), genesis: p.manifest.network.genesis.clone(), start_height: p.manifest.network.start_height };
        if meta_path.exists() {
            let old: Meta = serde_json::from_slice(&fs::read(&meta_path)?)?;
            ensure!(old.domain == meta.domain && old.genesis == meta.genesis && old.network == meta.network, "State directory {} belongs to another ledger (domain {}…) — refusing to mix", dir.display(), &old.domain[..16]);
            if old.manifest_sha256 != meta.manifest_sha256 {
                eprintln!("note: trusted manifest changed (same ledger domain); continuing the stored state");
            }
        } else {
            fs::write(&meta_path, serde_json::to_vec_pretty(&meta)?)?;
        }
        let blocks: Vec<BlockRow> = read_lines(&dir.join("blocks.jsonl"))?;
        let records: Vec<RecordRow> = read_lines(&dir.join("records.jsonl"))?;
        let mut f = Self { dir: dir.to_path_buf(), blocks, records, pool: Pool::new(p.domain), index: BTreeMap::new(), by_tx: BTreeMap::new(), events: vec![], start: p.manifest.network.start_height.max(1) };
        f.rebuild(p)?;
        Ok(f)
    }
    /// Rebuild the pool from the record log (every record re-verified; results recomputed).
    fn rebuild(&mut self, p: &Params) -> Result<()> {
        self.pool = Pool::new(p.domain);
        self.index.clear();
        self.by_tx.clear();
        let rows = self.records.clone();
        for r in &rows {
            self.apply_row(r, p);
        }
        Ok(())
    }
    fn apply_row(&mut self, r: &RecordRow, p: &Params) -> J {
        let wire = hex::decode(&r.wire).unwrap_or_default();
        let result = self.pool.apply(Some(&wire), &r.txid, r.height, &p.vks);
        let id = hex::encode(core::hash(&wire));
        let info = RecordInfo { height: r.height, txid: r.txid.clone(), record: result["record"].as_str().unwrap_or("?").into(), kind: result["kind"].clone(), error: result["error"].as_str().map(String::from), detail: result["detail"].clone() };
        // a completed two-part operation also settles the counterpart recorded earlier
        if result["detail"]["completed"] == true {
            for k in ["part_a", "part_b"] {
                if let Some(other) = result["detail"]["completion"][k].as_str() {
                    if other != id {
                        if let Some(x) = self.index.get_mut(other) {
                            x.record = "accepted".into();
                            x.detail["completed"] = json!(true);
                            x.detail["completion"] = result["detail"]["completion"].clone();
                        }
                    }
                }
            }
        }
        self.index.insert(id.clone(), info);
        self.by_tx.insert(r.txid.clone(), id.clone());
        json!({"height":r.height,"txid":r.txid,"recordId":id,"result":result})
    }
    fn tip(&self) -> Option<&BlockRow> {
        self.blocks.last()
    }
    /// Incremental sync: detect a reorganisation at the stored tip, truncate, then fetch and apply new blocks one by one.
    async fn sync(&mut self, rpc: &native::Rpc, p: &Params, max_blocks: usize) -> Result<J> {
        native::guard(rpc, &p.manifest.network.kind).await?;
        ensure!(hex::encode(rpc.block_by_number(0).await?.hash()) == p.config.chain, "Wrong chain");
        let daemon_tip = rpc.latest_block_number().await? as u64;
        let mut reorg = J::Null;
        // 1. reorganisation check: walk back from the stored tip until a stored hash equals the daemon's hash at that height
        if let Some(t) = self.tip().cloned() {
            let mut fork: Option<u64> = None;
            let mut depth = 0usize;
            let mut h = t.height.min(daemon_tip);
            loop {
                let stored = self.blocks.iter().rev().find(|b| b.height == h);
                let Some(stored) = stored else { break };
                let live = hex::encode(rpc.block_by_number(h as usize).await?.hash());
                if live == stored.hash {
                    fork = Some(h);
                    break;
                }
                depth += 1;
                if h == self.start - 1 || h == 0 || depth > 10_000 {
                    break;
                }
                h -= 1;
            }
            let fork_h = fork.unwrap_or(self.start - 1);
            if fork_h < t.height {
                let removed_blocks = self.blocks.iter().filter(|b| b.height > fork_h).count();
                let removed_records = self.records.iter().filter(|r| r.height > fork_h).count();
                self.blocks.retain(|b| b.height <= fork_h);
                self.records.retain(|r| r.height <= fork_h);
                write_lines(&self.dir.join("blocks.jsonl"), &self.blocks)?;
                write_lines(&self.dir.join("records.jsonl"), &self.records)?;
                self.rebuild(p)?;
                reorg = json!({"forkHeight":fork_h,"previousTip":t.height,"removedBlocks":removed_blocks,"removedRecords":removed_records});
                self.events.push(json!({"at":now(),"event":"reorganisation","detail":reorg}));
            }
        }
        // 2. fetch forward
        let mut next = self.tip().map(|b| b.height + 1).unwrap_or(self.start);
        let mut previous = match self.tip() {
            Some(b) => hex::decode(&b.hash)?.try_into().map_err(|_| anyhow::anyhow!("hash"))?,
            None => {
                if next >= 1 {
                    rpc.block_by_number(next as usize - 1).await?.hash()
                } else {
                    [0u8; 32]
                }
            }
        };
        let mut applied = vec![];
        let mut fetched = 0usize;
        while next <= daemon_tip && fetched < max_blocks {
            let b = rpc.block_by_number(next as usize).await?;
            ensure!(b.number() == next as usize, "Daemon height mismatch");
            if b.header.previous != previous {
                // the chain moved under us: stop here, the next sync's reorganisation check sorts it out
                self.events.push(json!({"at":now(),"event":"previous-hash-mismatch","height":next}));
                break;
            }
            let scan = rpc.expand_to_scannable_block(b.clone()).await?;
            for (id, tx) in b.transactions.iter().zip(&scan.transactions) {
                if let Ok(Some(wire)) = core::transport::unframe(&tx.prefix().extra) {
                    let row = RecordRow { height: next, txid: hex::encode(id), wire: hex::encode(&wire) };
                    append_line(&self.dir.join("records.jsonl"), &row)?;
                    self.records.push(row.clone());
                    let r = self.apply_row(&row, p);
                    applied.push(r);
                }
            }
            let hash = b.hash();
            let row = BlockRow { height: next, hash: hex::encode(hash) };
            append_line(&self.dir.join("blocks.jsonl"), &row)?;
            self.blocks.push(row);
            previous = hash;
            next += 1;
            fetched += 1;
        }
        Ok(json!({"tip":self.tip().map(|b|b.height),"tipHash":self.tip().map(|b|b.hash.clone()),"daemonTip":daemon_tip,"behind":daemon_tip.saturating_sub(self.tip().map(|b|b.height).unwrap_or(self.start-1)),"fetched":fetched,"applied":applied,"reorg":reorg}))
    }
    fn status(&self, p: &Params) -> J {
        let (ok, rows) = self.pool.invariant();
        json!({"tip":self.tip().map(|b|b.height),"tipHash":self.tip().map(|b|b.hash.clone()),"startHeight":self.start,"blocks":self.blocks.len(),"records":self.records.len(),"network":p.manifest.network.kind,"domain":p.config.domain,"manifestSha256":p.manifest_sha256,"invariant":{"ok":ok,"rows":rows},"pendingParts":self.pool.pending_records,"completedOperations":self.pool.completed.len(),"events":self.events.len()})
    }
    fn confirmations(&self, height: u64) -> u64 {
        self.tip().map(|t| t.height + 1 - height).unwrap_or(0)
    }
}
fn now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap();
    format!("{}", d.as_secs())
}
async fn dispatch(f: &mut Follower, rpc: &native::Rpc, p: &Params, q: &J) -> Result<J> {
    match txt(q, "op")? {
        "sync" => f.sync(rpc, p, q["maxBlocks"].as_u64().unwrap_or(500) as usize).await,
        "status" => Ok(f.status(p)),
        "summary" => Ok(json!({"tip":f.tip().map(|b|b.height),"state":f.pool.summary()})),
        "owner" => {
            let o: [u8; 32] = hex::decode(txt(q, "owner")?)?.try_into().map_err(|_| anyhow::anyhow!("owner key"))?;
            owner_vk(&o)?;
            let notes = f.pool.notes_of_owner(&o);
            Ok(json!({"owner":hex::encode(o),"balances":f.pool.public_balances(&o).iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"notes":notes.iter().map(|(id,n)|json!({"id":id,"asset":n.asset,"amount":n.amount.to_string(),"height":n.height,"txid":n.txid,"confirmations":f.confirmations(n.height)})).collect::<Vec<_>>(),"tip":f.tip().map(|b|b.height)}))
        }
        "record" => {
            let id = txt(q, "id")?;
            Ok(match f.index.get(id) {
                Some(r) => json!({"found":true,"recordId":id,"height":r.height,"txid":r.txid,"record":r.record,"kind":r.kind,"error":r.error,"detail":r.detail,"confirmations":f.confirmations(r.height)}),
                None => json!({"found":false,"recordId":id}),
            })
        }
        "tx" => {
            let txid = txt(q, "txid")?;
            Ok(match f.by_tx.get(txid).and_then(|id| f.index.get(id).map(|r| (id.clone(), r.clone()))) {
                Some((id, r)) => json!({"found":true,"txid":txid,"recordId":id,"height":r.height,"record":r.record,"kind":r.kind,"error":r.error,"detail":r.detail,"confirmations":f.confirmations(r.height)}),
                None => json!({"found":false,"txid":txid}),
            })
        }
        "verify" => {
            let wire = hex::decode(txt(q, "wire")?)?;
            let mut candidate = f.pool.clone();
            Ok(candidate.apply(Some(&wire), &hex::encode([0u8; 32]), f.tip().map(|b| b.height + 1).unwrap_or(1), &p.vks))
        }
        // Explicit viewing access: shielded balances for a full viewing key handed over by the holder. Nothing is stored.
        "view" => {
            let fvk = FullViewingKey::from_str(txt(q, "viewingKey")?).map_err(|e| anyhow::anyhow!("Viewing key: {e}"))?;
            Ok(json!({"balances":f.pool.shielded_balances(&fvk).iter().map(|(a,v)|(a.clone(),v.to_string())).collect::<BTreeMap<_,_>>(),"notes":f.pool.ledger.unspent_notes(&fvk).len(),"tip":f.tip().map(|b|b.height)}))
        }
        "events" => Ok(json!({"events":f.events})),
        "records" => {
            let from = q["from"].as_u64().unwrap_or(0);
            let rows: Vec<J> = f.index.iter().filter(|(_, r)| r.height >= from).map(|(id, r)| json!({"recordId":id,"height":r.height,"txid":r.txid,"record":r.record,"kind":r.kind,"confirmations":f.confirmations(r.height)})).collect();
            Ok(json!({"records":rows}))
        }
        "publishBlob" => {
            native::guard(rpc, &p.manifest.network.kind).await?;
            let tx = native::decode(txt(q, "blob")?)?;
            rpc.publish_transaction(&tx).await?;
            Ok(json!({"txid":hex::encode(tx.hash())}))
        }
        "asset" => {
            let id = core::asset_for_mint(txt(q, "mint")?)?;
            Ok(json!({"asset":hex::encode(id.to_bytes())}))
        }
        other => anyhow::bail!("Unknown indexer op {other}"),
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    ensure!(std::env::var("XMR20_INTEGRATION_LAB").as_deref() == Ok("offline-synthetic-only") || std::env::var("XMR20_INDEXER_SERVICE").as_deref() == Ok("1"), "Set XMR20_INDEXER_SERVICE=1 (or the lab variable) to run");
    let args: Vec<String> = std::env::args().collect();
    let dir = Path::new(args.get(1).context("parameter directory")?);
    let arg = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1).cloned());
    let trusted = arg("--trusted-manifest").context("--trusted-manifest <path> is required")?;
    let state = arg("--state").context("--state <dir> is required")?;
    let p = Params::load(dir, false, Path::new(&trusted))?;
    let mut rpc = native::rpc(&p.manifest.network.kind).await?;
    {
        let genesis = hex::encode(rpc.block_by_number(0).await?.hash());
        ensure!(genesis == p.manifest.network.genesis, "Daemon genesis {}… is not the trusted manifest's network {}…", &genesis[..16], &p.manifest.network.genesis[..16]);
    }
    let mut f = Follower::open(Path::new(&state), &p)?;
    println!("{}", json!({"ready":true,"mode":"indexer-service","domain":p.config.domain,"network":p.manifest.network.kind,"trustedManifest":{"label":p.manifest.label,"sha256":p.manifest_sha256},"state":{"dir":state,"tip":f.tip().map(|b|b.height),"blocks":f.blocks.len(),"records":f.records.len()}}));
    let stdout = io::stdout();
    for line in io::stdin().lock().lines() {
        let line = line?;
        ensure!(line.len() < 2_000_000);
        let q: J = serde_json::from_str(&line)?;
        if q["op"] == "close" {
            break;
        }
        let mut attempt = dispatch(&mut f, &rpc, &p, &q).await;
        if attempt.as_ref().is_err_and(|e| e.to_string().contains("interface error")) {
            if let Ok(fresh) = native::rpc(&p.manifest.network.kind).await {
                rpc = fresh;
                attempt = dispatch(&mut f, &rpc, &p, &q).await;
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
