#!/usr/bin/env node

import { runStartCli } from '../src/cli.js';

runStartCli()
  .then(result => {
    console.log(`started ${result.name} pid=${result.pid} cwd=${result.cwd}`);
    console.log(`sandbox=${result?.sandbox?.mode ?? 'unknown'}`);
  })
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
