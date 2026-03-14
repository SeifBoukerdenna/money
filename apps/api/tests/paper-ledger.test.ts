import { describe, expect, it } from 'vitest';

describe('paper ledger math', () => {
  it('computes fee from notional', () => {
    const size = 100;
    const price = 0.5;
    const feeBps = 20;
    const fee = size * price * (feeBps / 10000);
    expect(fee).toBe(0.1);
  });
});
