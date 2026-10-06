// Deterministic, unfunded synthetic fixtures. Never use these identities for funds.
import {createHash} from 'node:crypto';
import {Keypair,PublicKey} from '@solana/web3.js';
import {MintLayout,TOKEN_2022_PROGRAM_ID,TransferFeeConfigLayout} from '@solana/spl-token';
import {keccak_256} from '@noble/hashes/sha3';
import {planCheckpointReads,PROGRAMS} from '../src/accounting.mjs';
import {addresses} from '../src/escrow.mjs';
import {FUND} from '../src/fund-policy.mjs';
const digest=x=>createHash('sha256').update(x).digest();
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function address(seed){const b=Uint8Array.from([18,...Array(64).fill(seed)]),data=Uint8Array.from([...b,...keccak_256(b).slice(0,4)]);let out='';for(let i=0;i<data.length;i+=8){const part=data.slice(i,i+8);let n=0n;for(const v of part)n=(n<<8n)+BigInt(v);let q='';while(n){q=alphabet[Number(n%58n)]+q;n/=58n;}out+=q.padStart(part.length===8?11:7,'1');}return out;}
let keySequence=0;
const key=()=>Keypair.fromSeed(digest('xmr20-public-synthetic-fixture-'+keySequence++)).publicKey;
const account=(owner,data,executable=false)=>({owner:owner.toString(),executable,data:[data.toString('base64'),'base64'],lamports:1});
function fixture(version=1){
 keySequence=0;
 const mint=key(),creator=key(),attestor=key(),holder=key(),program=new PublicKey(PROGRAMS[version-1].programId),a=addresses(program,mint),alice=address(1),bob=address(3),operator=address(2),txid='a'.repeat(64),creditid='b'.repeat(64),transferid='c'.repeat(64),onwardid='d'.repeat(64),depositid=digest('public-deposit-id'),deposit=a.receipt('deposit',depositid);
 const launch={id:'11111111-1111-4111-8111-111111111111',mint:mint.toBase58(),owner:creator.toBase58(),ticker:'TEST',moneroNetwork:'mainnet',network:'mainnet-beta',moneroTxid:txid,bridgeVersion:1,escrowPolicy:null,bridgeProgramId:null,transferTaxBps:0,platformFeeBps:200,solanaFinalized:true,bridgeReady:true,proofVerified:true,confirmations:30,hidden:false,halted:false,cancelledAt:null,publicIndexExcluded:false};
 const deploy={p:'xmr20',v:1,net:'mainnet',op:'deploy',owner:operator,nonce:'1'.repeat(32),tick:'TEST',mint:mint.toBase58(),creator:creator.toBase58(),chain:'mainnet-beta',max:'1000000000000000',initial:'0',fee:'200',meta:'e'.repeat(64)};
 if(version>=2){Object.assign(launch,{bridgeVersion:version,transferTaxBps:150,platformFeeBps:0});deploy.fee='150';}
 if(version===3)Object.assign(launch,{escrowPolicy:'platform-auto-v3',bridgeProgramId:program.toBase58()});
 const credit={p:'xmr20',v:1,net:'mainnet',op:'credit',owner:operator,nonce:'2'.repeat(32),token:txid,amount:'1000',deposit:deposit.toBase58(),to:alice};
 const transfer={p:'xmr20',v:1,net:'mainnet',op:'transfer',owner:alice,nonce:'3'.repeat(32),token:txid,amount:'1000',to:bob};
 const event=(txid,height,record)=>({txid,height,index:0,confirmations:131-height,envelope:{record}});
 const events=[event(txid,100,deploy),event(creditid,101,credit),event(transferid,102,transfer),event(onwardid,103,{...transfer,owner:bob,to:alice,nonce:'4'.repeat(32)})];
 const receipt={id:'22222222-2222-4222-8222-222222222222',launchId:launch.id,kind:'moneroTransfer',direction:null,state:'complete',txid:transferid,amountRaw:'1000',moneroAddress:alice,recipient:bob,recipientAddress:bob,confirmations:29,updatedAt:1000,signaturePresent:true};
 const projection={schema:'xmr20-public-replay-projection-v1',launches:[launch],receipts:[receipt,{...receipt,id:'33333333-3333-4333-8333-333333333333',txid:'f'.repeat(64)}],holderSnapshots:[],uniqueKeyHashes:[]};
 const mintData=Buffer.alloc(version>=2?278:82);MintLayout.encode({mintAuthorityOption:0,mintAuthority:creator,supply:10000n,decimals:6,isInitialized:true,freezeAuthorityOption:0,freezeAuthority:creator},mintData);
 if(version>=2){mintData[165]=1;mintData.writeUInt16LE(1,166);mintData.writeUInt16LE(108,168);const fee={epoch:0n,maximumFee:1000000000000000n,transferFeeBasisPoints:150};TransferFeeConfigLayout.encode({transferFeeConfigAuthority:FUND.state,withdrawWithheldAuthority:FUND.state,withheldAmount:0n,olderTransferFee:fee,newerTransferFee:fee},mintData,170);}
 const config=Buffer.alloc(138);config[0]=version;mint.toBuffer().copy(config,1);attestor.toBuffer().copy(config,33);a.vault.toBuffer().copy(config,65);Buffer.from(txid,'hex').copy(config,97);config.writeBigUInt64LE(1000n,129);
 const token=(owner,amount)=>{const data=Buffer.alloc(165);mint.toBuffer().copy(data);owner.toBuffer().copy(data,32);data.writeBigUInt64LE(amount,64);data[108]=1;return account(TOKEN_2022_PROGRAM_ID,data);};
 const vault=token(a.config,1000n),other=token(holder,9000n);
 const receiptData=Buffer.alloc(version>=2?154:138);receiptData[0]=1;a.config.toBuffer().copy(receiptData,1);creator.toBuffer().copy(receiptData,33);receiptData.writeBigUInt64LE(1000n,65);digest(alice).copy(receiptData,73);depositid.copy(receiptData,105);
 if(version>=2){receiptData.writeBigUInt64LE(1016n,138);receiptData.writeBigUInt64LE(16n,146);}
 const input={schemaVersion:1,policy:{operatorAddress:operator,transferStartHeight:0,abandonedLaunches:[],v3ProgramId:PROGRAMS[2].programId},checkpoint:{height:130,hash:'1'.repeat(64)},scan:{network:'mainnet',height:130,events},projection};
 const plan=planCheckpointReads(input),binary=Buffer.from('synthetic approved program bytes'),manifest={...PROGRAMS[version-1],binaryHash:digest(binary).toString('hex'),binarySize:binary.length};
 const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),dataAddress=PublicKey.findProgramAddressSync([program.toBuffer()],loader)[0],programData=Buffer.alloc(45+binary.length);programData.writeUInt32LE(3);binary.copy(programData,45);const programAccount=Buffer.alloc(36);programAccount.writeUInt32LE(2);dataAddress.toBuffer().copy(programAccount,4);
 input.solana={genesisHash:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',programs:[{programId:program.toBase58(),slot:499,program:account(loader,programAccount,true),programData:account(loader,programData)}],tokens:[{mint:mint.toBase58(),enumeration:{context:{slot:500},value:[{pubkey:a.vault.toBase58(),account:vault},{pubkey:key().toBase58(),account:other}]},accountReads:[{keys:plan.tokens[0].accountKeys,context:{slot:500},value:[account(TOKEN_2022_PROGRAM_ID,mintData),account(program,config),vault,account(program,receiptData)]}]}]};
 return {input,options:{manifests:[manifest]},a,launch,receipt,mint,program,alice,bob,transferid,creditid,holder};
}

export {fixture};
