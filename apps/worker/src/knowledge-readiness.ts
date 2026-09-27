/** Pause only knowledge queues while their vector dependency initializes. */
export function createKnowledgeReadinessGate(
  probe: () => Promise<void>,
  options: { retryDelayMs: number; onUnavailable: () => void },
) {
  let ready = false;
  let pending: Promise<void> | null = null;
  let nextProbeAt = 0;

  return async (processNext: () => Promise<boolean>, waitForProbe = false) => {
    if (!ready && !pending && Date.now() >= nextProbeAt) {
      pending = Promise.resolve()
        .then(probe)
        .then(() => { ready = true; })
        .catch(() => {
          nextProbeAt = Date.now() + options.retryDelayMs;
          options.onUnavailable();
        })
        .finally(() => { pending = null; });
    }
    // Normal core ticks advance immediately to quiz import/state backfill.
    // One-shot runs may await their first check without blocking other lanes.
    if (waitForProbe) await pending;
    return ready ? processNext() : false;
  };
}
