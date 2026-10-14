import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, unlinkSync, fsyncSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';

const AAD = Buffer.from('xmr20-telegram-paper-v1');
const derive = (password, salt) => scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
export class Vault {
  constructor(path, password, {profile = 'paper'} = {}) {
    if (!['paper', 'turnkey-connection', 'turnkey-execution', 'mainnet-pilot', 'official-bot'].includes(profile)) throw Error('Invalid vault profile.');
    this.aad = profile === 'paper' ? AAD : Buffer.from('xmr20-telegram-' + profile + '-v1');
    if (typeof password !== 'string' || password.length < 16) throw Object.assign(Error('Use a unique passphrase of at least 16 characters.'), {code:'VAULT_PASSPHRASE'});
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(path)).isSymbolicLink()) throw Error('State directory must not be a symlink.');
    try { this.lock = openSync(path + '.lock', 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw Object.assign(Error('Vault locked.'), {code:'VAULT_LOCKED'});
      throw error;
    }
    try {
      let envelope;
      try { envelope = JSON.parse(readFileSync(path, 'utf8')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      this.salt = envelope ? Buffer.from(envelope.salt, 'base64') : randomBytes(16);
      this.key = derive(password, this.salt);
      if (envelope) {
        if (envelope.version !== 1 || this.salt.length !== 16 || lstatSync(path).isSymbolicLink()) throw Error('Invalid vault.');
        const iv = Buffer.from(envelope.iv, 'base64'), tag = Buffer.from(envelope.tag, 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw Error('Invalid vault.');
        const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
        decipher.setAAD(this.aad); decipher.setAuthTag(tag);
        this.state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString());
        if (this.state.mode !== profile || (profile === 'paper' && (!this.state.accounts || !this.state.updates))) throw Error('Invalid state.');
      } else {
        this.state = profile === 'paper' ? { mode: 'paper', accounts: {}, updates: {}, offset: 0 } : {mode:profile};
        this.persist(this.state);
      }
    } catch {
      this.close();
      throw Object.assign(Error('Cannot unlock state. Wrong passphrase, corrupt file or incompatible format; original file preserved.'), {code:'VAULT_UNLOCK'});
    }
  }
  persist(state) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad);
    const data = Buffer.concat([cipher.update(JSON.stringify(state)), cipher.final()]);
    const envelope = { version: 1, salt: this.salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    const temp = this.path + '.' + randomBytes(8).toString('hex') + '.tmp';
    const fd = openSync(temp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(envelope)); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, this.path);
    const dir = openSync(dirname(this.path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  transaction(fn) {
    if (!this.key) throw Error('Vault closed.');
    const next = structuredClone(this.state), result = fn(next);
    this.persist(next); this.state = next; return result;
  }
  close() {
    this.key?.fill(0); this.key = null; this.state = null;
    if (this.lock !== undefined) { closeSync(this.lock); unlinkSync(this.path + '.lock'); this.lock = undefined; }
  }
}
