#!/usr/bin/env node
import { resolve } from 'node:path';
import { SecureLedger } from './lib/secure-ledger.mjs';

const stateDirectory = process.env.PLANE_POLLER_STATE_DIR;
if (!stateDirectory || resolve(stateDirectory) !== stateDirectory) {
  throw Object.assign(new Error('absolute poller state directory is required'), {
    code: 'ledger_maintenance_path_invalid',
  });
}
if (process.argv.length !== 2) {
  throw Object.assign(new Error('ledger maintenance takes no arguments'), {
    code: 'ledger_maintenance_arguments_invalid',
  });
}

const result = new SecureLedger(stateDirectory).compact();
process.stdout.write(`${JSON.stringify(result)}\n`);
