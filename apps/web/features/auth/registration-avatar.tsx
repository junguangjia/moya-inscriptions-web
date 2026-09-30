"use client";

import { useEffect, useRef, useState } from "react";
import type { AuthorProfile } from "@moya/contracts";
import { Button } from "@moya/ui";
import { AuthorProvider, useAuthors } from "../authors/author-context";
import { authorClient } from "../authors/author-data";
import { AvatarEntry } from "../authors/avatar-editor";
import styles from "./auth-flow.module.css";

const AvatarStep = ({
  expectedAccountId,
  onComplete,
}: {
  readonly expectedAccountId: string;
  readonly onComplete: () => void;
}) => {
  const author = useAuthors();
  const [profile, setProfile] = useState<AuthorProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const run = useRef(0);
  const account =
    author.viewer?.id === expectedAccountId ? author.viewer.id : undefined;
  useEffect(() => {
    const current = ++run.current;
    if (!account) {
      setProfile(null);
      setFailed(false);
      return;
    }
    // A focus check is not an account change. Keep the confirmed owner's
    // picker/crop mounted while /me and the background profile read settle.
    if (author.checking || author.sessionError) return;
    setFailed(false);
    void authorClient
      .profile(account)
      .then((value) => {
        if (
          current === run.current &&
          value.isOwner &&
          value.id === account &&
          authorClient.account() === account
        )
          setProfile(value);
        else if (current === run.current) {
          setProfile(null);
          setFailed(true);
        }
      })
      .catch(() => {
        if (current === run.current) setFailed(true);
      });
    return () => {
      run.current += 1;
    };
  }, [
    account,
    author.checking,
    author.sessionError,
    author.revision,
    revision,
  ]);
  const currentProfile =
    profile?.id === account &&
    (author.checking ||
      author.sessionError ||
      authorClient.account() === account)
      ? profile
      : null;
  const saving =
    author.avatarSave?.accountId === account ? author.avatarSave : null;
  const hasAvatar = Boolean(currentProfile?.avatar);
  return (
    <div className={styles.avatarStep} data-registration-avatar="">
      <div
        className={styles.avatarPreview}
        aria-label={hasAvatar ? "当前头像" : "默认头像"}
      >
        {currentProfile?.avatar ? (
          <img src={currentProfile.avatar.src} alt="" width={96} height={96} />
        ) : (
          <span aria-hidden="true">
            {author.viewer?.id === expectedAccountId
              ? ([...author.viewer.displayName][0] ?? "艺")
              : "艺"}
          </span>
        )}
      </div>
      {author.checking ? (
        <p className={styles.hint} role="status">
          正在确认账户…
        </p>
      ) : author.sessionError ? (
        <div role="alert">
          <p className={styles.fieldError}>
            账户已创建，暂时无法确认登录状态。
          </p>
          <Button variant="quiet" onClick={() => void author.refresh()}>
            重新确认账户
          </Button>
        </div>
      ) : !author.viewer ? (
        <p className={styles.fieldError} role="alert">
          账户已创建，请重新登录后设置头像。
        </p>
      ) : author.viewer.id !== expectedAccountId ? (
        <p className={styles.fieldError} role="alert">
          登录账户已变化，请返回原页面继续。
        </p>
      ) : failed ? (
        <div role="alert">
          <p className={styles.fieldError}>暂时无法获取头像设置。</p>
          <Button variant="quiet" onClick={() => setRevision((old) => old + 1)}>
            重试
          </Button>
        </div>
      ) : !currentProfile ? (
        <p className={styles.hint} role="status">
          正在获取头像设置…
        </p>
      ) : null}
      {saving && (
        <p
          className={saving.failed ? styles.fieldError : styles.hint}
          role={saving.failed ? "alert" : "status"}
        >
          {saving.message}
        </p>
      )}
      {currentProfile && (
        <AvatarEntry
          profile={currentProfile}
          className={hasAvatar ? styles.avatarChange : styles.avatarChoose}
        >
          <span>{hasAvatar ? "更换照片" : "选择照片"}</span>
        </AvatarEntry>
      )}
      {hasAvatar ? (
        <Button className={styles.primary} onClick={onComplete}>
          完成
        </Button>
      ) : (
        <Button variant="quiet" className={styles.skip} onClick={onComplete}>
          跳过
        </Button>
      )}
    </div>
  );
};

/** Registration has already completed. This boundary only confirms the existing
 * session and delegates optional avatar work to the existing author mechanism. */
export const RegistrationAvatar = ({
  expectedAccountId,
  onComplete,
}: {
  readonly expectedAccountId: string;
  readonly onComplete: () => void;
}) => (
  <AuthorProvider signInHref="/login">
    <AvatarStep expectedAccountId={expectedAccountId} onComplete={onComplete} />
  </AuthorProvider>
);
