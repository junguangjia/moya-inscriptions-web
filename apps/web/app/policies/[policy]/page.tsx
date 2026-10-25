import { notFound } from "next/navigation";
import { policies } from "../content";
export default async function PolicyPage({
  params,
}: {
  params: Promise<{ policy: string }>;
}) {
  const { policy } = await params;
  if (!Object.prototype.hasOwnProperty.call(policies, policy)) notFound();
  const document = policies[policy as keyof typeof policies];
  return (
    <main style={{ maxWidth: "44rem", margin: "0 auto", padding: "1.5rem" }}>
      <nav aria-label="政策导航">
        <a href="/policies">规则与帮助</a> · <a href="/">返回由于艺</a>
      </nav>
      <h1>{document.title}</h1>
      {document.sections.map(([title, text]) => (
        <section key={title}>
          <h2>{title}</h2>
          <p>{text}</p>
        </section>
      ))}
      <p>
        <a href="/appeal-login">账号停用后的申诉入口</a>
      </p>
    </main>
  );
}
