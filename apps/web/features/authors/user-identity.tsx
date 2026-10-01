import styles from "./user-identity.module.css";

/** Account decoration only: never substitutes for a nickname, handle or role. */
export const StudioName = ({
  value,
  prominent = false,
}: {
  value?: string | undefined;
  prominent?: boolean;
}) =>
  value ? (
    <span
      className={`${styles.studio} ${prominent ? styles.prominent : ""}`}
      aria-label={`斋号：${value}`}
      data-studio-name=""
    >
      {value}
    </span>
  ) : null;

export const UserIdentity = ({
  name,
  studioName,
}: {
  name: string;
  studioName?: string | undefined;
}) => (
  <span className={styles.identity}>
    <span className={styles.name}>{name}</span>
    <StudioName value={studioName} />
  </span>
);
