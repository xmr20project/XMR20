import {PublicKey} from '@solana/web3.js';
import {getAssociatedTokenAddressSync,TOKEN_2022_PROGRAM_ID} from '@solana/spl-token';
export function addresses(program,mint,token=TOKEN_2022_PROGRAM_ID) {
  const p=new PublicKey(program),m=new PublicKey(mint);
  const [config]=PublicKey.findProgramAddressSync([Buffer.from('xmr20'),m.toBuffer()],p);
  return {config,vault:getAssociatedTokenAddressSync(m,config,true,token),receipt:(type,id)=>PublicKey.findProgramAddressSync([Buffer.from(type),config.toBuffer(),id],p)[0]};
}
export function decodeConfig(data,version=1) {
  const b=Buffer.from(data);if(b.length!==138||b[0]!==version)throw Error('Invalid escrow state.');
  return {mint:new PublicKey(b.subarray(1,33)).toBase58(),attestor:new PublicKey(b.subarray(33,65)).toBase58(),vault:new PublicKey(b.subarray(65,97)).toBase58(),moneroTxid:b.subarray(97,129).toString('hex'),lockedRaw:b.readBigUInt64LE(129).toString()};
}
export function decodeReceipt(data,version=1) {
  const b=Buffer.from(data);if(b.length!==(version>=2?154:138)||![1,2].includes(b[0]))throw Error('Invalid escrow receipt.');
  return {...(version>=2?{grossRaw:b.readBigUInt64LE(138).toString(),taxRaw:b.readBigUInt64LE(146).toString()}:{}),kind:b[0]===1?'deposit':'withdraw',config:new PublicKey(b.subarray(1,33)).toBase58(),owner:new PublicKey(b.subarray(33,65)).toBase58(),amountRaw:b.readBigUInt64LE(65).toString(),recipientHash:b.subarray(73,105).toString('hex'),id:b.subarray(105,137).toString('hex')};
}
