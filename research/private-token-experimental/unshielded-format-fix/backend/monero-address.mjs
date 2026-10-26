// Monero address codec (public data only): base58 in 8-byte blocks, network byte, 32-byte public spend key, 32-byte public view
// key, optional 8-byte payment id (integrated), 4-byte keccak-256 checksum. Used by the cutover snapshot to turn a holder's
// ADDRESS (the bridge ledger's entitlement key) into the public SPEND key under which a migration claim must be signed, and by
// tests to build addresses for synthetic keys. No secret is handled here.
import {keccak_256} from '@noble/hashes/sha3';
const ALPHABET='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ENCODED=[0,2,3,5,6,7,9,10,11];// encoded length of a partial block of n bytes
export const NETWORK_BYTES={18:{network:'mainnet',kind:'standard'},19:{network:'mainnet',kind:'integrated'},42:{network:'mainnet',kind:'subaddress'},24:{network:'stagenet',kind:'standard'},25:{network:'stagenet',kind:'integrated'},36:{network:'stagenet',kind:'subaddress'},53:{network:'testnet',kind:'standard'},54:{network:'testnet',kind:'integrated'},63:{network:'testnet',kind:'subaddress'}};
function decodeBlock(s){let n=0n;for(const ch of s){const v=ALPHABET.indexOf(ch);if(v<0)throw Error('Invalid base58 character');n=n*58n+BigInt(v);}const size=ENCODED.indexOf(s.length);if(size<0)throw Error('Invalid base58 block length');const out=new Uint8Array(size);for(let i=size-1;i>=0;i--){out[i]=Number(n&255n);n>>=8n;}if(n!==0n)throw Error('base58 block overflow');return out;}
function encodeBlock(b){let n=0n;for(const x of b)n=(n<<8n)|BigInt(x);const len=ENCODED[b.length];let s='';for(let i=0;i<len;i++){s=ALPHABET[Number(n%58n)]+s;n/=58n;}return s;}
export function base58Decode(s){const out=[];for(let i=0;i<s.length;i+=11)out.push(...decodeBlock(s.slice(i,i+11)));return Uint8Array.from(out);}
export function base58Encode(bytes){let s='';for(let i=0;i<bytes.length;i+=8)s+=encodeBlock(bytes.subarray(i,i+8));return s;}
const hex=b=>Buffer.from(b).toString('hex');
export function decodeMoneroAddress(address){if(typeof address!=='string'||address.length<95||address.length>106)throw Error('Monero address length');const raw=base58Decode(address);
 const body=raw.subarray(0,raw.length-4),check=raw.subarray(raw.length-4);const expected=keccak_256(body).subarray(0,4);if(Buffer.compare(Buffer.from(check),Buffer.from(expected))!==0)throw Error('Monero address checksum');
 const net=NETWORK_BYTES[body[0]];if(!net)throw Error('Unknown Monero network byte '+body[0]);
 const spend=body.subarray(1,33),view=body.subarray(33,65);const paymentId=net.kind==='integrated'?hex(body.subarray(65,73)):null;
 if(body.length!==(net.kind==='integrated'?73:65))throw Error('Monero address body length');
 return {address,network:net.network,kind:net.kind,spendPublicKey:hex(spend),viewPublicKey:hex(view),paymentId};}
export function encodeMoneroAddress({spendPublicKey,viewPublicKey,network='mainnet',kind='standard'}){const netByte=Number(Object.entries(NETWORK_BYTES).find(([,v])=>v.network===network&&v.kind===kind)[0]);
 const body=Buffer.concat([Buffer.from([netByte]),Buffer.from(spendPublicKey,'hex'),Buffer.from(viewPublicKey,'hex')]);const check=Buffer.from(keccak_256(body).subarray(0,4));return base58Encode(Buffer.concat([body,check]));}
