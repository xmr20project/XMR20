// Public worker progress explains the wait; it never authorizes spending.
export function jointWaiting(job,esc,{paused=false,updatesUnavailable=false}={}){
 // The worker replays history under its publishing phase on each attempt.
 // A saved publication receipt means this is now a confirmation check.
 const rawPhase=job.background?.phase,phase=rawPhase==='publishing'&&job.publication?.txid&&!job.publication.confirmed?'monero-pending':rawPhase,link=job.proposal.operation==='register';
 const states={
  'solana-pending':{label:'Waiting for Solana confirmation',step:0,why:`Your signed ${link?'registration':'deposit'} is saved. Solana must confirm it before the service publishes ${link?'your wallet link':'your token credit'} on Monero.`},
  publishing:{label:link?'Publishing your Monero wallet link':'Publishing your Monero credit',step:1,why:link?'Solana registration is confirmed. The service is recording your wallet link on Monero.':'Your deposit is confirmed and your tokens are held on Solana. The service is recording the credit on Monero.'},
  'monero-pending':{label:'Waiting for Monero confirmations',step:2,why:link?'Your wallet link is published. The bridge waits for ten Monero confirmations before you can deposit.':'Your credit is published. The bridge waits for ten Monero confirmations; your pending balance is not spendable yet.'},
  complete:{label:link?'Wallet link confirmed':'Monero credit confirmed',step:3,why:link?'Your wallet link is confirmed. Checking the bridge before showing the deposit form…':'The service reports a confirmed credit. Checking your spendable balance…'},
  delayed:{label:'Waiting for the bridge service',why:'The service could not finish its last check. Your approval is saved and it will retry automatically.'},
  'needs-attention':{label:'This bridge needs attention',why:'The service could not safely finish this saved record. Keep your recovery receipt; do not approve another deposit.'},
  'approval-required':{label:'Checking an expired approval',why:'This approval expired or failed. Checking its result before offering a new approval.'}
 };
 const state=states[phase]??{label:'Waiting for a status update',why:'Your approval is saved. Checking the service before continuing.'};
 const running=['solana-pending','publishing','monero-pending'].includes(phase)&&!updatesUnavailable;
 const names=['Solana confirmation',link?'Monero wallet link':'Monero token credit','Ten Monero confirmations'];
 const steps=Number.isInteger(state.step)?`<ol class="joint-wait-steps" aria-label="${link?'Wallet connection':'Bridge'} progress">${names.map((name,i)=>{const done=i<state.step,current=i===state.step;return `<li data-state="${done?'done':current?'current':'queued'}"${current?' aria-current="step"':''}><span>${name}</span><span>${done?(i===1?'Published':'Confirmed'):current?(i===1?'Publishing':'Waiting'):'Next'}</span></li>`;}).join('')}</ol>`:'';
 const timing=phase==='monero-pending'?'<p class="subtle">Monero blocks arrive about every two minutes, so ten confirmations usually take around 20 minutes from publication. Timing varies with the network.</p>':'';
 const background=['solana-pending','publishing','monero-pending','delayed'].includes(phase);
 return `<div class="joint-waiting"><p class="joint-busy joint-wait-label" data-loading="${running}" data-paused="${paused}" role="status"><strong>${updatesUnavailable?'Last known: ':''}${esc(state.label)}</strong></p>${steps}<p>${esc(state.why)}</p>${timing}${background?`<p>${link?'No tokens have moved. Once connected, you can enter an amount and bridge.':'The service completes this saved deposit automatically.'}</p><p class="subtle">You can close the wallet. ${updatesUnavailable?'Reconnect later to check progress.':'Status updates automatically while it is open.'} No further approval is needed for this ${link?'wallet link':'deposit'}.</p>`:''}</div>`;
}
