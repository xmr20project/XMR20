import {createHash} from 'node:crypto';
import {Vault} from './vault.mjs';

const fail = code => { throw Object.assign(new Error(code), {code}); };
const digest = value => createHash('sha256').update(value).digest('hex');
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,127}$/.test(id);

// Single-host durable signing journal. No key custody, balances, broadcast or
// automatic recovery. The vault's process lock is held for this object's life.
export class ExecutionJournal {
  #vault;
  constructor(path, password) {
    this.#vault = new Vault(path, password, {profile:'turnkey-execution'});
  }
  reserve(record) {
    const {operationId, request, requestSha256, organizationId, address, messageSha256, expiresAt} = record;
    if (!validId(operationId) || !request || !Number.isSafeInteger(expiresAt) || !/^[a-f0-9]{64}$/.test(messageSha256) || digest(JSON.stringify(request)) !== requestSha256 || request.organizationId !== organizationId || request.parameters?.signWith !== address || request.type !== 'ACTIVITY_TYPE_SIGN_TRANSACTION_V2' || request.parameters.type !== 'TRANSACTION_TYPE_SOLANA') fail('JOURNAL_INVALID_RESERVATION');
    this.#vault.transaction(state => {
      state.operations ??= {};
      if (Object.hasOwn(state.operations, operationId)) fail('JOURNAL_ALREADY_RESERVED');
      state.operations[operationId] = {...structuredClone(record), state:'reserved', reservedAt:new Date().toISOString()};
    });
  }
  observeActivity({operationId, activityId, status}) {
    if (!validId(operationId) || typeof activityId !== 'string' || !activityId || activityId.length > 128 || typeof status !== 'string' || !/^ACTIVITY_STATUS_[A-Z_]{1,64}$/.test(status)) fail('JOURNAL_INVALID_ACTIVITY');
    this.#vault.transaction(state => {
      const record = Object.hasOwn(state.operations ?? {}, operationId) ? state.operations[operationId] : null;
      if (!record || record.state !== 'reserved' || (record.activityId && record.activityId !== activityId)) fail('JOURNAL_ACTIVITY_MISMATCH');
      record.activityId = activityId;
      record.activityStatus = status;
    });
  }
  complete(receipt) {
    const {operationId, activityId, signedTransactionHex} = receipt;
    if (!validId(operationId) || typeof activityId !== 'string' || !activityId || typeof signedTransactionHex !== 'string' || !/^(?:[a-f0-9]{2}){65,1232}$/.test(signedTransactionHex)) fail('JOURNAL_INVALID_RECEIPT');
    this.#vault.transaction(state => {
      const record = Object.hasOwn(state.operations ?? {}, operationId) ? state.operations[operationId] : null;
      if (!record || record.state !== 'reserved' || (record.activityId && record.activityId !== activityId)) fail('JOURNAL_RECEIPT_MISMATCH');
      for (const key of ['organizationId', 'address', 'messageSha256']) if (record[key] !== receipt[key]) fail('JOURNAL_RECEIPT_MISMATCH');
      record.receipt = structuredClone(receipt);
      record.state = 'signed';
      record.completedAt = new Date().toISOString();
    });
  }
  get(operationId) {
    if (!validId(operationId)) fail('JOURNAL_INVALID_ID');
    if (!this.#vault?.state) fail('JOURNAL_CLOSED');
    const records = this.#vault.state.operations ?? {};
    return Object.hasOwn(records, operationId) ? structuredClone(records[operationId]) : null;
  }
  close() { this.#vault?.close(); this.#vault = null; }
}
