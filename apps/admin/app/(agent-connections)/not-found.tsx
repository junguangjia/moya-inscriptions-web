import styles from "../../src/agent-connections/connections.module.css";

/** A person may reach this from an old link, so it speaks to them in a sentence. */
export default function ConsentNotFound() {
  return (
    <main className={styles.landing}>
      <h1 className={styles.consentTitle}>这个页面不存在</h1>
      <p className={styles.consentText}>
        如果你正在连接 AI 工具，请回到工具重新点连接。
      </p>
    </main>
  );
}
