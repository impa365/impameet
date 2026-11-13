import 'server-only';
import { liveDeps } from '../live/client';
import { settleLives } from '../live/service';
import { recordingDeps } from '../recordings/client';
import { settleAll } from '../recordings/service';
import { storageDeps } from './client';
import { storageTick } from './service';

const TICK_MS = 30_000;
let started = false;
let running = false;

/** The clock that notices finished recordings and sends them to each organization's storage. */
export function startStorageWorker(): void {
  if (started) return;
  started = true;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const recorder = recordingDeps();
      if (!recorder) return;
      await settleAll(recorder).catch(() => undefined);
      await settleLives(liveDeps()).catch(() => undefined);
      while ((await storageTick(storageDeps())) > 0) {
        // Keep going while there is work; the next tick picks up anything new.
      }
    } catch {
      // A database or network hiccup: try again on the next tick.
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 15_000).unref?.();
  setInterval(() => void tick(), TICK_MS).unref?.();
}
