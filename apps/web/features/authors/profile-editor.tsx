"use client";
import { useRef, useState } from "react";
import type { AuthorProfile } from "@moya/contracts";
import { normalizedStudioName } from "../auth/auth-api";
import { AuthorDialog } from "./author-dialog";
import { authorClient } from "./author-data";
import { useAuthors } from "./author-context";
import { requestIdentity } from "../shell/request-identity";
export const ProfileEditor = ({
  profile,
  onClose,
  onSaved,
}: {
  profile: AuthorProfile;
  onClose: () => void;
  onSaved: () => void;
}) => {
  const [name, setName] = useState(profile.displayName),
    [bio, setBio] = useState(profile.bio),
    [studioName, setStudioName] = useState(profile.studioName ?? ""),
    [saved, setSaved] = useState({
      name: profile.displayName,
      bio: profile.bio,
      studioName: profile.studioName ?? "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const author = useAuthors();
  const revision = useRef(0);
  const dirty =
    name !== saved.name || bio !== saved.bio || studioName !== saved.studioName;
  return (
    <AuthorDialog title="编辑资料" dirty={dirty} onClose={onClose}>
      <form
        className="phase4-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          if (normalizedStudioName(studioName) === null) {
            setError("斋号最多 6 个字。");
            return;
          }
          setBusy(true);
          setError("");
          const submitted = revision.current;
          try {
            await authorClient.command("me/profile", {
              requestId: requestIdentity(),
              displayName: name.trim(),
              bio: bio.trim(),
              studioName: studioName.trim(),
            });
            if (submitted === revision.current) {
              setName(name.trim());
              setBio(bio.trim());
              setStudioName(studioName.trim());
            }
            setSaved({
              name: name.trim(),
              bio: bio.trim(),
              studioName: studioName.trim(),
            });
            await author.refresh();
            onSaved();
            author.notify("资料已保存");
          } catch (e) {
            setError(e instanceof Error ? e.message : "保存失败");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          昵称
          <input
            value={name}
            maxLength={40}
            required
            onChange={(e) => {
              revision.current++;
              setName(e.target.value);
            }}
          />
        </label>
        <label>
          斋号（选填，最多 6 字）
          <input
            value={studioName}
            maxLength={12}
            onChange={(event) => {
              revision.current++;
              setStudioName(event.target.value);
            }}
          />
        </label>
        <label>
          简介
          <textarea
            value={bio}
            maxLength={500}
            onChange={(e) => {
              revision.current++;
              setBio(e.target.value);
            }}
          />
        </label>
        <label>
          账户名
          <input value={profile.handle} readOnly />
        </label>
        <label>
          身份标识
          <input value={profile.id} readOnly />
        </label>
        <p className="phase4-muted">昵称允许重名；身份标识保持不变。</p>
        <p role="status">{dirty ? "尚未保存" : "已保存"}</p>
        {error && (
          <p role="alert" className="phase4-error">
            {error}
          </p>
        )}
        <button
          className="phase4-button"
          disabled={busy || !dirty}
          type="submit"
        >
          {busy ? "正在保存…" : "保存"}
        </button>
      </form>
    </AuthorDialog>
  );
};
