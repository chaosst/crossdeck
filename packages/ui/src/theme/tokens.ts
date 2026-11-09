/**
 * 语义色 token —— 值只有 CSS 变量名，**不存 hex**。
 *
 * 色值的唯一真源在 `styles.css` 的 `@theme static`；这里只供内联 style 与
 * 动态算色使用。静态场景请直接用 Tailwind 工具类（`text-muted` / `bg-canvas`）。
 */

/** 设计系统色（浅暖底 + 白卡 + 绿主色），与 Web / 鸿蒙壳同款。 */
export const color = {
  canvas: 'var(--color-canvas)',
  surface: 'var(--color-surface)',
  surfaceSunken: 'var(--color-surface-sunken)',
  surfaceHover: 'var(--color-surface-hover)',
  surfaceSelected: 'var(--color-surface-selected)',

  ink: 'var(--color-ink)',
  inkBody: 'var(--color-ink-body)',
  inkSoft: 'var(--color-ink-soft)',
  inkDim: 'var(--color-ink-dim)',
  inkMuted: 'var(--color-ink-muted)',
  inkFaint: 'var(--color-ink-faint)',
  muted: 'var(--color-muted)',
  hint: 'var(--color-hint)',

  line: 'var(--color-line)',
  lineInput: 'var(--color-line-input)',
  lineSubtle: 'var(--color-line-subtle)',
  lineButton: 'var(--color-line-button)',
  lineBadge: 'var(--color-line-badge)',
  lineDivider: 'var(--color-line-divider)',
  lineList: 'var(--color-line-list)',
  lineTable: 'var(--color-line-table)',
  lineStrong: 'var(--color-line-strong)',
  lineBrand: 'var(--color-line-brand)',

  brand: 'var(--color-brand)',
  brandHover: 'var(--color-brand-hover)',
  brandActive: 'var(--color-brand-active)',
  brandLight: 'var(--color-brand-light)',
  brandDeep: 'var(--color-brand-deep)',
  brandTint: 'var(--color-brand-tint)',
  brandTintSoft: 'var(--color-brand-tint-soft)',
  amber: 'var(--color-amber)',

  danger: 'var(--color-danger)',
  dangerTint: 'var(--color-danger-tint)',
  dangerSurface: 'var(--color-danger-surface)',
  dangerLine: 'var(--color-danger-line)',
} as const;

export type ColorToken = keyof typeof color;
