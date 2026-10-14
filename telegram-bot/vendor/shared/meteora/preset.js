// Fixed quote units. Neither wallet balances nor a USD oracle change this curve.
// The virtual-base ratio matches the published Pump reference (1.073B / 1B).
// All 1B tokens remain in this pool; there is no migration or promised price floor.
export const XMR20_MINT='Cy5TzDyJ4mo6MBAbpwUcAgdfNiXYKrYUPrvhPGVU6XMR';
export const METEORA_PROGRAM='cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
export const XMR20_PRESET=Object.freeze({
  id:'xmr20-single-sided-v1',venue:'meteora-damm-v2',quoteMint:XMR20_MINT,
  decimals:6,supplyRaw:'1000000000000000',virtualBaseRaw:'1073000000000000',
  openingFdvRaw:'1000000000000',swapFeeBps:100,creatorShareBps:5000,
  platformShareBps:5000,quoteTransferFeeBps:150,quoteSetupRaw:'1',
  initialQuoteLiquidityRaw:'0',permanentLock:true,
});
const SCALE=1_000_000n;
const U64=(1n<<64n)-1n;
export function amountRaw(text){
  if(typeof text!=='string'||!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(text))throw Error('Enter an amount with up to 6 decimals.');
  const [w,f='']=text.split('.'),n=BigInt(w)*SCALE+BigInt(f.padEnd(6,'0'));
  if(n>U64)throw Error('Amount is too large.');
  return n;
}
export function amountText(raw){
  const n=BigInt(raw),fraction=(n%SCALE).toString().padStart(6,'0').replace(/0+$/,'');
  return `${n/SCALE}${fraction?'.'+fraction:''}`;
}
export function transferFee(raw,{bps=150,maximum=U64}={}){
  const n=BigInt(raw);
  if(n<0n||n>U64||!Number.isInteger(bps)||bps<0||bps>10000||BigInt(maximum)<0n)throw Error('Invalid transfer fee.');
  const fee=(n*BigInt(bps)+9999n)/10000n;
  return fee<BigInt(maximum)?fee:BigInt(maximum);
}
export function validatePreset(p=XMR20_PRESET){
  if(!p||Object.keys(p).length!==Object.keys(XMR20_PRESET).length||Object.entries(XMR20_PRESET).some(([key,value])=>p[key]!==value))throw Error('The XMR20 launch preset changed. Refresh the review.');
  return p;
}
export function curveParameters(p=XMR20_PRESET){
  validatePreset(p);
  const supply=BigInt(p.supplyRaw),base=BigInt(p.virtualBaseRaw),fdv=BigInt(p.openingFdvRaw);
  return {supply,virtualBase:base,virtualQuote:fdv*base/supply,
    // Exact rational prices; convert only at the SDK's decimal boundary.
    initialPrice:{numerator:fdv,denominator:supply},
    maxPrice:{numerator:fdv*base*base,denominator:supply*(base-supply)**2n}};
}
export function curvePoint(soldRaw='0',p=XMR20_PRESET){
  const {supply,virtualBase:x,virtualQuote:y}=curveParameters(p),sold=BigInt(soldRaw);
  if(sold<0n||sold>supply)throw Error('Sold amount is outside this curve.');
  const quote=x*y/(x-sold)-y,priceNumerator=x*y,priceDenominator=(x-sold)**2n;
  return {soldRaw:sold.toString(),remainingRaw:(supply-sold).toString(),
    netQuoteReserveRaw:quote.toString(),fdvRaw:(priceNumerator*supply/priceDenominator).toString()};
}
// Illustration only. Executable trades must use a fresh fee-aware Meteora quote.
export function illustrateBuy(grossRaw,p=XMR20_PRESET){
  const {supply,virtualBase:x,virtualQuote:y}=curveParameters(p),gross=BigInt(grossRaw);
  if(gross<=0n)throw Error('Enter an initial buy above zero.');
  const tax=transferFee(gross,{bps:p.quoteTransferFeeBps}),received=gross-tax;
  const swapFee=(received*BigInt(p.swapFeeBps)+9999n)/10000n,net=received-swapFee;
  const sold=net>0n?x*net/(y+net):0n;
  if(sold>supply)throw Error('This illustrative buy exceeds the launch range.');
  return {grossRaw:gross.toString(),transferFeeRaw:tax.toString(),poolFeeRaw:swapFee.toString(),
    tokensRaw:sold.toString(),...curvePoint(sold,p)};
}
