import {amount,display,address} from './engine.mjs';
import {tokenImage,defaultTokenImage} from './image.mjs';
const icons={'/wallet':'👛','/deposit':'📥','/launch':'🚀','/buy':'🟢','/sell':'🔴','/withdraw':'📤','/orders':'📋','/cancel':'✖️','/privacy':'🔒',status:'🔎',prepare:'📝',recover:'🔄',resume:'▶️',approve:'🚀','trade-approve':'✅','trade-status':'🔎',delete:'🗑','skip-image':'⏭'};
const keyboard=rows=>({inline_keyboard:rows.map(row=>row.map(([text,callback_data])=>{
  const icon=icons[callback_data.split(':')[0]];
  return {text:icon&&!text.startsWith(icon)?`${icon} ${text}`:text,callback_data};
}))});
const response=(text,rows)=>({text,...(rows?{reply_markup:keyboard(rows)}:{})});
const home=wallet=>({
  ...response([
    '<b>Welcome to XMR20 bot.</b>',
    'Launch and trade XMR20 tokens directly in Telegram. Access your wallet quickly, review costs before confirming, and track your orders in one place.',
    '',
    '<b>XMR20 · Mainnet</b>',
    'Your Solana wallet is ready. Deposit SOL to this address:',
    `<code>${wallet}</code>`,
    '',
    '<b>Getting started</b>',
    '1. Deposit SOL, then tap Wallet to check your balance.',
    '2. Tap Launch, add a name, ticker and optional image, then review and confirm.',
    '3. Tap Buy or Sell to trade any XMR20 launch against XMR20.',
    '',
    'The launch’s initial buy can use SOL. Later buys use XMR20.',
    'Orders shows progress and receipts. Withdraw sends SOL to your saved withdrawal address.'
  ].join('\n'),[
    [['Wallet','/wallet'],['Deposit','/deposit']],
    [['Launch','/launch'],['Buy','/buy'],['Sell','/sell']],
    [['Withdraw','/withdraw'],['Orders','/orders']],
    [['Cancel draft','/cancel'],['Privacy','/privacy']]
  ]),
  parse_mode:'HTML'
});
const safeErrors={LAUNCH_POOL_CHECK:'Pool setup simulation failed. No launch transaction was sent. Even with an initial buy of 0, your wallet needs SOL for pool/account rent, the 0.01 SOL launch fee and network fees. Check Wallet, then retry this saved token using Orders → Prepare. If your balance covers those costs, retry for a fresh simulation.',LAUNCH_MINT_CHECK:'Token setup simulation failed. No launch transaction was sent. Check Wallet for SOL to cover account creation and launch costs, then retry the saved token using Orders → Prepare.',LAUNCH_TOKEN_BALANCE:'The token balance needed for this launch is too low. No launch transaction was sent. Check your balances before preparing this saved token again.',LAUNCH_NETWORK_CHECK:'The network could not simulate this launch. No launch transaction was sent. Retry the saved token using Orders → Prepare shortly.',LAUNCH_QUOTE_CHECK:'The launch quote moved outside its minimum. No launch transaction was sent. Use Orders → Prepare to get a fresh quote.',TRADE_DIRECTORY:'The XMR20 launch directory is temporarily unavailable. Try again shortly.',TRADE_TOKEN_ADDRESS:'Enter a valid CA (token address) of an XMR20 launch.',TRADE_LAUNCH_REQUIRED:'This CA is not a confirmed, published XMR20-mode launch. Check the address, or wait for its launch verification to finish.',TRADE_POOL:'The token pool could not be verified. No trade was submitted.',TRADE_BALANCE:'Your wallet does not have enough of the token needed for this trade.',TRADE_SOL_BALANCE:'Your wallet needs more SOL to cover transaction fees and account creation.',LAUNCH_BALANCE_ZERO:'Your bot wallet has no finalized SOL. Tap Deposit and fund this wallet on Solana mainnet. An initial buy of 0 still needs SOL for account creation and launch fees. Then use Orders → Prepare for this saved token.',LAUNCH_BALANCE:'Not enough SOL for this launch. An initial buy of 0 still needs pool/account rent, the 0.01 SOL launch fee and network fees. Add SOL, then use Orders → Prepare for this saved token.',LAUNCH_REVIEW_EXPIRED:'This review expired. Prepare a fresh review using the saved launch.',LAUNCH_RECONCILE:'Signing or submission needs recovery. Your token and approval records are saved. Check this order before trying again.',LAUNCH_RECOVERY_REQUIRED:'This launch already has a saved approval. Check its status first.',LAUNCH_PARTIAL_APPROVAL:'A partial approval is saved. Provider reconciliation is required; no replacement launch was created.',IMAGE_INVALID:'Send a smaller PNG, JPEG or WebP photo.',IMAGE_SIZE:'Send an image under 10 MB.',LAUNCH_IMAGE_REQUIRED:'Send a token image or choose Skip image.'};

