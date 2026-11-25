// CUSTODY ADAPTER, LiteSVM flavour (tests and the offline test chain): the compiled xmr20_joint_escrow program with the real
// Token-2022 mint layout, executed in an in-process Solana VM. Implements the SAME interface as custody-rpc.mjs so the operator
// never knows which one it talks to:
//   mint, feeBps, decimals, network, tax(gross), net(gross)
//   depositPrepare(ownerSolana, gross, nonce, binding) -> {transactionBase64, receipt}
//   async depositSubmit(signedTransactionBase64) -> receipt row
//   async receipts()            finalized deposit receipts (kind 10) known to the custody
//   async redeem(destination, amount, nonceHex) -> {ok, receipt, signature}
//   async redemptionReceipt(nonceHex) -> receipt|null
//   async reserve()             vault balance (atomic units)
//   async tokenBalance(address) holder balance (tests)
// Synthetic keys only. VM finality is synthetic.
import {Transaction,PublicKey} from '@solana/web3.js';
import {TOKEN_2022_PROGRAM_ID as TOKEN,getAssociatedTokenAddressSync,createAssociatedTokenAccountIdempotentInstruction} from '@solana/spl-token';
import {createBridge} from '../../token-format-unshielded-20261025/backend/solana.mjs';
import {execute,signed} from '../../../proof-of-concepts/joint-escrow-wallet/core-next/test-fixture.mjs';
import {bridgeInstruction,decodeBridgeReceipt} from '../../../proof-of-concepts/joint-escrow-wallet/core-monero-send/bridge-sdk.mjs';
export function createLiteSvmCustody({legacyGross=0n,layout='synthetic',mintAddress=null,decimals=6,mintData=null}={}){
 const b=createBridge({legacyGross,layout,mintAddress,decimals,mintData});
 const pending=new Map();// nonce -> receipt address awaiting submit
 return {
  kind:'litesvm',network:'local-svm',mint:b.mint,feeBps:b.feeBps,decimals,tax:b.tax,net:b.net,
  vm:b.vm,operator:b.operator,
  // tests: give a holder a funded token account
  fundHolder(owner,amount){const pk=new PublicKey(owner);b.vm.airdrop(owner,10_000_000_000n);const ata=getAssociatedTokenAddressSync(b.addresses.mint,pk,false,TOKEN);const r=execute(b.vm,signed(b.vm,[createAssociatedTokenAccountIdempotentInstruction(b.operator.publicKey,ata,pk,b.addresses.mint,TOKEN)],b.operator));if(!r.ok)throw Error('ata');if(amount>0n){const acc=b.vm.getAccount(ata.toBase58()),data=Buffer.from(acc.data);data.writeBigUInt64LE(BigInt(amount),64);b.vm.setAccount({...acc,address:ata.toBase58(),programAddress:TOKEN.toBase58(),data});}return ata;},
  depositPrepare(owner,gross,nonce,binding){const c={...b.config,owner};const ix=bridgeInstruction(c,b.options,{kind:'deposit',amount:String(gross),fee:b.tax(gross).toString(),nonce,binding});const tx=new Transaction({recentBlockhash:b.vm.latestBlockhash(),feePayer:new PublicKey(owner)}).add(ix.instruction);pending.set(nonce,ix.receipt);
   return {transactionBase64:tx.serialize({requireAllSignatures:false,verifySignatures:false}).toString('base64'),receipt:ix.receipt.toBase58(),program:ix.instruction.programId.toBase58(),mint:b.mint,fee:b.tax(gross).toString(),net:b.net(gross).toString()};},
  async depositSubmit(signedBase64,nonce){const tx=Transaction.from(Buffer.from(signedBase64,'base64'));const addr=pending.get(nonce);if(!addr)throw Error('Unknown deposit nonce');const x=execute(b.vm,tx);if(!x.ok)throw Error('Solana deposit rejected: '+x.logs.join(' | '));const receipt=decodeBridgeReceipt(b.vm.getAccount(addr.toBase58()).data);b.receipts.push(receipt);pending.delete(nonce);return receipt;},
  async receipts(){return b.receipts.filter(r=>r.kind===10);},
  async redeem(destination,amount,nonce){const r=b.redeem(destination,BigInt(amount),nonce);return {ok:r.ok,receipt:r.receipt||null,logs:r.logs,signature:null};},
  async redemptionReceipt(nonce){return b.redemptionReceipt(nonce)||null;},
  // Reserve = everything the custody vault holds (the program's `reserve` counter excludes the transferable legacy position,
  // which backs unclaimed legacy rights). The RPC flavour reads the same vault balance.
  async reserve(){return String(b.state().vault);},
  // One-time: move the legacy position into the payout reserve counter (program `migrate`, owner + operator signed). Idempotent.
  async migrateLegacy(){const st=b.state();if(st.legacyPosition==='0')return {ok:true,migrated:'0',alreadyMigrated:true};const m=b.migrateLegacy();if(!m.ok)throw Error('legacy migration refused: '+(m.logs||[]).join(' | '));return {ok:true,migrated:st.legacyPosition,reserve:String(b.state().reserve)};},
  async state(){return b.state();},
  async tokenBalance(ata){return String(b.tokenBalance(typeof ata==='string'?new PublicKey(ata):ata));},
  supplySnapshot:()=>b.supplySnapshot?.()||null,
 };
}
