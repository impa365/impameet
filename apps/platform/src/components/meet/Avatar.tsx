import { Icon } from '../ui/Icon';

const COLORS = [
  '#1a73e8',
  '#d93025',
  '#188038',
  '#e37400',
  '#a142f4',
  '#007b83',
  '#c5221f',
  '#5f6368',
  '#b31412',
  '#12b5cb',
];

export function avatarColor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)!) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

export function Avatar({ name, agent = false, size = 32 }: { name: string; agent?: boolean; size?: number }) {
  return (
    <span
      className={agent ? 'avatar agent' : 'avatar'}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        background: agent ? undefined : avatarColor(name),
      }}
      aria-hidden
    >
      {agent ? <Icon name="smart_toy" size={Math.round(size * 0.6)} /> : initial(name)}
    </span>
  );
}
