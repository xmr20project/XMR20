import { setTimeout as delay } from 'node:timers/promises';
// Tokens are supplied through the encrypted local connection.
export class Telegram {
  #token;
  constructor(token, {fetcher = fetch} = {}) {
    if (!/^[0-9]+:[a-zA-Z0-9_-]{20,}$/.test(token || '')) throw Error('A Telegram bot token is required.');
    this.#token = token; this.fetcher = fetcher;
  }
  async call(method, data, {signal} = {}) {
    if (!['getMe','getUpdates','getWebhookInfo','getFile','sendMessage','sendPhoto','answerCallbackQuery','sendChatAction'].includes(method)) throw Error('Unsupported Telegram method.');
    const timeout = AbortSignal.timeout(method === 'getUpdates' ? 35_000 : method === 'answerCallbackQuery' ? 2_000 : 10_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const res = await this.fetcher(`https://api.telegram.org/bot${this.#token}/${method}`, {method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:requestSignal});
      const result = await res.json();
      if (!res.ok || !result.ok) throw Error();
      return result.result;
    } catch { throw Error('Telegram request failed. Credentials and response bodies are withheld.'); }
  }
  async downloadPhoto(fileId) {
    try {
      if (typeof fileId !== 'string' || fileId.length > 512) throw Error();
      const file = await this.call('getFile', {file_id:fileId});
      if (!Number.isSafeInteger(file.file_size) || file.file_size < 1 || file.file_size > 10_000_000 || !/^photos\/[A-Za-z0-9_./-]+$/.test(file.file_path) || file.file_path.includes('..')) throw Error();
      const res = await this.fetcher(`https://api.telegram.org/file/bot${this.#token}/${file.file_path}`, {redirect:'error',signal:AbortSignal.timeout(10000)});
      if (!res.ok) throw Error();
      const chunks=[]; let size=0;
      for await (const chunk of res.body) { size+=chunk.length; if(size>10_000_000) {await res.body.cancel?.().catch(()=>{});throw Error();} chunks.push(Buffer.from(chunk)); }
      if(size!==file.file_size) throw Error();
      return Buffer.concat(chunks);
    } catch { throw Error('Token image could not be downloaded. Send a new photo.'); }
  }
}
export async function deliverUpdate(api, engine, vault, update, {signal, onTiming} = {}) {
  if (!Number.isSafeInteger(update.update_id) || update.update_id < vault.state.offset) return;
  const started = performance.now();
  // Commit effects before replying. A failed reply reuses the saved result.
  if (update.callback_query && (!engine.accepts || engine.accepts(update))) void api.call('answerCallbackQuery', {callback_query_id:update.callback_query.id}, {signal}).catch(()=>{});
  const response = await engine.handle(update);
  const localMs = performance.now() - started;
  if (response) {
    // The cosmetic tap acknowledgement must never block the actual reply.
    const {photo, text, ...rest} = response;
    await api.call(photo ? 'sendPhoto' : 'sendMessage', {
      ...rest, protect_content:true,
      ...(photo ? {photo, caption:text} : {text, link_preview_options:{is_disabled:true}})
    }, {signal});
  }
  const delivered = performance.now();
  vault.transaction(state => {state.offset = Math.max(state.offset, update.update_id + 1);});
  if (response && onTiming) {
    // Timing only: no identities, commands, images, URLs or credentials.
    try { onTiming({localMs, deliveryMs:delivered-started-localMs, totalMs:delivered-started}); } catch {}
  }
}
export async function poll(api, engine, vault, {signal, onTiming, onReady, expectedBot} = {}) {
  const hook = await api.call('getWebhookInfo',{}, {signal});
  if (hook.url) throw Error('This bot has a webhook. Remove its webhook in your existing integration before using polling; this app does not change it.');
  const me = await api.call('getMe',{}, {signal});
  if (expectedBot && (me?.is_bot !== true || me.id !== expectedBot.id || me.username?.toLowerCase() !== expectedBot.username?.toLowerCase())) throw Error('TELEGRAM_IDENTITY_CHANGED');
  onReady?.();
  while (!signal?.aborted) {
    try {
      const updates = await api.call('getUpdates',{offset:vault.state.offset,timeout:25,allowed_updates:['message','callback_query']}, {signal});
      for (const update of updates) { if (signal?.aborted) return; await deliverUpdate(api,engine,vault,update,{signal,onTiming}); }
    } catch {
      if (signal?.aborted) return;
      // Never print URLs, tokens, message bodies or provider errors.
      process.stderr.write('Bot connection interrupted; retrying.\n');
      await delay(2000, undefined, {signal}).catch(()=>{});
    }
  }
}
