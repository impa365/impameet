/** A message tree: nested objects whose leaves are strings. */
export interface Messages {
  [key: string]: string | Messages;
}

/** Same shape as `T`, with every leaf widened to `string` (what a translation must provide). */
export type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** Plural forms are asked for by their base name ("n" for "n_one" / "n_other"). */
type Plain<K extends string> = K extends `${infer B}_one` ? B : K extends `${infer B}_other` ? B : K;

/** "a.b.c" for every leaf of `T`. */
export type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${Plain<K>}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

export type Vars = Record<string, string | number>;

function lookup(messages: Messages, key: string): string | undefined {
  let node: string | Messages | undefined = messages;
  for (const part of key.split('.')) {
    if (typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Looks up `key` and fills `{name}` placeholders. With a numeric `count`, `key_one` /
 * `key_other` pick the plural form when they exist.
 */
export function translate(messages: Messages, key: string, vars?: Vars): string {
  let text: string | undefined;
  if (vars && typeof vars.count === 'number') {
    text = lookup(messages, `${key}_${vars.count === 1 ? 'one' : 'other'}`);
  }
  text ??= lookup(messages, key) ?? key;
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));
}
