export function migrate(
  url?: string,
  log?: (message: string) => void,
  options?: { attempts?: number; delayMs?: number },
): Promise<void>;
