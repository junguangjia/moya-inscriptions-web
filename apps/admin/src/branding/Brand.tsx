import styles from "./brand.module.css";

export function AdminLogo() {
  return (
    <span
      aria-label="由艺 / ArtVenn"
      className={`${styles.mark} ${styles.logo}`}
      data-admin-brand="logo"
      role="img"
    />
  );
}

export function AdminIcon() {
  return (
    <span
      aria-label="由艺 / ArtVenn"
      className={`${styles.mark} ${styles.icon}`}
      data-admin-brand="icon"
      role="img"
    />
  );
}
