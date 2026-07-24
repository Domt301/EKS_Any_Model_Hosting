/** Animated aurora backdrop (decorative). */
export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden="true">
      <div className="orb orb--1" />
      <div className="orb orb--2" />
      <div className="orb orb--3" />
    </div>
  );
}

interface OrbAvatarProps {
  size?: 'lg' | 'sm';
  thinking?: boolean;
}

/** The agent's living orb avatar. */
export function OrbAvatar({ size = 'lg', thinking = false }: OrbAvatarProps) {
  return (
    <div
      className={`orb-avatar orb-avatar--${size}${thinking ? ' is-thinking' : ''}`}
      aria-hidden="true"
    >
      <span className="orb-avatar__core" />
    </div>
  );
}
