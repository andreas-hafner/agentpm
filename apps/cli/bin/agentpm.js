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
void import('../dist/index.js').catch((error) => {
  process.nextTick(() => {
    throw error;
  });
});

