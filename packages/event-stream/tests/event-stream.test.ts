import { describe, expect, it } from 'vitest';

import { EventStreamBus } from '../src/index';

describe('event stream bus', () => {
  it('emits events to subscribers', () => {
    const bus = new EventStreamBus();
    let received = 0;
    bus.subscribe((event) => {
      if (event.type === 'WHALE_TRADE_ALERT') {
        received += 1;
      }
    });
    bus.publish({
      id: '1',
      type: 'WHALE_TRADE_ALERT',
      payload: { marketId: 'm1' },
      createdAt: new Date().toISOString(),
    });
    expect(received).toBe(1);
  });
});
