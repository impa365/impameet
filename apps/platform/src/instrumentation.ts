/** Runs once when the server starts: background work that must not wait for a page view. */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startStorageWorker } = await import('./server/storage/worker');
  startStorageWorker();
}
