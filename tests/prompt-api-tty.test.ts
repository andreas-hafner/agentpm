import { afterEach, describe, expect, test } from 'vitest';

import { createPromptApi } from '@agentpm/ui';

type TtyStream = { isTTY?: boolean | undefined };

const originalStdoutTty = (process.stdout as TtyStream).isTTY;
const originalStdinTty = (process.stdin as TtyStream).isTTY;

afterEach(() => {
  (process.stdout as TtyStream).isTTY = originalStdoutTty;
  (process.stdin as TtyStream).isTTY = originalStdinTty;
});

describe('createPromptApi TTY gating', () => {
  test('omits interactive pickers without a TTY so callers use their non-interactive fallbacks', () => {
    (process.stdout as TtyStream).isTTY = false;
    (process.stdin as TtyStream).isTTY = false;

    const api = createPromptApi();

    expect(typeof api.selectOne).toBe('undefined');
    expect(typeof api.selectMany).toBe('undefined');
    expect(typeof api.confirm).toBe('function');
    expect(typeof api.input).toBe('function');
  });

  test('provides interactive pickers when stdin and stdout are TTYs', () => {
    (process.stdout as TtyStream).isTTY = true;
    (process.stdin as TtyStream).isTTY = true;

    const api = createPromptApi();

    expect(typeof api.selectOne).toBe('function');
    expect(typeof api.selectMany).toBe('function');
  });
});
