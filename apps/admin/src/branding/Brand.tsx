import type { CSSProperties } from "react";
import { brandDebossColors, YoyiLogo } from "@moya/ui/brand";
import "@moya/ui/brand.css";
import styles from "./brand.module.css";

const material = Object.fromEntries(
  Object.entries(brandDebossColors).flatMap(([theme, colors]) =>
    Object.entries(colors).map(([name, value]) => [
      `--admin-brand-${theme}-${name}`,
      value,
    ]),
  ),
) as CSSProperties;

export function AdminLogo() {
  return (
    <YoyiLogo
      className={`${styles.mark} ${styles.logo}`}
      style={material}
      data-admin-brand="logo"
    />
  );
}

export function AdminIcon() {
  return (
    <YoyiLogo
      className={`${styles.mark} ${styles.icon}`}
      style={material}
      data-admin-brand="icon"
    />
  );
}
