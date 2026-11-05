"use client";

import { useState } from "react";

import type { ConsentDisplay, ConsentTool } from "./consent";

import styles from "./connections.module.css";

/**
 * The consent form. One POST, one decision, and the browser then goes back to
 * the provider so IT can resume its own interaction with its own cookie.
 *
 * The ticket is a hidden value this page was rendered with. It is the CSRF
 * defence and it is bound to the transaction rather than to the session: a
 * request that cannot produce it did not come from a page the server rendered
 * to this human. Nothing here relies on `SameSite` for that, which is the
 * point — the whole flow exists because Strict withheld the cookie once
 * already.
 *
 * The Owner's cookie never travels to the provider. `credentials:
 * "same-origin"` keeps it on this origin, and the navigation afterwards
 * carries the interaction uid and, under `operator`, the one-time resume secret.
 *
 * Two pages share this form. The Development read-only profile keeps its own, which
 * its measured harness reads. Under `operator` the page speaks to an administrator
 * who may know little about computers: what the tool can do, what it cannot, who is
 * named on the record and where the browser goes next, with no client id, URL or
 * scope on screen. Those stay in `data-*` attributes for tests. Every name on it
 * comes from the closed list, never from the request.
 */
export const AgentConsentClient = ({
  display,
  person,
  ticket,
}: {
  readonly display: ConsentDisplay;
  /** The signed-in person's account, as the audit row will name them. */
  readonly person: string;
  readonly ticket: string;
}) => {
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  const [code, setCode] = useState<string | null>(null);

  const decide = async (decision: "approve" | "deny") => {
    setState("sending");
    setCode(null);
    try {
      const response = await fetch("/api/agent-connections/consent", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          interaction: display.interaction,
          ticket,
          decision,
        }),
      });
      const payload: unknown = await response.json();
      const result =
        typeof payload === "object" && payload !== null
          ? (payload as { ok?: unknown; error?: unknown; result?: unknown })
          : {};
      if (!response.ok || result.ok !== true) {
        setCode(typeof result.error === "string" ? result.error : "REFUSED");
        setState("failed");
        return;
      }
      const resume = (result.result as { resume?: unknown }).resume;
      if (typeof resume !== "string") {
        setCode("RESUME_MISSING");
        setState("failed");
        return;
      }
      // A full navigation, not a fetch: the provider must see this as a
      // top-level request from the browser so its own interaction cookie is
      // sent. The URL is the server's, built from frozen configuration.
      window.location.assign(resume);
    } catch {
      setCode("NETWORK");
      setState("failed");
    }
  };

  if (display.tool !== undefined)
    return (
      <OperatorConsent
        code={code}
        decide={decide}
        display={display}
        person={person}
        state={state}
        tool={display.tool}
      />
    );

  return (
    <section data-agent-consent={display.interaction}>
      <h2>确认 AI 连接</h2>
      <dl>
        <dt>应用</dt>
        <dd data-agent-consent-client>{display.client}</dd>
        <dt>访问对象</dt>
        <dd data-agent-consent-resource>{display.resource}</dd>
        <dt>环境</dt>
        <dd data-agent-consent-environment>{display.environment}</dd>
        <dt>权限</dt>
        <dd data-agent-consent-scopes>
          {display.capabilities.join(" ")}（只读）
        </dd>
        {display.protocol.length > 0 ? (
          <>
            <dt>协议</dt>
            <dd data-agent-consent-protocol>{display.protocol.join(" ")}</dd>
          </>
        ) : null}
        <dt>有效期至</dt>
        <dd data-agent-consent-expires>{display.expiresAt}</dd>
      </dl>
      <p>
        同意后，这个应用可以只读地访问上述范围。它不能修改、发布或删除任何内容，
        也不能代你审批操作。你可以随时在「AI 连接」页面断开。
      </p>
      <p>
        <button
          data-agent-consent-approve
          disabled={state === "sending"}
          onClick={() => void decide("approve")}
          type="button"
        >
          同意
        </button>{" "}
        <button
          data-agent-consent-deny
          disabled={state === "sending"}
          onClick={() => void decide("deny")}
          type="button"
        >
          拒绝
        </button>
      </p>
      {state === "failed" ? (
        <p data-agent-consent-error={code ?? "REFUSED"} role="alert">
          这次授权没有完成：{code ?? "REFUSED"}。请回到应用重新发起。
        </p>
      ) : null}
    </section>
  );
};

/** Where the browser returns, in the person's words, a local tool's host included. */
const returnSentence = (tool: ConsentTool): string =>
  tool.local
    ? `授权完成后，浏览器只会回到这台电脑上的程序（${tool.callbackHosts.join("、")}）。`
    : `授权完成后，浏览器会回到：${tool.callbackHosts.join("、")}`;

const OperatorConsent = ({
  code,
  decide,
  display,
  person,
  state,
  tool,
}: {
  readonly code: string | null;
  readonly decide: (decision: "approve" | "deny") => Promise<void>;
  readonly display: ConsentDisplay;
  readonly person: string;
  readonly state: "idle" | "sending" | "failed";
  readonly tool: ConsentTool;
}) => (
  <section
    className={styles.consent}
    data-agent-consent={display.interaction}
    data-agent-consent-callback-hosts={tool.callbackHosts.join(" ")}
    data-agent-consent-client={display.client}
    data-agent-consent-environment={display.environment}
    data-agent-consent-expires={display.expiresAt}
    data-agent-consent-local={tool.local}
    data-agent-consent-resource={display.resource}
    data-agent-consent-scopes={display.capabilities.join(" ")}
  >
    <h1 className={styles.consentTitle}>「{tool.label}」想连接由于艺后台</h1>
    {/* One string each, because JSX turns a line break into a space between Chinese sentences. */}
    <p className={styles.consentText}>
      {`允许后，它会以「AI 操作账号」的身份，不用你逐条确认，就能做后台里几乎所有的事：查看和修改内容、审核、发布、处理举报和申诉、封禁用户、查看数据。它读到的内容会发送给 ${tool.label} 的提供方 ${tool.vendor}。`}
    </p>
    <p className={styles.consentText}>
      它不能：管理账号和密钥、动暂停开关、看或改操作记录、改敏感开关。
    </p>
    <p className={styles.consentText}>
      {`所有操作都会留下记录，并写明是你（${person}）授权的。你和其他管理员随时可以在「AI 连接」页断开。`}
    </p>
    <p className={styles.consentText} data-agent-consent-return>
      {returnSentence(tool)}
    </p>
    <p className={styles.consentWarning}>
      {
        "只有你刚刚自己在这个工具里点了「连接」，才点允许。如果是别人发来的链接，请点拒绝。"
      }
    </p>
    <div className={styles.consentActions}>
      <button
        className={styles.consentAllow}
        data-agent-consent-approve
        disabled={state === "sending"}
        onClick={() => void decide("approve")}
        type="button"
      >
        允许
      </button>
      <button
        className={styles.consentDeny}
        data-agent-consent-deny
        disabled={state === "sending"}
        onClick={() => void decide("deny")}
        type="button"
      >
        拒绝
      </button>
    </div>
    {state === "failed" ? (
      <p
        className={styles.consentText}
        data-agent-consent-error={code ?? "REFUSED"}
        role="alert"
      >
        这次连接没有完成，请回到工具重新点连接。{" "}
        <small className={styles.code}>{code ?? "REFUSED"}</small>
      </p>
    ) : null}
  </section>
);