export class PilotEngine {
  constructor({vault,ownerId,wallet,launch,helius,api,trading,now=Date.now}) {
    if(!Number.isSafeInteger(ownerId)||ownerId<=0||!address(wallet))throw Error('PILOT_IDENTITY');
    Object.assign(this,{vault,ownerId,wallet,launch,helius,api,trading,now});
  }
  accepts(update){const cb=update.callback_query,m=cb?.message||update.message,s=cb?.from||m?.from;return Number.isSafeInteger(update.update_id)&&s?.id===this.ownerId&&!s.is_bot&&m?.chat?.type==='private'&&m.chat.id===this.ownerId;}
  async handle(update) {
    if(!this.accepts(update))return null;
    const key=String(update.update_id),saved=this.vault.state.updates?.[key];if(saved)return saved;
    const cb=update.callback_query,m=cb?.message||update.message,input=cb?cb.data:m.text,photo=!cb&&m.photo?.at(-1);
    let result;
    try {
      if(photo)result=await this.photo(photo);
      else if(typeof input!=='string'||input.length>200)result=response('Use the menu or send a token photo. Never send keys or seed phrases.');
      else result=await this.command(input.trim());
    }catch(e){result=response(safeErrors[e.message]||'This action could not complete. Saved orders and approvals are preserved. Check Orders before trying again.');}
    const out={chat_id:this.ownerId,...result};
    this.vault.transaction(s=>{s.updates??={};s.updates[key]=out;const keys=Object.keys(s.updates);while(keys.length>500)delete s.updates[keys.shift()];});return out;
  }
  setDraft(value){this.vault.transaction(s=>{s.draft=value;});}
  busy(){return Object.values(this.vault.state.launches||{}).some(d=>['review','signing','submitted','attention'].includes(d.state))||Object.values(this.vault.state.trades||{}).some(d=>['review','signing','submitted','attention'].includes(d.state));}
  async command(input) {
    if(input==='/start'||input==='/help')return home(this.wallet);
    if(input==='/privacy')return response('Private chat only. Local state is encrypted. Wallet keys stay in Turnkey. Telegram chats are not end-to-end encrypted; Telegram and the bot operator can process messages. Solana transactions are public. Never send keys or seed phrases.');
    if(input==='/erase')return response('Mainnet wallet and financial receipts cannot be erased from chat. Withdraw first; preserve your recovery records.');
    if(input==='/deposit')return response(`Deposit SOL on Solana mainnet to:\n${this.wallet}\n\nWallet shows the finalized on-chain balance.`,[[['Wallet','/wallet']]]);
    if(input==='/wallet')return response(`SOL available (finalized): ${display(await this.helius.balance(this.wallet))}\n${this.wallet}`,[[['Deposit','/deposit'],['Orders','/orders']]]);
    if(input==='/orders'){
      const orders=Object.values(this.vault.state.launches||{}).filter(d=>!d.hiddenFromOrders).slice(-8).reverse();
      const trades=Object.values(this.vault.state.trades||{}).filter(d=>!d.hiddenFromOrders).slice(-5).reverse();
      return response((orders.map(d=>`${d.symbol} · ${d.state}\n${d.mint}`).concat(trades.map(d=>`${d.side} · ${d.state}`))).join('\n\n')||'No orders yet.',[...orders.map(d=>[[d.symbol,`status:${d.id}`],['Prepare',`prepare:${d.id}`],['Delete',`delete:launch:${d.id}`]]),...trades.map(d=>[[`Check ${d.side}`,`trade-status:${d.id}`],['Delete',`delete:trade:${d.id}`]])]);
    }
    if(input.startsWith('delete:')){const [,kind,id]=input.split(':');return this.deleteOrder(kind,id);}
    const action=input.split(':')[0],orderId=input.split(':')[1];
    if(['status','prepare','recover','resume','approve','trade-approve','trade-status'].includes(action)){
      const order=(action.startsWith('trade-')?this.vault.state.trades:this.vault.state.launches)?.[orderId];
      if(order?.hiddenFromOrders)return response('This order was removed from your list. Saved receipts are retained.',[[['Orders','/orders']]]);
    }
    if(input.startsWith('status:')){const id=input.slice(7),r=await this.launch.status(id);return this.launchStatus(id,r);}
    if(input.startsWith('recover:')){const id=input.slice(8);await this.launch.recover(id);return response('Recovery verified. Prepare a fresh review for this same token.',[[['Prepare',`prepare:${id}`]]]);}
    if(input.startsWith('prepare:'))return this.prepare(input.slice(8));
    if(input.startsWith('resume:'))return this.reviewReply(input.slice(7),await this.launch.resume(input.slice(7)));
    if(input.startsWith('approve:')){const [,id,attempt]=input.split(':');return this.launchStatus(id,await this.launch.approve(id,Number(attempt)));}
    if(input.startsWith('trade-approve:'))return this.tradeStatus(await this.trading.approve(input.slice(14)));
    if(input.startsWith('trade-status:'))return this.tradeStatus(await this.trading.status(input.slice(13)));
    if(input==='/cancel'){this.vault.transaction(s=>{s.draft=null;for(const d of Object.values(s.launches||{}))if(d.state==='review'){d.state='draft';d.expiresAt=0;}for(const d of Object.values(s.trades||{}))if(d.state==='review'){d.state='cancelled';d.expiresAt=0;}});return response('Unsubmitted form and reviews cancelled. Saved launches and approvals remain in Orders.');}
    if(input==='/launch'){
      if(this.busy())return response('Check the pending order before starting another.',[[['Orders','/orders']]]);
      this.setDraft({stage:'name',expiresAt:this.now()+600000});return response('What is your token name?');
    }
    if(['/buy','/sell','/withdraw'].includes(input)){
      if(this.busy())return response('Resolve the pending order before spending again.',[[['Orders','/orders']]]);
      if(!this.trading)return response('Trading and withdrawals are not enabled in this build.');
      const side=input.slice(1);
      if(side==='withdraw'&&!this.trading.withdrawalAddress){this.setDraft({stage:'withdraw-address',side,expiresAt:this.now()+600000});return response('Paste the Solana address of a separate wallet you control. Your withdrawal review will show this destination before you confirm.');}
      this.setDraft({stage:side==='withdraw'?'trade-amount':'trade-mint',side,expiresAt:this.now()+600000});
      return response(side==='withdraw'?`How much SOL to withdraw? Maximum 0.25 SOL per review.\nYour saved destination:\n${this.trading.withdrawalAddress}`:'Enter the CA (token address) of any XMR20 launch.');
    }
    const d=this.vault.state.draft;
    if(!d)return response('Choose an action from the menu.',home(this.wallet).reply_markup.inline_keyboard.map(r=>r.map(b=>[b.text,b.callback_data])));
    if(d.expiresAt<=this.now()){this.setDraft(null);return response('Form expired. Start a new launch.');}
    if(input==='skip-image'){
      if(d.stage!=='image')return response('The image step is already complete. Continue with the current form.');
      this.setDraft({...d,imageBase64:await defaultTokenImage(),imageSource:'default',stage:'initial'});
      return response('Using the default XMR20 image. How much SOL for the initial buy? Enter 0 for no initial buy.');
    }
    if(d.stage==='withdraw-address'){
      if(!address(input)||input===this.wallet)return response('Enter a valid separate Solana wallet address.');
      this.vault.transaction(s=>{s.withdrawalAddress=input;});this.trading.withdrawalAddress=input;
      this.setDraft({...d,stage:'trade-amount'});return response(`How much SOL to withdraw? Maximum 0.25 SOL per review.\nTo: ${input}`);
    }
    if(d.stage==='trade-mint'){
      if(!address(input))return response('Enter a valid CA (Solana token address) of an XMR20 launch.');this.setDraft({...d,mint:input,stage:'trade-amount'});
      return response(d.side==='buy'?'How much XMR20 to spend? Direct buys use your XMR20 balance. The launch’s initial buy can use SOL.':'How many tokens to sell for XMR20?');
    }
    if(d.stage==='trade-amount'){
      let value;try{value=amount(input,d.side==='withdraw'?9:6);}catch{return response('Enter a positive amount with no commas or scientific notation.');}
      const t=await this.trading.prepare({side:d.side,mint:d.mint,amountRaw:value.toString()});this.setDraft(null);
      return response(`${t.side==='withdraw'?'Withdraw SOL':t.side==='buy'?'Buy token with XMR20':'Sell token for XMR20'}\nAmount: ${display(t.amountRaw,t.side==='withdraw'?9:6)}\n${t.withdrawalAddress?'To: '+t.withdrawalAddress:'Token: '+t.mint}\n${t.minimumRaw?'Minimum received after transfer fees: '+display(t.minimumRaw,6)+'\n':''}Maximum SOL debit: ${display(t.maxDebitLamports)}\nExpires in 30 seconds.`,[[['Confirm',`trade-approve:${t.id}`]],[['Cancel','/cancel']]]);
    }
    if(d.stage==='name'){
      if(!input||Buffer.byteLength(input)>32)return response('Use a token name up to 32 bytes.');
      this.setDraft({...d,name:input,stage:'symbol'});return response('What is the ticker? 1–10 letters/numbers, starting with a letter.');
    }
    if(d.stage==='symbol'){
      const symbol=input.toUpperCase();if(!/^[A-Z][A-Z0-9]{0,9}$/.test(symbol))return response('Use 1–10 letters/numbers, starting with a letter.');
      this.setDraft({...d,symbol,stage:'image'});return response('Send a token image as a Telegram photo, or skip to use the default XMR20 image.',[[['Skip image','skip-image']]]);
    }
    if(d.stage==='image')return response('Send your token image as a photo, or skip this step.',[[['Skip image','skip-image']]]);
    if(d.stage==='initial'){
      let n;try{n=amount(input,9,true);if(n>10000000000n)throw Error();}catch{return response('Enter an initial buy from 0 to 10 SOL.');}
      // Save the immutable launch ID and form together before network work.
      const id=this.launch.create({...d,initialSolLamports:n.toString()});this.setDraft(null);
      return response('Token and image saved. Prepare the launch to see the actual cost and approve.',[[['Prepare launch',`prepare:${id}`]]]);
    }
    return response('Choose an action from the menu.');
  }
  deleteOrder(kind,id){
    const collection=kind==='launch'?'launches':kind==='trade'?'trades':null;
    const d=collection&&this.vault.state[collection]?.[id];
    if(!d||d.owner!==this.wallet)return response('Order not found.',[[['Orders','/orders']]]);
    if(d.hiddenFromOrders)return response('Order already removed.',[[['Orders','/orders']]]);
    const complete=kind==='launch'?d.state==='complete':['finalized','failed'].includes(d.state);
    const journal=kind==='launch'?this.launch?.journal:this.trading?.journal;
    const signed=kind==='launch'?(d.bundle?.length||d.signature||d.row?.signature||d.row?.pool||d.row?.receipts?.length||['mint','pool'].some(step=>journal?.get(`launch:${id}:${d.signingAttempt||d.attempt}:${step}`))):(d.signature||d.signedTransaction||journal?.get('trade:'+id));
    const unsigned=(kind==='launch'?['draft','review','preparing','reserved','cancelled']:['review','cancelled']).includes(d.state)&&!signed;
    if(!complete&&!unsigned)return response('This order is still pending or needs recovery. Check its status before deleting it; its approval and receipts must stay available.',[[['Orders','/orders']]]);
    this.vault.transaction(s=>{const saved=s[collection][id];saved.hiddenFromOrders=true;saved.removedAt=this.now();if(unsigned){saved.state='deleted';saved.expiresAt=0;}});
    return response(complete?'Order removed from the list. Its transaction receipts are retained.':'Draft deleted from your orders. Its old approval buttons are no longer active.',[[['Orders','/orders']]]);
  }
  async photo(photo){const d=this.vault.state.draft;if(d?.stage!=='image'||d.expiresAt<=this.now())return response('Start a launch before sending its image.');
    const imageBase64=await tokenImage(await this.api.downloadPhoto(photo.file_id));this.setDraft({...d,imageBase64,stage:'initial'});return response('Image saved. How much SOL for the initial buy? Enter 0 for no initial buy.');
  }
  async prepare(id){const r=await this.launch.prepare(id);if(r.pending)return response('Launch setup is preparing. Check again shortly.',[[['Check preparation',`prepare:${id}`]]]);if(r.complete)return this.launchStatus(id,r.row);
    return this.reviewReply(id,r);
  }
  reviewReply(id,r){
    return response(`Review XMR20 launch\n${r.name} · ${r.symbol}\n${r.mint}\n\nInitial buy: ${display(r.initialSolLamports)} SOL\nEstimated total debit: ${display(r.estimatedSolDebitLamports)} SOL\nMaximum approved debit: ${display(r.maximumSolDebitLamports)} SOL\nIncludes the 0.01 SOL inscription fee.\nCreator/platform trading fee share: 50% / 50% after Meteora.\nReview expires in 45 seconds.`,[[['Launch',`approve:${id}:${r.attempt}`]], [['Cancel','/cancel']]]);
  }
  launchStatus(id,r){const receipts=(r.receipts||[]).map(x=>`https://solscan.io/tx/${x.signature}`).join('\n');
    const text=r.pool?`Pool created. ${r.state==='complete'?'Monero publication complete.':'Monero publication is continuing; allow about 20 minutes after publication for 10 confirmations.'}\nhttps://xmr20.org/#inscription/${id}`:r.state==='attention'?'Launch needs recovery. The token address and receipts are saved.':'Launch pending. Check the saved order; do not start it again.';
    return response(text+(receipts?'\n'+receipts:''),[[['Check status',`status:${id}`]],...(r.state==='attention'?[[['Resume saved review',`resume:${id}`]],[['Check recovery',`recover:${id}`]]]:[])]);
  }
  tradeStatus(t){return response(`${t.side} · ${t.state}${t.signature?'\nhttps://solscan.io/tx/'+t.signature:''}\nSaved approvals are never automatically replaced.`,[[['Check',`trade-status:${t.id}`],['Orders','/orders']]]);}
}
