// Extension packaging must bind the website worker to the build-owned market
// transport. No page message may choose a recovery origin or network endpoint.
export function patchMarketWorker(source){
 const marker='runtime = await module.createInstalledMarketRuntime({';
 if(typeof source!=='string'||source.split(marker).length!==2||source.includes("await import('./transport.js')"))throw Error('Private worker bootstrap changed; review integration.');
 return source.replace(marker,"const {createMarketFetch,MARKET_ORIGIN}=await import('./transport.js');\n      runtime = await module.createInstalledMarketRuntime({origin:MARKET_ORIGIN,fetchImpl:createMarketFetch(),");
}
