/**
 * Spark's own mark.
 *
 * Everything else in the chrome is lucide — a 24×24 grid, an even 2px stroke, a
 * system drawn once and applied consistently. That is right for a *verb*: close,
 * split, attach. It is wrong for the one thing in the app that has a name.
 *
 * The shape is a supplied asset (a struck, sunburst-like blob with its own
 * radial shading) rather than the hand-drawn rays this used to be — see
 * `git log` for the earlier version if you need the reasoning behind that one.
 * It is rendered in **greyscale everywhere it appears in the chrome**, which is
 * what a filled, coloured asset has to do to sit next to a set of icons whose
 * whole system is "one ink colour, applied by CSS": a mark that is sometimes
 * blue and sometimes `currentColor` would read as two different products
 * sharing a toolbar. `.spark-logo`'s `filter: grayscale(1)` in `app.css` is the
 * one place that is decided, so every call site gets it for free.
 *
 * `fill` is set per shape from the source asset (a gradient, not `currentColor`)
 * because the shading *is* the mark — flattening it to one flat tint the way
 * the rest of the icon set works would lose the one thing that makes this
 * drawing read as a strike of light rather than a badge.
 */

import { useId } from 'react';

interface LogoProps {
  /** Pixels. The mark's own artwork is drawn on a 300-unit grid and scales from there. */
  size?: number;
  className?: string;
  /** Set when the logo is decorative and something else carries the name. */
  title?: string;
}

export function SparkLogo({ size = 24, className, title }: LogoProps) {
  // The gradients need real ids to be referenced by `url(#...)`, and this mark
  // is mounted more than once at a time — a rail icon, a panel header and the
  // welcome screen, easily, all in the same document. A literal id would be
  // duplicated across every instance, and which one a browser then honours for
  // `url(#...)` is not something to depend on.
  const uid = useId();
  const bodyId = `${uid}body`;
  const highlightId = `${uid}highlight`;

  return (
    <svg
      className={className ? `spark-logo ${className}` : 'spark-logo'}
      width={size}
      height={size}
      viewBox="0 0 300 300"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}

      <defs>
        <radialGradient id={bodyId} cx="38%" cy="32%" r="75%">
          <stop offset="0%" stopColor="#9DB4F0" />
          <stop offset="45%" stopColor="#7B94E0" />
          <stop offset="80%" stopColor="#5A72C4" />
          <stop offset="100%" stopColor="#48609F" />
        </radialGradient>
        <radialGradient id={highlightId} cx="35%" cy="28%" r="40%">
          <stop offset="0%" stopColor="#FFFFFF" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/*
        A single struck shape rather than a ring of rays: eleven irregular
        points around one body, closer to a spark caught mid-flight than to a
        four- or eight-point star. No drop shadow — the rest of the icon set is
        flat, and a shadow that reads as depth at 64px is just noise at 16px.
      */}
      <path
        d="M 159.45 49.69 C 163.61 50.02 161.15 90.90 169.27 93.43 C 177.39 95.96 200.73 60.69 204.43 63.70 C 208.13 66.71 185.20 103.99 191.43 111.45 C 197.66 118.90 235.04 99.64 237.48 103.25 C 239.93 106.86 205.74 128.15 207.41 135.03 C 209.08 141.90 248.21 142.00 248.39 148.08 C 248.56 154.16 210.77 153.64 208.28 164.86 C 205.80 176.08 240.65 195.22 236.97 199.66 C 233.29 204.10 195.71 185.86 185.69 192.11 C 175.67 198.36 186.56 231.78 181.22 234.42 C 175.88 237.06 161.45 206.23 153.67 207.94 C 145.88 209.66 134.20 247.70 127.68 246.24 C 121.16 244.77 133.03 203.25 124.40 201.37 C 115.78 199.49 82.80 238.38 78.47 235.50 C 74.14 232.63 105.49 192.01 100.13 185.26 C 94.78 178.51 44.30 194.34 42.46 190.09 C 40.63 185.83 87.20 168.32 88.18 157.53 C 89.17 146.73 45.61 144.66 47.21 138.18 C 48.80 131.70 88.98 136.75 95.45 127.98 C 101.92 119.21 73.71 100.51 78.72 95.50 C 83.73 90.48 112.86 108.41 120.12 103.29 C 127.37 98.17 125.81 61.25 129.74 59.51 C 133.67 57.76 139.70 93.83 146.31 91.65 C 152.91 89.46 155.29 49.37 159.45 49.69 Z"
        fill={`url(#${bodyId})`}
      />
      <path
        d="M 159.45 49.69 C 163.61 50.02 161.15 90.90 169.27 93.43 C 177.39 95.96 200.73 60.69 204.43 63.70 C 208.13 66.71 185.20 103.99 191.43 111.45 C 197.66 118.90 235.04 99.64 237.48 103.25 C 239.93 106.86 205.74 128.15 207.41 135.03 C 209.08 141.90 248.21 142.00 248.39 148.08 C 248.56 154.16 210.77 153.64 208.28 164.86 C 205.80 176.08 240.65 195.22 236.97 199.66 C 233.29 204.10 195.71 185.86 185.69 192.11 C 175.67 198.36 186.56 231.78 181.22 234.42 C 175.88 237.06 161.45 206.23 153.67 207.94 C 145.88 209.66 134.20 247.70 127.68 246.24 C 121.16 244.77 133.03 203.25 124.40 201.37 C 115.78 199.49 82.80 238.38 78.47 235.50 C 74.14 232.63 105.49 192.01 100.13 185.26 C 94.78 178.51 44.30 194.34 42.46 190.09 C 40.63 185.83 87.20 168.32 88.18 157.53 C 89.17 146.73 45.61 144.66 47.21 138.18 C 48.80 131.70 88.98 136.75 95.45 127.98 C 101.92 119.21 73.71 100.51 78.72 95.50 C 83.73 90.48 112.86 108.41 120.12 103.29 C 127.37 98.17 125.81 61.25 129.74 59.51 C 133.67 57.76 139.70 93.83 146.31 91.65 C 152.91 89.46 155.29 49.37 159.45 49.69 Z"
        fill={`url(#${highlightId})`}
      />
    </svg>
  );
}

/**
 * The mark at rest, behind an empty panel.
 *
 * Faded by opacity rather than by recolouring: the mark's shading is a
 * gradient baked into the asset, not `currentColor`, so there is no tint to
 * mix against the surface the way the old drawn mark let this do. Low enough
 * to be furniture, high enough that the panel does not look broken.
 */
export function SparkWatermark() {
  return (
    <div className="spark-watermark" aria-hidden="true">
      <SparkLogo size={132} />
    </div>
  );
}
