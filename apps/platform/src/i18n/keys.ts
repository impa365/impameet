import type { Leaves } from './format';
import type { AppMessages } from './messages';

/** Every message key, checked at compile time (type-only: no messages reach the bundle). */
export type MessageKey = Leaves<AppMessages>;
