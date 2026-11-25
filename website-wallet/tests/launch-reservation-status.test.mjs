import test from 'node:test';
import assert from 'node:assert/strict';
import {launchRequestTimeoutMs,reservationFailureMessage,reservationFailure} from '../src/launch-reservation-status.js';

test('only unsigned reads and prepayment preparation have the shorter network wait',()=>{
 for(const action of ['catalog','account','launchBalance','uploadImage','reserve','prepareLaunchFee'])
  assert.equal(launchRequestTimeoutMs(action),30000,action);
 for(const action of ['submitLaunchFee','checkLaunchFee','submitFunding','submitLaunch','advanceLaunch'])
  assert.equal(launchRequestTimeoutMs(action),110000,action);
});

test('reservation errors distinguish a different wallet, readiness and network failure',()=>{
 assert.match(reservationFailureMessage(Error('This launch is restricted to an approved wallet.')),/not invited/);
 assert.match(reservationFailureMessage(Error('Public launches are paused.')),/temporarily unavailable/);
 assert.match(reservationFailureMessage(Error('Failed to fetch')),/did not respond/);
 assert.match(reservationFailureMessage(Error('XMR20 could not complete this request.')),/did not respond/);
 assert.equal(reservationFailureMessage(Error('Enter a ticker.')),'Enter a ticker.');
});

test('reservation and resume failures retain wallet diagnostics without obscuring the message',()=>{
 const diagnostic={kind:'wallet-compatibility',reason:'message-changed'};
 const original=Object.assign(Error('Wallet returned a different transaction.'),{code:'WALLET_MESSAGE_CHANGED',diagnostic});
 const failure=reservationFailure(original);
 assert.equal(failure.message,original.message);
 assert.equal(failure.code,original.code);
 assert.equal(failure.diagnostic,diagnostic);
 assert.match(reservationFailure(Error('Failed to fetch')).message,/did not respond/);
 assert.equal(reservationFailure('Launch failed.').message,'Launch failed.');
});
