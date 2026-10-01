import { notFound } from "next/navigation";

export default function AgreementsPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return (
    <main style={{ maxWidth: "40rem", margin: "0 auto", padding: "24px 16px" }}>
      <h1>开发环境注册说明</h1>
      <p>这是开发环境草稿，不是已批准的用户协议或隐私政策。</p>
      <p>
        注册只创建由于艺
        的公开账户，用来登录、绑定邮箱或手机号，以及继续使用现有的作品与评论功能。验证邮箱或手机号不是身份证实名，也不是人脸核验。
      </p>
      <p>
        正式上线前需要替换为已批准的法律文本。这里没有客服渠道，也没有账户注销流程。
      </p>
      <p>
        <a href="/register">返回注册</a>
      </p>
    </main>
  );
}
