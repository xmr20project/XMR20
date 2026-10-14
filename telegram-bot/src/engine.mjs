import { randomUUID } from 'node:crypto';

const SOL = 1_000_000_000n;
const FEE = 5_000n; // Paper fixture only, never a live fee estimate.
const LAUNCH_COST = 60_000_000n; // Paper fixture including setup; not a live quote.
export function amount(text, decimals = 9, allowZero = false) {
  if (!new RegExp(`^(0|[1-9][0-9]{0,6})(\\.[0-9]{1,${decimals}})?$`).test(text)) throw Error('Enter an ordinary positive amount with no commas or scientific notation.');
  const [whole, fraction = ''] = text.split('.');
  const n = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
  if (!allowZero && n === 0n) throw Error('Amount must be greater than zero.');
  return n;
}
export function display(n, decimals = 9) {
  const base = 10n ** BigInt(decimals), value = BigInt(n);
  return `${value / base}.${(value % base).toString().padStart(decimals, '0')}`.replace(/\.?0+$/, '') || '0';
}
export function address(value) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  let n = 0n;
  for (const c of value) n = n * 58n + BigInt(alphabet.indexOf(c));
  let bytes = 0; while (n) { bytes++; n >>= 8n; }
  return bytes + (value.match(/^1*/)?.[0].length || 0) === 32;
}
const keyboard = rows => ({ inline_keyboard: rows.map(row => row.map(([text, callback_data]) => ({text, callback_data}))) });
const reply = (text, markup) => ({text, ...(markup ? {reply_markup: markup} : {})});
const home = () => reply('XMR20 · Practice mode\nLaunch, buy and sell with simulated SOL.', keyboard([
  [['Wallet', '/wallet'], ['Add test SOL', '/fund']],
  [['Launch', '/launch'], ['Buy', '/buy'], ['Sell', '/sell']],
  [['Withdraw', '/withdraw'], ['Orders', '/orders']],
  [['Cancel draft', '/cancel'], ['Privacy', '/privacy']]
]));
const assetOK = value => value === 'DEMO' || /^demo:[0-9a-f-]{36}$/.test(value) || address(value);

