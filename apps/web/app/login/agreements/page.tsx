import { Icon } from "@moya/ui/brand";
export default function AgreementsPage() {
  return (
    <main>
      <a
        aria-label="返回注册"
        className="yoyi-icon-button yoyi-icon-button--quiet yoyi-icon-button--md"
        href="/register"
      >
        <Icon name="back" />
      </a>
      <h1>服务条款与隐私</h1>
      <p>
        <a href="/policies/terms">服务条款</a> ·{" "}
        <a href="/policies/privacy">隐私政策</a>
      </p>
      <p>
        <a href="/policies/community">社区规则</a> ·{" "}
        <a href="/policies/reporting">举报、投诉与申诉</a>
      </p>
    </main>
  );
}
