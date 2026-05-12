#!/usr/bin/env node
const orig = process.emitWarning;
process.emitWarning = function (warning, type, ...rest) {
  if (
    type === 'ExperimentalWarning' &&
    (typeof warning === 'string' ? warning : warning?.message)?.includes('SQLite')
  ) {
    return;
  }
  return orig.call(process, warning, type, ...rest);
};
await import('../dist/index.js');

