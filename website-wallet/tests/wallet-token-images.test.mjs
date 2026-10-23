// Public catalog rows only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogImages,isCatalogImage} from '../src/wallet-token-images.js';

const tweet='https://xmr20.org/tweet-wallet/assets/'+'fd5a86f1bef62651cfa863db9ae0d1f5dbe6257ae2b24ac8436dcf2c164504b4'+'.png';
test('site and tweet-bot (Meteora) launch images are both shown',()=>{
 const images=catalogImages([{mint:'9MwJfFGc3jNkAKLwma4kkUYivs19yJsWXuPD15RegXMR',image:tweet},{mint:'site',image:'https://api.xmr20.org/mainnet/i/'+'a'.repeat(43)}]);
 assert.equal(images.get('9MwJfFGc3jNkAKLwma4kkUYivs19yJsWXuPD15RegXMR'),tweet);
 assert.equal(images.get('site'),'https://api.xmr20.org/mainnet/i/'+'a'.repeat(43));
});
test('other hosts, paths and file types stay on the letter fallback',()=>{
 for(const value of ['https://evil.example/tweet-wallet/assets/'+'a'.repeat(64)+'.png','http://xmr20.org/tweet-wallet/assets/'+'a'.repeat(64)+'.png',
  'https://xmr20.org/tweet-wallet/assets/'+'a'.repeat(64)+'.svg','https://xmr20.org/tweet-wallet/assets/../x.png','https://xmr20.org.evil.example/tweet-wallet/assets/'+'a'.repeat(64)+'.png',null,42])
  assert.equal(isCatalogImage(value),false,String(value));
 assert.equal(catalogImages([{mint:'m',image:'https://evil.example/x.png'}]).size,0);
});
