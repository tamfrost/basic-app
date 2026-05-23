#!/usr/bin/env node
const { readFileSync } = require('fs');
const { spawnSync } = require('child_process');
const { join } = require('path');
const { parse } = require('dotenv');

const SECRETS = new Set(['AUTH_APP_PRIVATE_KEY', 'CONTAINER_REGISTRY_PAT', 'OAUTH2_CLIENT_SECRET', 'OAUTH2_COOKIE_SECRET']);

const vars = parse(readFileSync(join(__dirname, '..', '.env')));

for (const [key, value] of Object.entries(vars)) {
  const isSecret = SECRETS.has(key);
  process.stdout.write(`Setting ${key} (${isSecret ? 'secret' : 'variable'})... `);
  const result = spawnSync('gh', [isSecret ? 'secret' : 'variable', 'set', key], {
    input: value,
    encoding: 'utf8'
  });
  if (result.status === 0) {
    console.log('done');
  } else {
    console.log('FAILED');
    if (result.stderr?.trim()) console.error(result.stderr.trim());
  }

}
