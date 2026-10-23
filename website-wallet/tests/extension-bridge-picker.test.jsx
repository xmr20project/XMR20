import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ExtensionBridge from '../src/xmr20-extension-bridge.jsx';
import {XCAT_MINT} from '../../bridge/core-next/mint-policy.mjs';
const holding={id:'held',mint:XCAT_MINT,ticker:'COVERT',network:'solana',amountRaw:'9000000'};

test('generic website delegation shows an empty state instead of an invented XMR20 amount',()=>{
 const html=renderToStaticMarkup(<ExtensionBridge owner="a" pair={{address:'b'}} bridgeRows={[]} refreshHoldings={()=>{}}/>);
 assert.match(html,/No bridgeable tokens found/);assert.match(html,/Refresh balances/);
 assert.doesNotMatch(html,/Amount in XMR20|Open bridge in XMR20 Wallet|<input/);
});
test('generic website delegation exposes only held choices and uses their ticker',()=>{
 const html=renderToStaticMarkup(<ExtensionBridge owner="a" pair={{address:'b'}} bridgeRows={[holding]}/>);
 assert.match(html,/COVERT · Solana/);assert.match(html,/Amount in COVERT/);assert.match(html,/<option[^>]*selected/);
 assert.doesNotMatch(html,/Amount in XMR20/);
});
test('an explicit positive row preserves its selection and legacy Monero cannot masquerade as new custody',()=>{
 const clicked=renderToStaticMarkup(<ExtensionBridge row={holding} bridgeRows={[]} network="solana"/>);
 assert.match(clicked,/Amount in COVERT/);assert.doesNotMatch(clicked,/<select/);
 const legacy=renderToStaticMarkup(<ExtensionBridge row={{...holding,network:'monero'}} network="monero"/>);
 assert.match(legacy,/No bridgeable tokens found/);assert.doesNotMatch(legacy,/Open bridge in XMR20 Wallet/);
});