export class Engine {
  constructor(vault, { now = Date.now, allowedUsers = [] } = {}) { this.vault = vault; this.now = now; this.allowed = new Set(allowedUsers.map(String)); }
  handle(update) {
    const cb = update.callback_query, msg = cb?.message || update.message, sender = cb?.from || msg?.from;
    if (!Number.isSafeInteger(update.update_id) || !sender || sender.is_bot || msg?.chat?.type !== 'private' || msg.chat.id !== sender.id || !this.allowed.has(String(sender.id))) return null;
    const input = cb ? cb.data : msg.text;
    const photo = !cb && Array.isArray(msg.photo) ? msg.photo.at(-1) : null;
    const key = `${sender.id}:${update.update_id}`;
    // Authorized retries can use the committed response without rewriting the vault.
    if (this.vault.state.updates[key]) return this.vault.state.updates[key];
    if (!photo && (typeof input !== 'string' || input.length > 200)) return { chat_id: msg.chat.id, ...reply('Use the menu or a short command. Send token images as photos, not files. Never paste secrets.') };
    return this.vault.transaction(state => {
      // Telegram identities, drafts, receipts and responses are inside the encrypted vault.
      const account = state.accounts[sender.id] ||= { sol: '0', tokens: {}, orders: [], draft: null, funded: false };
      const before = structuredClone(account);
      let result;
      try { result = photo ? this.attachImage(account, photo) : this.command(account, input.trim()); }
      catch (e) { Object.assign(account, before); result = reply(e.message); }
      if (!photo && input.trim() === '/erase') for (const old of Object.keys(state.updates)) if (old.startsWith(`${sender.id}:`)) delete state.updates[old];
      const response = { chat_id: msg.chat.id, ...result };
      state.updates[key] = response;
      const keys = Object.keys(state.updates);
      if (keys.length > 500) delete state.updates[keys[0]];
      return response;
    });
  }
  command(a, input) {
    if (a.draft && this.now() >= a.draft.expires) { a.draft = null; if (input.startsWith('confirm:')) return reply('This review expired. Start again for a fresh review.'); }
    if (input === '/start' || input === '/help') return home();
    if (input === '/privacy') return reply('Private chats only. Bot state is encrypted at rest with AES-256-GCM. Telegram bot chats are not end-to-end encrypted; Telegram and the bot operator can process messages. Solana activity is public and an RPC provider can see queries. Never paste keys or seed phrases. /erase removes this test account from the current vault; Telegram messages and backups require separate deletion.');
    if (input === '/erase') { Object.assign(a, { sol: '0', tokens: {}, orders: [], draft: null, funded: false }); return reply('Test account reset. Telegram messages and encrypted backups are not erased by this action.'); }
    if (input === '/deposit') return reply('Real deposits are disabled. No deposit address exists in this prototype. Use /fund for test SOL.');
    if (input === '/fund') {
      if (a.funded) return reply('You already received your test allocation. Use /erase to restart the demo.');
      a.sol = (BigInt(a.sol) + SOL).toString(); a.funded = true;
      return reply('Added 1 simulated SOL. This is not a blockchain deposit.');
    }
    if (input === '/wallet') return reply(`Simulated balance: ${display(a.sol)} SOL\n${Object.entries(a.tokens).slice(-20).map(([mint, qty]) => `${mint}: ${display(qty, 6)} test tokens`).join('\n') || 'No token positions.'}\nShowing up to 20 positions. No real wallet is created.`);
    if (input === '/orders') return reply(a.orders.slice(-8).reverse().map(o => `${o.kind} · ${o.status} · ${o.id}${o.asset ? '\n' + o.asset : ''}`).join('\n\n') || 'No simulated orders yet.');
    if (input === '/cancel') { a.draft = null; return reply('Unsigned test draft cleared.'); }
    if (input === 'skip_image') {
      if (a.draft?.kind !== 'launch' || !a.draft.awaitingImage) return reply('No launch is waiting for an image. Use /launch.');
      a.draft.awaitingImage = false; a.draft.image = null;
      return this.review(a);
    }
    if (input.startsWith('confirm:')) return this.confirm(a, input.slice(8));
    if (input.startsWith('/')) {
      const parts = input.split(/\s+/), kind = parts.shift().slice(1);
      if (!['launch', 'buy', 'sell', 'withdraw'].includes(kind)) return reply('Unknown command. Use /start.');
      a.draft = {kind, values: [], expires: this.now() + 600_000};
      if (parts.length) {
        if (kind === 'launch') throw Error('Use /launch to enter your token details step by step.');
        for (const value of parts) { const r = this.advance(a, value); if (!a.draft || a.draft.review) return r; }
      }
      return this.prompt(a.draft);
    }
    if (!a.draft) return home();
    if (a.draft.review) return reply('Confirm this review or /cancel before entering another amount.');
    if (a.draft.awaitingImage) return this.imagePrompt();
    return this.advance(a, input);
  }
  imagePrompt() {
    return reply('Send your token image as a Telegram photo, or skip to use a ticker image. This test stores only an encrypted Telegram image reference; nothing is published.', keyboard([[['Skip image', 'skip_image'], ['Cancel', '/cancel']]]));
  }
  attachImage(a, photo) {
    const d = a.draft;
    if (d && this.now() >= d.expires) { a.draft = null; return reply('This draft expired. Use /launch to start again.'); }
    if (d?.kind !== 'launch' || !d.awaitingImage) return reply('Start /launch and send the image when asked.');
    if (typeof photo.file_id !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(photo.file_id) || !Number.isSafeInteger(photo.width) || photo.width <= 0 || !Number.isSafeInteger(photo.height) || photo.height <= 0 || (photo.file_size !== undefined && (!Number.isSafeInteger(photo.file_size) || photo.file_size <= 0 || photo.file_size > 10*1024*1024))) throw Error('Send a Telegram photo smaller than 10 MB.');
    d.image = {fileId:photo.file_id,width:photo.width,height:photo.height};
    d.awaitingImage = false;
    return this.review(a);
  }
  prompt(d) {
    const prompts = {
      launch: ['Token name (up to 32 characters)?', 'Ticker (1–10 letters or digits)?', 'Launch mode: xmr20 or normal?', 'Initial buy in SOL? Enter 0 to skip.'],
      buy: ['Paste a token mint, or enter DEMO for the sample token.', 'How much SOL would you like to spend?'],
      sell: ['Paste a token mint, or enter DEMO.', 'Sell what percentage of your test holding?'],
      withdraw: ['Enter the destination Solana address. Test only: nothing will be sent.', 'How much simulated SOL would you like to withdraw?']
    };
    const buttons = d.kind === 'sell' && d.values.length === 1 ? keyboard([[['25%', '25'], ['50%', '50'], ['75%', '75'], ['100%', '100']]]) : undefined;
    return reply(prompts[d.kind][d.values.length], buttons);
  }
  advance(a, value) {
    const d = a.draft, i = d.values.length;
    if (d.kind === 'launch') {
      if (i === 0 && (!value.length || value.length > 32 || /[\x00-\x1f\x7f]/.test(value))) throw Error('Use a token name of 1–32 printable characters.');
      if (i === 1 && !/^[a-zA-Z0-9]{1,10}$/.test(value)) throw Error('Ticker must contain 1–10 letters or digits.');
      if (i === 2 && !['xmr20', 'normal'].includes(value.toLowerCase())) throw Error('Choose xmr20 or normal.');
      if (i === 3) amount(value, 9, true);
    } else {
      if (i === 0 && !(d.kind === 'withdraw' ? address(value) : assetOK(value))) throw Error('Enter a valid Solana address' + (d.kind === 'withdraw' ? '.' : ' or DEMO.'));
      if (i === 1) {
        if (d.kind === 'sell') { if (!/^(100|[1-9][0-9]?)$/.test(value)) throw Error('Choose a whole percentage from 1 to 100.'); }
        else amount(value);
      }
    }
    d.values.push(value);
    if (d.values.length < (d.kind === 'launch' ? 4 : 2)) return this.prompt(d);
    if (d.kind === 'launch') { d.awaitingImage = true; return this.imagePrompt(); }
    return this.review(a);
  }
  review(a) {
    const d = a.draft;
    const [asset, entry] = d.values;
    let spend = 0n, receive = 0n, qty = 0n;
    if (d.kind === 'launch') { spend = LAUNCH_COST + amount(d.values[3], 9, true); qty = amount(d.values[3], 9, true); }
    if (d.kind === 'buy') { qty = amount(entry); spend = qty + FEE; }
    if (d.kind === 'withdraw') spend = amount(entry) + FEE;
    if (d.kind === 'sell') { qty = BigInt(a.tokens[asset] || '0') * BigInt(entry) / 100n; if (qty <= FEE) throw Error('Test holding is too small to sell after the simulated fee.'); receive = qty - FEE; }
    if (spend > BigInt(a.sol)) { a.draft = null; return reply('Insufficient simulated SOL, including the test setup/network fee. Use /fund or choose a smaller amount.'); }
    d.review = { id: randomUUID(), spend: String(spend), receive: String(receive), qty: String(qty) };
    d.expires = this.now() + 30_000;
    return {...reply(`Review simulated ${d.kind}\n${d.values.join(' · ')}${d.kind === 'launch' ? '\nImage: ' + (d.image ? 'attached' : 'ticker default') : ''}\nDebit: ${display(spend)} SOL\nCredit: ${display(receive)} SOL${d.kind === 'buy' || d.kind === 'launch' ? '\nReceive: ' + display(qty, 6) + ' test tokens' : ''}\nIllustrative fixed price: 1 SOL = 1,000 test tokens. Fees and launch costs are fixtures, not market quotes. Expires in 30 seconds. Nothing will be signed or sent.`, keyboard([[['Confirm test order', `confirm:${d.review.id}`], ['Cancel', '/cancel']]])), ...(d.image ? {photo:d.image.fileId} : {})};
  }
  confirm(a, id) {
    if (a.orders.some(o => o.id === id)) return reply('This test order already completed. No second debit.');
    const d = a.draft;
    if (!d?.review || d.review.id !== id) return reply('This review does not belong to your active draft. Start again.');
    const {spend, receive, qty} = d.review, asset = d.kind === 'launch' ? `demo:${id}` : d.values[0];
    if (BigInt(spend) > BigInt(a.sol)) throw Error('Balance changed. Cancel and request a fresh review.');
    if (d.kind === 'sell' && BigInt(qty) > BigInt(a.tokens[asset] || '0')) throw Error('Holding changed. Request a fresh review.');
    a.sol = (BigInt(a.sol) - BigInt(spend) + BigInt(receive)).toString();
    if (['buy','launch','sell'].includes(d.kind)) a.tokens[asset] = (BigInt(a.tokens[asset] || '0') + (d.kind === 'sell' ? -BigInt(qty) : BigInt(qty))).toString();
    a.orders.push({id,kind:d.kind,asset,spend,receive,qty,...(d.image ? {image:d.image} : {}),status:'simulated',at:this.now()}); a.draft = null;
    return reply(`Simulated ${d.kind} completed.\nOrder: ${id}\n${asset}\nBalance: ${display(a.sol)} test SOL.\nNo on-chain transaction or real token was created.`, keyboard([[['Wallet','/wallet'], ['Orders','/orders'], ['Menu','/start']]]));
  }
}
