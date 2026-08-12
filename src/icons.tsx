import type { ComponentProps } from "react";

type Props = ComponentProps<"span"> & { size?: number };
type SvgProps = ComponentProps<"svg"> & { size?: number };
const icon = (symbol: string) => function Icon({ size = 16, ...props }: Props) {
  return <span aria-hidden="true" style={{ width: size, height: size, display: "inline-grid", placeItems: "center", lineHeight: 1 }} {...props}>{symbol}</span>;
};
export const ArrowLeft = icon("←");
export const Check = icon("✓");
export const ChevronRight = icon("›");
export const Clipboard = icon("▤");
export const Coffee = icon("●");
export const Edit3 = icon("✎");
export const Minus = icon("−");
export const MessageCircle = icon("◌");
export const Package = icon("□");
export const Plus = icon("+");
export const RotateCcw = icon("↻");
export const Send = icon("➜");
export const Settings = icon("⚙");
export function GiftBox({ size = 16, ...props }: SvgProps) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
      <path d="M3 6h18" />
      <path d="M12 8v14" />
      <path d="M9 2c0 1.7 1.3 3 3 3s3-1.3 3-3" />
    </svg>
  );
}
export const Trash2 = icon("×");
