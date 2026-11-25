//! Review-only adversarial tests. All roots, issuers and balances here are synthetic.
//! No candidate code is modified; this crate calls the actual core library.
#[cfg(test)]
mod review {
    use ark_groth16::ProvingKey;
    use decaf377::{Bls12_377, Fr};
    use decaf377_rdsa::{Binding, SigningKey, SpendAuth, VerificationKey};
    use penumbra_sdk_asset::{asset, balance::Balance};
    use rand_core::OsRng;
    use serde_json::{json, Value};
    use std::sync::OnceLock;
    use xmr20_unshielded_core::{self as core, keys::*, penumbra::{self as pz, Circuit}, pool::{Pool,Vks}, public, shield, Config, PublicOutput};

    struct Parameters { sp: ProvingKey<Bls12_377>, op: ProvingKey<Bls12_377>, sv: String, ov: String }
    fn parameters() -> &'static Parameters {
        static P: OnceLock<Parameters> = OnceLock::new();
        P.get_or_init(|| {
            let dir=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../params/penumbra-2.1.1");
            let sp=std::fs::read(dir.join("spend_pk.bin")).unwrap();
            let op=std::fs::read(dir.join("output_pk.bin")).unwrap();
            assert_eq!(sp.len() as u64,pz::SPEND_PK_BYTES);
            assert_eq!(op.len() as u64,pz::OUTPUT_PK_BYTES);
            assert_eq!(hex::encode(core::hash(&sp)),pz::SPEND_PK_SHA256);
            assert_eq!(hex::encode(core::hash(&op)),pz::OUTPUT_PK_SHA256);
            let sv=pz::vk_hex(&pz::load_vk_param(Circuit::Spend,&std::fs::read(dir.join("spend_vk.param")).unwrap()).unwrap());
            let ov=pz::vk_hex(&pz::load_vk_param(Circuit::Output,&std::fs::read(dir.join("output_vk.param")).unwrap()).unwrap());
            let sp=pz::load_pk(Circuit::Spend,&sp).unwrap();
            let op=pz::load_pk(Circuit::Output,&op).unwrap();
            assert!(pz::pk_matches_vk(&sp,&sv)); assert!(pz::pk_matches_vk(&op,&ov));
            Parameters{sp,op,sv,ov}
        })
    }
    struct World { pool: Pool, vks:Vks, domain:[u8;32], issuer:SigningKey<SpendAuth>, serial:u64 }
    impl World {
        fn new() -> Self {
            let p=parameters(); let issuer=owner_signing_key(&[171;32],0);
            let mut cfg=Config {chain:hex::encode([7;32]),domain:String::new(),spend_vk:p.sv.clone(),output_vk:p.ov.clone(),issuer_vk:hex::encode(owner_key(&issuer))};
            cfg.domain=hex::encode(cfg.computed_domain().unwrap()); let domain=cfg.domain().unwrap();
            let vks=Vks{spend:pz::read_vk(Circuit::Spend,&p.sv).unwrap(),output:pz::read_vk(Circuit::Output,&p.ov).unwrap(),issuer:VerificationKey::from(&issuer)};
            Self{pool:Pool::new(domain),vks,domain,issuer,serial:0}
        }
        fn apply(&mut self, bytes:&[u8])->Value {
            self.serial+=1;
            let id=hex::encode(core::hash(&self.serial.to_le_bytes()));
            self.pool.apply(Some(bytes),&id,self.serial,&self.vks)
        }
        fn credit(&mut self, a:asset::Id, owner:[u8;32], amount:u64)->[u8;32] {
            let binding=core::hash(&(self.serial+1000).to_le_bytes());
            let c=public::Credit::build(public::KIND_DEPOSIT,a,amount,owner,binding,&self.issuer,&self.domain).unwrap();
            let r=self.apply(&c.encode()); assert_eq!(r["record"],"accepted","{r}");
            hex::decode(r["detail"]["outputs"][0].as_str().unwrap()).unwrap().try_into().unwrap()
        }
        fn fingerprint(&self)->Value {json!({"notes":self.pool.notes.iter().map(|(id,n)|(hex::encode(id),n)).collect::<Vec<_>>(),"spent":self.pool.spent_notes.iter().map(hex::encode).collect::<Vec<_>>(),"minted":self.pool.minted.iter().map(|(a,v)|(a,v.to_string())).collect::<Vec<_>>(),"burned":self.pool.burned.iter().map(|(a,v)|(a,v.to_string())).collect::<Vec<_>>(),"shielded_in":self.pool.shielded_in.iter().map(|(a,v)|(a,v.to_string())).collect::<Vec<_>>(),"shielded_out":self.pool.shielded_out.iter().map(|(a,v)|(a,v.to_string())).collect::<Vec<_>>(),"nullifiers":self.pool.ledger.nullifiers.iter().map(hex::encode).collect::<Vec<_>>(),"root":hex::encode(pz::root_bytes(self.pool.ledger.tree.root()))}) }
        fn reject(&mut self,label:&str,wire:&[u8],reason:&str) {
            let before=self.fingerprint();let r=self.apply(wire);
            assert_eq!(r["record"],"rejected","{label}: {r}");
            assert!(r["error"].as_str().unwrap().contains(reason),"{label}: {r}");
            assert_eq!(before,self.fingerprint(),"Rejected record changed consensus state: {label}");
            assert!(self.pool.invariant().0,"Invariant after {label}");
            eprintln!("PASS {label}: {}",r["error"]);
        }
    }
    fn asset(s:&str)->asset::Id {core::asset_for_mint(s).unwrap()}
    fn sign_transfer(t:&mut public::Transfer,sk:&SigningKey<SpendAuth>,domain:&[u8;32]){t.sig=sk.sign(OsRng,&t.message(domain));}
    fn sign_shield(s:&mut shield::Shield,sk:&SigningKey<SpendAuth>,blind:Fr,domain:&[u8;32]){let m=s.message(domain);s.owner_sig=sk.sign(OsRng,&m);s.conservation=SigningKey::<Binding>::from(blind).sign(OsRng,&m);}

    #[test]
    fn public_forgery_matrix() {
        let mut w=World::new();let (a,b)=(asset("ReviewAssetA"),asset("ReviewAssetB"));
        let (ska,skb)=(owner_signing_key(&[1;32],0),owner_signing_key(&[2;32],0));
        let (oa,ob)=(owner_key(&ska),owner_key(&skb));
        let ia=w.credit(a,oa,10);let ib=w.credit(a,ob,20);let ic=w.credit(b,oa,30);
        let baseline=public::Transfer::build(a,vec![ia],vec![PublicOutput{owner:ob,amount:10}],&ska,&w.domain).unwrap();
        let mut t=baseline.clone();t.inputs=vec![ia,ib];t.outputs[0].amount=30;sign_transfer(&mut t,&ska,&w.domain);w.reject("mixed owners",&t.encode(),"different owners");
        let mut t=baseline.clone();t.inputs=vec![ia,ic];t.outputs[0].amount=40;sign_transfer(&mut t,&ska,&w.domain);w.reject("mixed assets",&t.encode(),"asset differs");
        let mut t=baseline.clone();t.inputs=vec![ia,ia];t.outputs[0].amount=20;sign_transfer(&mut t,&ska,&w.domain);w.reject("duplicate inputs",&t.encode(),"Duplicate input");
        let mut t=baseline.clone();t.inputs[0]=[255;32];sign_transfer(&mut t,&ska,&w.domain);w.reject("unknown input",&t.encode(),"Unknown public input");
        let mut t=baseline.clone();t.outputs[0].amount=11;sign_transfer(&mut t,&ska,&w.domain);w.reject("owner-signed inflation",&t.encode(),"conserve value");
        let mut t=baseline.clone();t.outputs[0].amount=9;sign_transfer(&mut t,&ska,&w.domain);w.reject("owner-signed accidental loss",&t.encode(),"conserve value");
        let mut t=baseline.clone();t.outputs[0].amount=0;sign_transfer(&mut t,&ska,&w.domain);w.reject("zero output",&t.encode(),"Zero-value");
        let mut t=baseline.clone();t.outputs.clear();sign_transfer(&mut t,&ska,&w.domain);w.reject("zero output count",&t.encode(),"Input/output count");
        let mut t=baseline.clone();t.inputs.clear();sign_transfer(&mut t,&ska,&w.domain);w.reject("zero input count",&t.encode(),"Input/output count");
        let mut t=baseline.clone();t.outputs[0].owner=oa;w.reject("recipient mutation",&t.encode(),"signature");
        let mut t=baseline.clone();sign_transfer(&mut t,&skb,&w.domain);w.reject("foreign signer",&t.encode(),"signature");
        let mut t=baseline.clone();sign_transfer(&mut t,&ska,&[123;32]);w.reject("foreign domain signer",&t.encode(),"signature");
        let mut t=baseline.clone();t.asset=b;sign_transfer(&mut t,&ska,&w.domain);w.reject("record asset swap",&t.encode(),"asset differs");
        let mut bytes=baseline.encode();bytes.push(0);w.reject("trailing bytes",&bytes,"Trailing");
        let mut bytes=baseline.encode();bytes.pop();w.reject("truncated signature",&bytes,"Truncated");
        assert_eq!(w.apply(&baseline.encode())["record"],"accepted");
        w.reject("spent input replay",&baseline.encode(),"already spent");

        let ids=(0..4).map(|_|w.credit(a,oa,u64::MAX)).collect::<Vec<_>>();
        let outs=(0..4).map(|_|PublicOutput{owner:oa,amount:u64::MAX}).collect::<Vec<_>>();
        let large=public::Transfer::build(a,ids,outs,&ska,&w.domain).unwrap();
        assert_eq!(large.total_out().unwrap(),u128::from(u64::MAX)*4);
        assert_eq!(w.apply(&large.encode())["record"],"accepted");
        let large_ids=(0..4).map(|i|public::note_id(&public::record_id(&large.encode()),i)).collect::<Vec<_>>();
        let wrapped=public::Transfer::build(a,large_ids,vec![PublicOutput{owner:oa,amount:u64::MAX-3}],&ska,&w.domain).unwrap();
        w.reject("u64 sum wrap",&wrapped.encode(),"conserve value");

        let iburn=w.credit(a,oa,100);
        let burn=public::Burn::build(a,vec![iburn],60,PublicOutput{owner:oa,amount:40},[88;32],&ska,&w.domain).unwrap();
        let mut bad=burn.clone();bad.amount=61;bad.sig=ska.sign(OsRng,&bad.message(&w.domain));w.reject("burn inflation",&bad.encode(),"conserve value");
        let mut bad=burn.clone();bad.change.owner=ob;bad.sig=ska.sign(OsRng,&bad.message(&w.domain));w.reject("burn change redirected",&bad.encode(),"return to the owner");
        let mut bad=burn.clone();bad.binding=[0;32];bad.sig=ska.sign(OsRng,&bad.message(&w.domain));w.reject("unbound burn",&bad.encode(),"Positive bound");
        let mut bad=burn.clone();bad.sig=skb.sign(OsRng,&bad.message(&w.domain));w.reject("foreign burn signer",&bad.encode(),"signature");
        assert_eq!(w.apply(&burn.encode())["record"],"accepted");
        w.reject("burn replay",&burn.encode(),"already spent");assert!(w.pool.invariant().0);
    }

    #[test]
    fn conservation_with_valid_proofs_and_fresh_authorizations() {
        let mut w=World::new();let p=parameters();let a=asset("ReviewConservationA");let b=asset("ReviewConservationB");
        let root=[3;32];let sk=owner_signing_key(&root,0);let owner=owner_key(&sk);let key=token_spend_key(&root,0);
        let ia=w.credit(a,owner,10);let ib=w.credit(b,owner,10);
        let (ow,blind)=pz::output_witness(&shielded_address(&key),core::value(a,7)).unwrap();let note=ow.note.clone();
        let out=pz::prove_output(&p.op,ow).unwrap();out.verify(&w.vks.output).unwrap();
        let mut shield=shield::Shield{asset:a,inputs:vec![ia],change:PublicOutput{owner,amount:3},amount:7,out,owner_sig:[0;64].into(),conservation:[0;64].into()};
        sign_shield(&mut shield,&sk,blind,&w.domain);shield.verify_crypto(&VerificationKey::from(&sk),&w.vks.output,&w.domain).unwrap();
        let mut s=shield.clone();s.amount=8;s.change.amount=2;sign_shield(&mut s,&sk,blind,&w.domain);w.reject("shield declared amount 8 with valid note 7",&s.encode(),"Shield conservation rejected");
        let mut s=shield.clone();s.asset=b;s.inputs=vec![ib];sign_shield(&mut s,&sk,blind,&w.domain);w.reject("shield public asset B with valid asset A note",&s.encode(),"Shield conservation rejected");
        let mut s=shield.clone();s.amount=8;s.change.amount=2;s.out.cv=s.out.cv-Balance::from(core::value(a,1)).commit(Fr::from(0u64));sign_shield(&mut s,&sk,blind,&w.domain);w.reject("shield cv forged to satisfy binding",&s.encode(),"proof");
        assert_eq!(w.apply(&shield.encode())["record"],"accepted");

        let randomizer=pz::random_fr();let iblind=pz::random_fr();
        let iw=pz::spend_witness(&w.pool.ledger,&key,&note,randomizer,iblind).unwrap();let rk=iw.public.rk;let anchor=iw.public.anchor;
        let input=pz::prove_spend(&p.sp,iw).unwrap();input.verify(&w.vks.spend,anchor,&rk).unwrap();
        let (ow,oblind)=pz::output_witness(&shielded_address(&key),core::value(a,5)).unwrap();let change=pz::prove_output(&p.op,ow).unwrap();change.verify(&w.vks.output).unwrap();
        let mut unshield=shield::Unshield{asset:a,anchor,input,rk,auth:[0;64].into(),out:PublicOutput{owner,amount:2},change,conservation:[0;64].into()};
        let domain=w.domain;
        let sign=|u:&mut shield::Unshield|{let m=u.message(&domain);u.auth=key.spend_auth_key().randomize(&randomizer).sign(OsRng,&m);u.conservation=SigningKey::<Binding>::from(iblind+oblind).sign(OsRng,&m);};
        sign(&mut unshield);unshield.verify_crypto(&w.vks.spend,&w.vks.output,&w.domain).unwrap();
        let mut forged=unshield.clone();forged.out.amount=8;sign(&mut forged);w.reject("unshield public 8 from note 7 plus change 5",&forged.encode(),"Unshield conservation rejected");
        let mut forged=unshield.clone();forged.asset=b;sign(&mut forged);w.reject("unshield as wrong asset",&forged.encode(),"Unshield conservation rejected");
        let mut forged=unshield.clone();forged.out.amount=3;forged.input.cv=forged.input.cv+Balance::from(core::value(a,1)).commit(Fr::from(0u64));sign(&mut forged);w.reject("unshield cv forged to satisfy binding",&forged.encode(),"proof");
        let mut forged=unshield.clone();forged.out.owner=owner_key(&owner_signing_key(&[4;32],0));w.reject("unshield recipient changed without authorization",&forged.encode(),"authorization");
        assert_eq!(w.apply(&unshield.encode())["record"],"accepted");w.reject("unshield nullifier replay",&unshield.encode(),"Spent token input");assert!(w.pool.invariant().0);
    }

    #[test]
    fn key_schedule_and_address_mutation_matrix() {
        let root=[5;32];let sk=owner_signing_key(&root,0);let key=token_spend_key(&root,0);let owner=owner_key(&sk);
        assert_eq!(owner,owner_key(&owner_signing_key(&root,0)));
        assert_ne!(owner,owner_key(&owner_signing_key(&root,1)));
        assert_ne!(owner,owner_key(&owner_signing_key(&[6;32],0)));
        assert_ne!(sk.to_bytes(),key.spend_auth_key().to_bytes());
        let addr=TokenAddress::unified(shielded_address(&key),owner);let text=addr.encode();
        assert_eq!(TokenAddress::parse(&text).unwrap(),addr);
        // The byte-oriented codec agrees with the empty-payload BIP350 vectors.
        assert!(bech32m_decode("A1LQFN3A").is_ok());assert!(bech32m_decode("a1lqfn3a").is_ok());
        assert!(bech32m_decode("a1LQFN3A").is_err());assert!(bech32m_decode("A1G7SGD8").is_err());
        // Every one-character substitution over the entire actual address is rejected.
        let mut mutations=0;
        for i in 0..text.len(){for replacement in b"qpzry9x8gf2tvdw0s3jn54khce6mua7l" {if text.as_bytes()[i]==*replacement{continue;}let mut bytes=text.as_bytes().to_vec();bytes[i]=*replacement;assert!(TokenAddress::parse(std::str::from_utf8(&bytes).unwrap()).is_err(),"mutation {i} {replacement}");mutations+=1;}}
        for i in 0..text.len(){assert!(TokenAddress::parse(&text[..i]).is_err(),"truncation {i}");}
        let mut extended=text.clone();extended.push('q');assert!(TokenAddress::parse(&extended).is_err());
        let (hrp,mut bytes)=bech32m_decode(&text).unwrap();bytes.push(0);assert!(TokenAddress::parse(&bech32m_encode(&hrp,&bytes)).is_err());
        let legacy=TokenAddress::parse(&shielded_address(&key).to_string()).unwrap();assert!(legacy.owner.is_none());
        eprintln!("PASS address mutation matrix: {mutations} substitutions and {} truncations; unified address length {}",text.len(),text.len());
        // Record an interoperability observation without claiming a spending vulnerability.
        assert!(bech32m_decode(&text.to_uppercase()).is_ok());
        assert!(TokenAddress::parse(&text.to_uppercase()).is_err());
        eprintln!("OBSERVATION: full-uppercase address has valid bech32m checksum but TokenAddress::parse rejects its prefix");
        // Mint aliases are rejected by the service registry; this confirms the underlying mapping is not injective.
        assert_eq!(asset("ReviewMintABC"),asset("reviewmintabc"));
        assert_eq!(asset("ReviewMintABC"),asset("Review-Mint-ABC"));
        eprintln!("OBSERVATION: asset_for_mint lowercases and strips punctuation, so raw mint-string mapping is not injective");
    }
    #[test]
    fn issuer_binding_and_signed_fields() {
        let mut w=World::new(); let a=asset("ReviewIssuerA");
        let owner=owner_key(&owner_signing_key(&[12;32],0));
        let c=public::Credit::build(public::KIND_DEPOSIT,a,17,owner,[42;32],&w.issuer,&w.domain).unwrap();
        let mut bad=c.clone(); bad.amount=18; w.reject("credit amount mutation",&bad.encode(),"signature");
        let mut bad=c.clone(); bad.asset=asset("ReviewIssuerB"); w.reject("credit asset mutation",&bad.encode(),"signature");
        let mut bad=c.clone(); bad.owner=owner_key(&owner_signing_key(&[13;32],0)); w.reject("credit owner mutation",&bad.encode(),"signature");
        let foreign=public::Credit::build(public::KIND_DEPOSIT,a,17,owner,[43;32],&owner_signing_key(&[14;32],0),&w.domain).unwrap();
        w.reject("non-issuer credit",&foreign.encode(),"signature");
        let foreign=public::Credit::build(public::KIND_DEPOSIT,a,17,owner,[43;32],&w.issuer,&[55;32]).unwrap();
        w.reject("foreign-domain credit",&foreign.encode(),"signature");
        assert_eq!(w.apply(&c.encode())["record"],"accepted");
        let replay=public::Credit::build(public::KIND_MIGRATION,a,17,owner,[42;32],&w.issuer,&w.domain).unwrap();
        w.reject("issuer binding reused across kinds",&replay.encode(),"already credited");
        w.reject("issuer record replay",&c.encode(),"already credited");
    }

    #[test]
    fn bounded_fragment_duplicates_and_pending_counter() {
        let mut w=World::new(); let p=parameters(); let a=asset("ReviewParts");
        let root=[19;32]; let owner=owner_signing_key(&root,0); let key=token_spend_key(&root,0);
        let id=w.credit(a,owner_key(&owner),10);
        let (s,n)=shield::Shield::build(a,vec![id],10,10,&shielded_address(&key),&owner,&p.op,&w.domain).unwrap();
        assert_eq!(w.apply(&s.encode())["record"],"accepted");
        let pair=core::private2::build(&w.pool.ledger,&key,&[n],&shielded_address(&token_spend_key(&[20;32],0)),6,&p.sp,&p.op,&w.domain).unwrap();
        let wa=pair.a.encode(); let wb=pair.b.encode();
        let untouched=w.fingerprint();
        for _ in 0..3 {assert_eq!(w.apply(&wa)["record"],"pending");}
        assert_eq!(w.pool.pending_records,3);
        assert_eq!(w.fingerprint(),untouched);
        let mut invalid_b=pair.b.clone(); invalid_b.binding=[0u8;64].into();
        let r=w.apply(&invalid_b.encode());
        assert_eq!(r["record"],"pending"); assert_eq!(r["detail"]["counterparts"],3);
        assert_eq!(w.fingerprint(),untouched);
        let r=w.apply(&wb); assert_eq!(r["record"],"accepted");
        // All three matching A entries and valid B are removed, but only 2 are subtracted.
        assert_eq!(w.pool.pending_records,3); // One invalid B actually remains; two are phantom counts.
        let settled=w.fingerprint();
        for _ in 0..4 {let r=w.apply(&wa);assert_eq!(r["record"],"pending");assert_eq!(r["detail"]["note"],"operation already applied; duplicate part kept as inert");}
        assert_eq!(w.pool.pending_records,7); assert_eq!(w.pool.completed.len(),1);
        assert_eq!(w.fingerprint(),settled); assert!(w.pool.invariant().0);
        eprintln!("REPRODUCED fragment duplicate retention: 3 identical A -> 3 counterparts; pending_records=3 with only one invalid B remaining; 4 post-completion A copies -> pending_records=7; completed operations=1; supply unchanged");
    }

    #[test]
    fn padding_exception_does_not_admit_positive_nonmember() {
        let p=parameters(); let domain=[81;32]; let a=asset("ReviewPadding");
        let key=token_spend_key(&[82;32],0); let real=core::ledger::Ledger::new(domain);
        let randomizer=pz::random_fr(); let blind=pz::random_fr();
        let zero=pz::zero_note(&key,a);
        let witness=pz::spend_witness(&real,&key,&zero,randomizer,blind).unwrap();
        let rk=witness.public.rk; let anchor=witness.public.anchor;
        let proof=pz::prove_spend(&p.sp,witness).unwrap();
        let vk=pz::read_vk(Circuit::Spend,&p.sv).unwrap();
        proof.verify(&vk,anchor,&rk).unwrap();
        let (out,_)=pz::output_witness(&shielded_address(&key),core::value(a,1)).unwrap();
        let mut scratch=core::ledger::Ledger::new(domain);
        scratch.commit([], &[&out.payload]).unwrap();
        assert!(pz::spend_witness(&real,&key,&out.note,randomizer,blind).is_err());
        let mut forged=pz::spend_witness(&scratch,&key,&out.note,randomizer,blind).unwrap();
        // A genuine positive note and membership path from a different tree, but the real anchor.
        forged.public.anchor=real.root(); let forged_rk=forged.public.rk;
        match pz::prove_spend(&p.sp,forged) {
            Ok(proof)=>assert!(proof.verify(&vk,real.root(),&forged_rk).is_err()),
            Err(_)=>{},
        }
        eprintln!("PASS padding exception: absent zero-value note proves; positive note from scratch tree cannot verify against real pool anchor");
    }

    #[test]
    fn framing_bounds_canonicality_and_bounded_malformed_inputs() {
        use core::transport as t;
        let mut record=vec![0u8;t::MAX_RECORD]; record[..4].copy_from_slice(public::MAGIC_TRANSFER);
        let framed=t::frame(&record,&[3;32]).unwrap();
        assert_eq!(framed.len(),1060); assert_eq!(t::unframe(&framed).unwrap().unwrap(),record);
        let mut oversized=framed.clone();oversized.extend([2,9,1,0,0,0,0,0,0,0,0]);assert!(t::unframe(&oversized).is_err());
        let short=public::MAGIC_TRANSFER.to_vec();let framed=t::frame(&short,&[4;32]).unwrap();
        assert!(t::unframe(&framed[..framed.len()-1]).is_err());
        let mut doubled=framed.clone(); doubled.extend([1;33]);assert!(t::unframe(&doubled).is_err());
        let mut no_key=framed[33..].to_vec(); assert!(t::unframe(&no_key).is_err());
        no_key.extend([1;32]);assert!(t::unframe(&no_key).is_err());
        let mut noncanonical=framed.clone();noncanonical[34]|=128;noncanonical.insert(35,0);assert!(t::unframe(&noncanonical).is_err());
        let mut payment=framed.clone();payment.extend([2,9,1,0,0,0,0,0,0,0,0]);assert!(t::unframe(&payment).is_ok());
        payment.extend([2,9,1,0,0,0,0,0,0,0,0]);assert!(t::unframe(&payment).is_err());
        // Same application bytes broken into two short chunks instead of one canonical chunk.
        let mut split=vec![1];split.extend([5;32]);split.extend([2,3,127]);split.extend(&short[..2]);split.extend([2,3,127]);split.extend(&short[2..]);assert!(t::unframe(&split).is_err());
        assert!(t::frame(b"BAD!",&[6;32]).is_err());
        let mut seed=0x8139_u64;
        for len in 0..=1061 {let bytes=(0..len).map(|_|{seed^=seed<<13;seed^=seed>>7;seed^=seed<<17;seed as u8}).collect::<Vec<_>>();assert!(std::panic::catch_unwind(||t::unframe(&bytes)).is_ok(),"panic at length {len}");}
        eprintln!("PASS framing: byte boundary, duplicate fields, noncanonical varint/chunks, optional payment id and 1062 bounded malformed inputs");
    }

}
