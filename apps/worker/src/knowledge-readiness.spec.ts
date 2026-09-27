import { createKnowledgeReadinessGate } from './knowledge-readiness';

it('starts independent work while vector startup is unavailable and retries only knowledge readiness', async () => {
  jest.useFakeTimers().setSystemTime(0);
  let rejectProbe!: (error: Error) => void;
  const probe = jest.fn<Promise<void>, []>()
    .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectProbe = reject; }))
    .mockResolvedValue(undefined);
  const knowledge = jest.fn().mockResolvedValue(true);
  const daily = jest.fn().mockResolvedValue(true);
  const unavailable = jest.fn();
  const ready = createKnowledgeReadinessGate(probe, { retryDelayMs: 5_000, onUnavailable: unavailable });
  try {
    const lanes = Promise.all([ready(knowledge, true), daily()]);
    await Promise.resolve();
    expect(daily).toHaveBeenCalledTimes(1);
    expect(knowledge).not.toHaveBeenCalled();
    rejectProbe(new Error('upstream details must not reach the safe reporter'));
    await expect(lanes).resolves.toEqual([false, true]);
    expect(unavailable).toHaveBeenCalledWith();
    expect(knowledge).not.toHaveBeenCalled();
    await expect(ready(knowledge, true)).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(1);
    jest.setSystemTime(5_000);
    await expect(ready(knowledge, true)).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(knowledge).toHaveBeenCalledTimes(1);
  } finally {
    jest.useRealTimers();
  }
});
