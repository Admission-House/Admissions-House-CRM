import type { CSSProperties } from 'react';

const HEX = /^#[0-9a-f]{6}$/i;

const channels = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const toHex = (c: [number, number, number]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/** A colour moved toward another by a share from 0 to 1. */
const mix = (from: string, to: string, share: number): string => {
  const a = channels(from);
  const b = channels(to);
  return toHex([a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share]);
};

/**
 * The company's own colours, as the design tokens the screens already use. The main colour also
 * gives its lighter shades (hover, links) and the accent its darker one (focus, charts). When the
 * company has set nothing, nothing is overridden and the product's own colours show.
 */
export function themeStyle(company: { brandColor: string | null; accentColor: string | null }): CSSProperties | undefined {
  const style: Record<string, string> = {};
  if (company.brandColor && HEX.test(company.brandColor)) {
    style['--color-brand'] = company.brandColor;
    style['--color-brand-700'] = mix(company.brandColor, '#ffffff', 0.1);
    style['--color-brand-600'] = mix(company.brandColor, '#ffffff', 0.2);
  }
  if (company.accentColor && HEX.test(company.accentColor)) {
    style['--color-teal'] = company.accentColor;
    style['--color-teal-600'] = mix(company.accentColor, '#000000', 0.16);
    style['--color-mint'] = mix(company.accentColor, '#ffffff', 0.76);
    style['--color-mint-soft'] = mix(company.accentColor, '#ffffff', 0.9);
    style['--color-mint-50'] = mix(company.accentColor, '#ffffff', 0.95);
  }
  return Object.keys(style).length ? (style as CSSProperties) : undefined;
}
