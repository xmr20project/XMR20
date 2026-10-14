import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Vault } from './vault.mjs';
import { Engine } from './engine.mjs';

const dir = mkdtempSync(join(tmpdir(),'xmr20-bot-demo-'));
const vault = new Vault(join(dir,'demo.vault'),randomBytes(32).toString('hex'));
const engine = new Engine(vault,{allowedUsers:[1]});
let id = 0;
const send = text => engine.handle({update_id:++id,message:{from:{id:1},chat:{id:1,type:'private'},text}});
try {
  if (process.argv.includes('--scripted')) {
    for (const text of ['/start','/fund','/launch','Test Cat','CAT','xmr20','0.02','skip_image']) console.log('YOU:',text,'\nBOT:',send(text).text,'\n');
    const review = vault.state.accounts[1].draft.review.id;
    console.log(send('confirm:'+review).text);
    console.log(send('/wallet').text);
  } else {
    console.log(send('/start').text + '\nType /quit to close. /confirm confirms the displayed TEST review.');
    const lines = createInterface({input:process.stdin,output:process.stdout});
    try { for (;;) { let text = await lines.question('\nYou: '); if(text === '/quit') break; if(text === '/confirm') text = 'confirm:' + vault.state.accounts[1]?.draft?.review?.id; const result=send(text); console.log('\nBot:',result.text); } }
    finally { lines.close(); }
  }
} finally { vault.close(); rmSync(dir,{recursive:true,force:true}); }
