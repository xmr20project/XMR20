import test from 'node:test';
import assert from 'node:assert/strict';
import {websiteBridgeRows,extensionBridgeRows,mergeWalletHoldings,bridgeActionRow} from '../src/bridge-portfolio.js';
import {XMR20_MINT,XCAT_MINT} from '../../bridge/core-next/mint-policy.mjs';
const owner='selected-solana',linkedAddress='linked-monero';
const sol=(mint=XMR20_MINT,amountRaw='10')=>({id:mint,mint,amountRaw,ticker:'Token',network:'solana'});
const joint=(mint=XCAT_MINT,amountRaw='20')=>({...sol(mint,amountRaw),network:'monero',bridge:'joint-v3',solanaOwner:owner,moneroOwner:linkedAddress});

test('opposite cached Solana and new Monero holdings join without treating legacy Monero as new custody',()=>{
 const rows=websiteBridgeRows({owner,address:linkedAddress,network:'monero',linkedAddress,currentRows:[{...sol(),network:'monero'}],solana:{owner,rows:[sol()]},joint:{owner,address:linkedAddress,rows:[joint(),{...joint(XMR20_MINT),bridge:undefined}]}});
 assert.deepEqual(rows.map(r=>[r.network,r.mint]),[['solana',XMR20_MINT],['monero',XCAT_MINT]]);
});
test('account and linked-address changes reject cached holdings from the previous scope',()=>{
 const input={owner:'other-solana',address:'other-solana',network:'solana',linkedAddress:'other-monero',solana:{owner,rows:[sol()]},joint:{owner,address:linkedAddress,rows:[joint()]}};
 assert.deepEqual(websiteBridgeRows(input),[]);
 assert.deepEqual(websiteBridgeRows({...input,owner,linkedAddress,joint:{owner,address:linkedAddress,rows:[{...joint(),moneroOwner:'other'}, {...joint(),solanaOwner:'other'}]},solana:null}),[]);
});
test('a complete current Solana snapshot clears a stale opposite cache and keeps new custody independent',()=>{
 const rows=websiteBridgeRows({owner,address:owner,network:'solana',linkedAddress,currentRows:[],solana:{owner,rows:[sol()]},joint:{owner,address:linkedAddress,rows:[joint()]}});
 assert.deepEqual(rows,[joint()]);
});
test('late partial holdings retain missing balances as stale; a later complete empty read removes them',()=>{
 const previous={complete:true,rows:[sol(),sol(XCAT_MINT)]};
 const partial=mergeWalletHoldings({complete:false,rows:[{...sol(),amountRaw:'30'}]},previous);
 assert.equal(partial.rows[0].amountRaw,'30');assert.equal(partial.rows[1].stale,true);
 assert.equal(previous.rows[1].stale,undefined);assert.deepEqual(mergeWalletHoldings({complete:true,rows:[]},partial).rows,[]);
});
test('zero, malformed, duplicate and old-custody rows cannot create extra picker options',()=>{
 const rows=extensionBridgeRows([sol(),sol(),sol(XCAT_MINT,'0'),sol(XCAT_MINT,'no'),{...sol(XCAT_MINT),network:'monero'},joint()]);
 assert.deepEqual(rows.map(r=>[r.network,r.mint]),[['solana',XMR20_MINT],['monero',XCAT_MINT]]);
 assert.deepEqual(extensionBridgeRows(rows,'monero'),[joint()]);
});
test('a generic empty portfolio has no XMR20 or catalog fallback',()=>{
 assert.deepEqual(websiteBridgeRows({owner,address:owner,network:'solana',linkedAddress,currentRows:[]}),[]);
 assert.deepEqual(extensionBridgeRows([]),[]);
});
test('an active bridge retains its display row after debit removes the holding but never across accounts',()=>{
 const row=sol(),action={scope:'a',row,kind:'bridge'};
 assert.equal(bridgeActionRow(action,[row],'a'),row);
 const removed=bridgeActionRow(action,[],'a');assert.equal(removed.mint,row.mint);assert.equal(removed.stale,true);
 assert.equal(bridgeActionRow(action,[],'b'),null);
 assert.deepEqual(bridgeActionRow({scope:'a',kind:'bridge'},[],'a'),{id:'new-bridge'});
});
