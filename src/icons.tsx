import type { ComponentProps } from "react";

type Props = ComponentProps<"span"> & { size?: number };
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
export const Package = icon("□");
export const Plus = icon("+");
export const Settings = icon("⚙");
export const ShoppingBag = icon("▢");
export const Trash2 = icon("×");
