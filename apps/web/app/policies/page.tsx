import { policies } from "./content";
export default function PoliciesPage() {
  return (
    <main style={{ maxWidth: "44rem", margin: "0 auto", padding: "1.5rem" }}>
      <a href="/">返回由于艺</a>
      <h1>规则与帮助</h1>
      <ul>
        {Object.entries(policies).map(([key, value]) => (
          <li key={key}>
            <a href={`/policies/${key}`}>{value.title}</a>
          </li>
        ))}
      </ul>
      <p>
        <a href="/appeal-login">账号停用后的申诉入口</a>
      </p>
    </main>
  );
}
