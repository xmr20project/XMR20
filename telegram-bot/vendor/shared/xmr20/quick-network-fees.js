import {PublicKey,ComputeBudgetProgram,SystemProgram} from '@solana/web3.js';
// SWQoS-only Sender. The review never authorizes the more expensive Max tier.
export const QUICK_SENDER_TIP='4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE';
export const QUICK_PRIORITY_CAP=50000;
export function quickNetworkFees(value={}){
 const {units=1400000,priorityMicroLamports=10000,senderTipLamports=0}=value;
 if(!Number.isSafeInteger(units)||units<10000||units>1400000||
    !Number.isSafeInteger(priorityMicroLamports)||priorityMicroLamports<1||
    Math.ceil(units*priorityMicroLamports/1000000)>QUICK_PRIORITY_CAP||![0,5000].includes(senderTipLamports))throw Error('Quick network fees exceed the approved limit.');
 return {units,priorityMicroLamports,senderTipLamports};
}
export function quickComputeInstructions(value){const f=quickNetworkFees(value);return [
 ComputeBudgetProgram.setComputeUnitLimit({units:f.units}),
 ComputeBudgetProgram.setComputeUnitPrice({microLamports:f.priorityMicroLamports}),
];}
export function quickTipInstructions(owner,value){const f=quickNetworkFees(value);return f.senderTipLamports?[
 SystemProgram.transfer({fromPubkey:new PublicKey(owner),toPubkey:new PublicKey(QUICK_SENDER_TIP),lamports:f.senderTipLamports}),
]:[];}
