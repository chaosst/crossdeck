import type { CSSProperties, ReactNode } from 'react';

/**
 * 基础展示组件：Box 为 flex 容器、Text 为行内文本、Static 为按序渲染的列表。
 * 数字尺寸 props 按 8px 一格折算。
 */

type Num = number | string;

const toCss = (v: Num): Num => (typeof v === 'number' ? `${v * 8}px` : v);

// 可选 props 显式带 `undefined`：tsconfig 开了 exactOptionalPropertyTypes，否则调用方传 string | undefined 会报错。
interface BoxProps {
  flexDirection?: 'row' | 'column' | undefined;
  paddingX?: Num | undefined;
  paddingLeft?: Num | undefined;
  marginBottom?: Num | undefined;
  height?: Num | undefined;
  children?: ReactNode;
  className?: string | undefined;
}

export function Box({ flexDirection, paddingX, paddingLeft, marginBottom, height, children, className }: BoxProps) {
  const style: CSSProperties = {};
  if (flexDirection) style.flexDirection = flexDirection;
  if (paddingX !== undefined) {
    style.paddingLeft = toCss(paddingX);
    style.paddingRight = toCss(paddingX);
  }
  if (paddingLeft !== undefined) style.paddingLeft = toCss(paddingLeft);
  if (marginBottom !== undefined) style.marginBottom = toCss(marginBottom);
  if (height !== undefined) style.height = toCss(height);
  return <div className={className} style={{ display: 'flex', ...style }}>{children}</div>;
}

interface TextProps {
  color?: string | undefined;
  backgroundColor?: string | undefined;
  bold?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
  strikethrough?: boolean | undefined;
  dimColor?: boolean | undefined;
  children?: ReactNode;
  className?: string | undefined;
}

export function Text({ color, backgroundColor, bold, italic, underline, strikethrough, dimColor, children, className }: TextProps) {
  const style: CSSProperties = {};
  if (color) style.color = color;
  if (backgroundColor) style.backgroundColor = backgroundColor;
  if (bold) style.fontWeight = 600;
  if (italic) style.fontStyle = 'italic';
  const lines = [underline && 'underline', strikethrough && 'line-through'].filter(Boolean);
  if (lines.length > 0) style.textDecoration = lines.join(' ');
  if (dimColor) style.opacity = 0.6;
  return <span className={className} style={style}>{children}</span>;
}

interface StaticProps<T> {
  items: T[];
  children: (item: T, index: number) => ReactNode;
}

export function Static<T>({ items, children }: StaticProps<T>) {
  return <>{items.map((item, i) => children(item, i))}</>;
}
