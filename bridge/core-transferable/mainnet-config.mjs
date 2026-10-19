import {BINARY_HASH as IDENTITY_BINARY_HASH,BINARY_SIZE as IDENTITY_BINARY_SIZE,CAPABILITY} from '../core-universal-link/deployment-policy.mjs';
import {supportedMint} from '../core-next/mint-policy.mjs';
import {MAINNET_GENESIS} from '../core-next/deployment-policy.mjs';
import {BINARY_HASH,BINARY_SIZE,PROFILE} from './deployment-policy.mjs';
// Prepared public identity. This does not assert deployment or activate a service.
export function transferableManifest(mint){
 if(!supportedMint(mint))throw Error('Canonical token mint required.');
 return Object.freeze({abi:3,network:'mainnet-beta',genesisHash:MAINNET_GENESIS,program:'8HWS1JoTRZYZEkdNvayDta3GRxCMQ2uDYEkaxD3Hs3bB',verifier:'G3SQSCg3UiQpyFz23jRT4LZG87kkzjYGpBikG2xa2qkc',mint,profile:PROFILE,binaryHash:BINARY_HASH,binarySize:BINARY_SIZE});
}

// Explicit candidate factory; default clients and services retain the legacy pin.
export function universalTransferableManifest(mint){return Object.freeze({...transferableManifest(mint),profile:'transferable-v3-identity-v1',capability:CAPABILITY,binaryHash:IDENTITY_BINARY_HASH,binarySize:IDENTITY_BINARY_SIZE});}
