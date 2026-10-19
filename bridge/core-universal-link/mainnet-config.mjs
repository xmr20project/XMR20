// Public candidate policy, captured before deployment. Enabling this requires a
// coordinated program, carrier, index, verifier and client release.
import {universalTransferableManifest} from '../core-transferable/mainnet-config.mjs';
const {mint,abi,...base}=universalTransferableManifest('Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR');
export const identityRegistry=Object.freeze({...base,nativeAnchor:Object.freeze({"height": 3787101, "hash": "18d89637e1315db5cc968c8e724751577211a1446af2bd20ea07da7c6335bfc0"})});
