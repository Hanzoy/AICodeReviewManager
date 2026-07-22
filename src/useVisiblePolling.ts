import { useEffect, useRef } from "react";

interface VisiblePollingOptions {
  enabled?: boolean;
  runImmediately?: boolean;
}

export function useVisiblePolling(
  callback: () => void | Promise<unknown>,
  intervalMs: number,
  options: VisiblePollingOptions = {}
) {
  const callbackRef = useRef(callback);
  const inFlightRef = useRef<Promise<void> | undefined>(undefined);
  callbackRef.current = callback;

  const enabled = options.enabled ?? true;
  const runImmediately = options.runImmediately ?? false;

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let cycleRunning = false;
    let timer: number | undefined;

    const clearTimer = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => void run(), intervalMs);
    };

    const run = async () => {
      if (stopped || cycleRunning || document.visibilityState !== "visible") return;
      clearTimer();
      cycleRunning = true;
      try {
        if (!inFlightRef.current) {
          const operation = Promise.resolve(callbackRef.current())
            .then(() => undefined)
            .catch(() => undefined);
          inFlightRef.current = operation;
          void operation.finally(() => {
            if (inFlightRef.current === operation) inFlightRef.current = undefined;
          });
        }
        await inFlightRef.current;
      } finally {
        cycleRunning = false;
        schedule();
      }
    };

    const handleVisibilityChange = () => {
      clearTimer();
      if (document.visibilityState === "visible") void run();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (document.visibilityState === "visible") {
      if (runImmediately) void run();
      else schedule();
    }

    return () => {
      stopped = true;
      clearTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [enabled, intervalMs, runImmediately]);
}
