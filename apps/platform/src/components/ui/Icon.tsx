import { ICON_PATHS, ICON_VIEW_BOX, type IconName } from './icon-paths';

export type { IconName };

export function Icon({ name, size = 24, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox={ICON_VIEW_BOX}
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
