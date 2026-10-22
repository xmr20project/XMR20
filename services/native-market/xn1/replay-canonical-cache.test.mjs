import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Buffer} from 'node:buffer';
import {uint,join} from './bytes.mjs';
import {PrototypeIndex} from './replay.mjs';
import {fixtureManifest,authorize,creditRecord,observation,sale,label} from './test-fixtures.mjs';
const source=readFileSync(new URL('./replay.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('const canonicalTables ='),source.indexOf('function stateBytes('));
const cachedTable=new Function('Buffer','uint','join',body+'\nreturn cachedTable;')(Buffer,uint,join);

test('canonical table encodes over150000rows without function-argument overflow and retains exact bytes',()=>{
 const n=160000,rows=new Map(Array.from({length:n},(_,i)=>[i,BigInt(i)*17n]));
 const keyBytes=key=>uint(key,8),make=(key,value)=>join(uint(key,8),uint(value,8));
 const reference=()=>{const entries=[...rows].map(([key,value])=>({key:keyBytes(key),data:make(key,value)})).sort((a,b)=>Buffer.compare(a.key,b.key));return Buffer.concat([uint(7,1),uint(entries.length,8),...entries.map(entry=>Buffer.concat([uint(entry.data.length,4),entry.data]))]);};
 assert.deepEqual(cachedTable(7,rows,keyBytes,make),reference());
 rows.set(123,9n);rows.delete(400);rows.set(200000,7n);
 assert.deepEqual(cachedTable(7,rows,keyBytes,make),reference());
 const detached=cachedTable(7,rows,keyBytes,make);detached.fill(0);
 assert.deepEqual(cachedTable(7,rows,keyBytes,make),reference());
});


test('a row encoding exception invalidates the partial cache before retry',()=>{
 const rows=new Map([[1,1n]]),keyBytes=key=>uint(key,8),make=(key,value)=>join(uint(key,8),uint(value,8));
 cachedTable(7,rows,keyBytes,make);rows.set(2,2n);rows.set(3,3n);
 assert.throws(()=>cachedTable(7,rows,keyBytes,(key,value)=>{if(key===3)throw Error('fixture encoding failure');return make(key,value);}),/fixture encoding failure/);
 const expected=Buffer.concat([uint(7,1),uint(3,8),...Array.from(rows,([key,value])=>Buffer.concat([uint(16,4),make(key,value)]))]);
 assert.deepEqual(cachedTable(7,rows,keyBytes,make),expected);
});

test('credit, move, burn and rewind retain the original canonical state hashes',()=>{
 const expected=[
  '933d4e8c2da01efe1b9cf079ad61b3ce8c00cf89b8018d02c5d9ebe2d1c479c4',
  'd1f79fb7bc090cd74aaedce210e8d44d6cfc86dc2292a5bba073064c0d0ef11e',
  '43f4a226204c0ddcdf4782fbfac5694ec53cc5d47da45228223d003f63f7d5e9',
  'c59d05435c9e8f6ad46aff9d35315c1f85d9bbe26691116b3a72979b28bb630d',
  '95b019a49610cc8acfb7c483d3ac3415b01716a593a6697fd5910939f5789faa',
  '43f4a226204c0ddcdf4782fbfac5694ec53cc5d47da45228223d003f63f7d5e9',
  'e7483854ce41f69a8a27289b02ec74309dfbc4bfbb609cf239ae9375111a2ec2',
  '43f4a226204c0ddcdf4782fbfac5694ec53cc5d47da45228223d003f63f7d5e9',
  '37c3ab6e97e4d50f99b757ca0f79504401f848772cca4807d9058eed756e652e'
 ];
 const manifest=fixtureManifest(),index=new PrototypeIndex(manifest);
 const check=()=>assert.equal(index.stateHash(),expected.shift());
 const append=(transactions=[],name='')=>{const c=index.checkpoint();index.applyBlock({height:c.height+1n,parent:c.blockHash,hash:label('canonical-golden:'+c.height+':'+name),transactions});};
 check();const credit=authorize(creditRecord(manifest));append([observation(credit)]);check();
 for(let i=0;i<9;i++)append();check();const anchor=index.checkpoint();
 const move=sale(credit,manifest);append([observation(move,200n)],'move');check();
 for(let i=0;i<25;i++)append();check();index.rewind(anchor.height,anchor.blockHash);check();
 const burn=sale(credit,manifest,{op:'BURN',allocations:[],amount:1000n,recipient:label('recipient'),redemption:label('redemption')});
 append([observation(burn,255n)],'burn');check();index.rewind(anchor.height,anchor.blockHash);check();
 append([observation(move,200n)],'reapply');check();assert.equal(expected.length,0);
});
