import {PublicKey} from '@solana/web3.js';
// Protocol bytes: preserve this legacy PDA seed exactly.
const program=new PublicKey('ALyxxeFRi5V7jSEJZjQC47A1H5qQ4uaasMCzyVt42gNx');
export const FUND=Object.freeze({state:PublicKey.findProgramAddressSync([Buffer.from('mouse-fund-v1')],program)[0]});
