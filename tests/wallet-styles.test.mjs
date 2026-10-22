import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {walletStyles} from '../wallet-styles.mjs';
const base=fileURLToPath(new URL('..',import.meta.url));
test('transferable release retains the complete approved token and bridge stylesheet',()=>{
 const ordinary=walletStyles(base),joint=readFileSync(new URL('../src/joint-transferable.css',import.meta.url),'utf8');
 const release=walletStyles(base,{transferable:true});
 assert.equal(release,ordinary+'\n'+joint);
 assert.ok(!ordinary.includes('.monero-send-form textarea'));
 for(const selector of ['.monero-send-form textarea','.monero-send-amount','.bridge-token-panel','.monero-token-detail>label'])assert.ok(release.includes(selector));
});
