#!/usr/bin/env node
import { processIO, runCli } from './main.js';

const controller = new AbortController();
let interrupts = 0;
process.on('SIGINT', () => {
  interrupts++;
  if (interrupts === 1) {
    process.stderr.write(
      '\nStopping... the index is left unchanged. Press Ctrl-C again to quit immediately.\n'
    );
    controller.abort(new Error('interrupted'));
  } else {
    process.exit(130);
  }
});
process.on('SIGTERM', () => controller.abort(new Error('terminated')));

const code = await runCli(process.argv.slice(2), processIO(controller));
process.exitCode = code;
