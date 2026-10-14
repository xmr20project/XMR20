import {PublicKey,TransactionMessage} from '@solana/web3.js';
import {digest} from './records.mjs';

// Immutable mainnet Lighthouse, verified against its public executable record.
// Only data/info/token assertions are admitted; memory writes/closes, CPI logs,
// delta, Merkle and unknown instructions remain forbidden.
export const LIGHTHOUSE_PROGRAM='L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95';
export const LIGHTHOUSE_DATA='CJ5WEjifs4d77pEA9DpewppByFjHcAkNv3YYSuSoDk7c';
export const LIGHTHOUSE_HASH='a89179ae024ac36aa5fc308251caa84cd0a3390ae66d8523514004a86d5148bb';
const loader=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const same=(a,b)=>Buffer.from(a).equals(Buffer.from(b));
const privilege=(m,i)=>({signer:i<m.header.numRequiredSignatures,writable:m.isAccountWritable(i)});

// This never alters the signed transaction. Reconstruct only its reviewed
// instructions for comparison, then retain and verify the actual signed bytes.
export function matchesWalletApproval(expected,actual,operation){
 try{
  if(same(expected.serialize(),actual.serialize()))return true;
  if(!['deposit','donate'].includes(operation)||expected.version!==0||actual.version!==0||expected.addressTableLookups.length||actual.addressTableLookups.length||expected.recentBlockhash!==actual.recentBlockhash)return false;
  const before=expected.staticAccountKeys.map(k=>k.toBase58()),after=actual.staticAccountKeys.map(k=>k.toBase58());
  if(new Set(after).size!==after.length||after[0]!==before[0]||actual.header.numRequiredSignatures!==expected.header.numRequiredSignatures)return false;
  const used=new Set();let guards=0;
  for(let i=0;i<after.length;i++){
   const j=before.indexOf(after[i]),p=privilege(actual,i);
   if(j<0){if(p.signer||p.writable)return false;}
   else{const q=privilege(expected,j);if(p.signer!==q.signer||p.writable!==q.writable||p.signer&&i!==j)return false;}
  }
  if(before.some(k=>!after.includes(k)))return false;
  const decoded=TransactionMessage.decompile(actual),instructions=[];
  for(const ix of decoded.instructions){
   used.add(ix.programId.toBase58());for(const k of ix.keys)used.add(k.pubkey.toBase58());
   if(ix.programId.toBase58()!==LIGHTHOUSE_PROGRAM){instructions.push(ix);continue;}
   guards++;
   // These audited variants read one target account and cannot invoke another
   // program with log modes 0..2. Invalid assertion payloads fail preflight.
   if(guards>8||ix.keys.length!==1||ix.data.length<3||ix.data.length>512||![2,3,5,6,9,10].includes(ix.data[0])||![0,1,2].includes(ix.data[1]))return false;
  }
  if(!guards||after.some(k=>!before.includes(k)&&!used.has(k)))return false;
  const rebuilt=new TransactionMessage({payerKey:decoded.payerKey,recentBlockhash:decoded.recentBlockhash,instructions}).compileToV0Message();
  return same(rebuilt.serialize(),expected.serialize());
 }catch{return false;}
}

export function hasWalletGuards(message){return message.compiledInstructions.some(i=>message.staticAccountKeys[i.programIdIndex]?.toBase58()===LIGHTHOUSE_PROGRAM);}

// Called before accepting a guarded submission and when verifying its outcome.
// No configuration supplied by the browser can change these pins.
export async function verifyWalletGuardProgram(connection){
 const [p,d]=await Promise.all([connection.getAccountInfo(new PublicKey(LIGHTHOUSE_PROGRAM),'finalized'),connection.getAccountInfo(new PublicKey(LIGHTHOUSE_DATA),'finalized')]);
 if(!p?.executable||!p.owner.equals(loader)||p.data.length!==36||p.data.readUInt32LE(0)!==2||new PublicKey(p.data.subarray(4)).toBase58()!==LIGHTHOUSE_DATA||!d||d.executable||!d.owner.equals(loader)||d.data.length!==424293||d.data.readUInt32LE(0)!==3||d.data[12]!==0||digest(d.data.subarray(45))!==LIGHTHOUSE_HASH)throw Error('Wallet safety program could not be verified. Nothing was submitted.');
}
