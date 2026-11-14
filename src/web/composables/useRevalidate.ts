import { useEventListener } from '@vueuse/core';

const MIN_INTERVAL_MS = 3000;

export function onRevalidate(fn: () => unknown) {
  let last = Date.now();
  const run = () => {
    if (document.visibilityState !== 'visible' || Date.now() - last < MIN_INTERVAL_MS) return;
    last = Date.now();
    void fn();
  };
  useEventListener(window, 'focus', run);
  useEventListener(document, 'visibilitychange', run);
}
