// Unified token address codec (bech32m, HRP "xmr20t"): shielded address (80 bytes, Penumbra's F4Jumbled encoding) ||
// public owner key (32 bytes). Mirrors core/src/keys.rs. The backend only needs the OWNER KEY of a registered holder to
// publish public credits; it never needs or derives any secret.
const CHARSET='qpzry9x8gf2tvdw0s3jn54khce6mua7l';const CONST=0x2bc830a3;
function polymod(values){const gen=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];let chk=1;for(const v of values){const top=chk>>>25;chk=((chk&0x1ffffff)<<5)^v;for(let i=0;i<5;i++)if((top>>>i)&1)chk^=gen[i];}return chk>>>0;}
function hrpExpand(hrp){const v=[];for(const c of hrp)v.push(c.charCodeAt(0)>>5);v.push(0);for(const c of hrp)v.push(c.charCodeAt(0)&31);return v;}
function convertBits(data,from,to,pad){let acc=0,bits=0;const out=[];const maxv=(1<<to)-1;for(const d of data){acc=((acc<<from)|d)>>>0;bits+=from;while(bits>=to){bits-=to;out.push((acc>>>bits)&maxv);}}if(pad){if(bits>0)out.push((acc<<(to-bits))&maxv);}else if(bits>=from||((acc<<(to-bits))&maxv))throw Error('Invalid bech32 padding');return out;}
export function bech32mEncode(hrp,data){const d5=convertBits(data,8,5,true);const values=[...hrpExpand(hrp),...d5,0,0,0,0,0,0];const pm=(polymod(values)^CONST)>>>0;let s=hrp+'1';for(const v of d5)s+=CHARSET[v];for(let i=0;i<6;i++)s+=CHARSET[(pm>>>(5*(5-i)))&31];return s;}
export function bech32mDecode(s){if(s!==s.toLowerCase()&&s!==s.toUpperCase())throw Error('Mixed-case bech32');s=s.toLowerCase();const pos=s.lastIndexOf('1');if(pos<1||pos+7>s.length)throw Error('Bech32 length');const hrp=s.slice(0,pos);const d5=[];for(const c of s.slice(pos+1)){const i=CHARSET.indexOf(c);if(i<0)throw Error('Invalid bech32 character');d5.push(i);}
 if(polymod([...hrpExpand(hrp),...d5])!==CONST)throw Error('Bech32m checksum');return {hrp,data:Uint8Array.from(convertBits(d5.slice(0,-6),5,8,false))};}
// Parse a unified token address; returns {shieldedBytes (80), ownerKey (hex 32)} or throws. "penumbra1…" carries no owner key.
export function parseTokenAddress(s){s=String(s||'').trim();if(s.startsWith('xmr20t1')){const {hrp,data}=bech32mDecode(s);if(hrp!=='xmr20t'||data.length!==112)throw Error('Unified token address must be xmr20t with 112 bytes');return {kind:'unified',shieldedBytes:data.slice(0,80),ownerKey:Buffer.from(data.slice(80)).toString('hex')};}
 if(s.startsWith('penumbra1'))return {kind:'shielded-only',shieldedBytes:null,ownerKey:null};throw Error('Not a token address');}
