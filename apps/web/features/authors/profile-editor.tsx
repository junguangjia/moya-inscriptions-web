"use client";
import { useId, useRef, useState } from "react";
import type { AuthorProfile } from "@moya/contracts";
import { StudioNameField, studioNameInput } from "./studio-name-field";
import { StudioName } from "./user-identity";
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
  const errorId = useId();
  const [studioInvalid, setStudioInvalid] = useState(false);
  const initialSuffix = profile.studioNameSuffix ?? "";
  const legacyStudio = Boolean(profile.studioName && !initialSuffix);
  const initialBase = initialSuffix
    ? (profile.studioName ?? "").slice(0, -initialSuffix.length)
    : "";
  const [editingStudio, setEditingStudio] = useState(!legacyStudio);
  const [studioTouched, setStudioTouched] = useState(false);
  const shouldWriteStudio = !legacyStudio || studioTouched;
  const [studioSuffix, setStudioSuffix] = useState(initialSuffix || "斋");
  const [name, setName] = useState(profile.displayName),
    [bio, setBio] = useState(profile.bio),
    [studioName, setStudioName] = useState(initialBase),
    [saved, setSaved] = useState({
      name: profile.displayName,
      bio: profile.bio,
      studioName: initialBase,
      studioSuffix: initialSuffix || "斋",
      studioTouched: false,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const author = useAuthors();
  const revision = useRef(0);
  const dirty =
    name !== saved.name ||
    bio !== saved.bio ||
    studioName !== saved.studioName ||
    studioSuffix !== saved.studioSuffix ||
    studioTouched !== saved.studioTouched;
  return (
    <AuthorDialog title="编辑资料" dirty={dirty} onClose={onClose}>
      <form
        className="phase4-form"
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          const studio = studioNameInput(studioName, studioSuffix);
          if (shouldWriteStudio && !studio.success) {
            setStudioInvalid(true);
            setError("斋号名称最多 5 字，称谓需要 1 到 2 字。");
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
              ...(shouldWriteStudio && studio.success ? studio.data : {}),
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
              studioSuffix,
              studioTouched,
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
        {legacyStudio && !studioTouched && editingStudio && (
          <p className="phase4-muted">
            现有斋号：{profile.studioName}。填写新名称后替换。
          </p>
        )}
        {editingStudio ? (
          <StudioNameField
            name={studioName}
            suffix={studioSuffix}
            disabled={busy}
            invalid={studioInvalid}
            describedBy={studioInvalid ? errorId : undefined}
            onChange={(nextName, suffix) => {
              revision.current++;
              if (nextName !== studioName) setStudioTouched(true);
              setStudioName(nextName);
              setStudioSuffix(suffix);
              setError("");
              setStudioInvalid(false);
            }}
          />
        ) : (
          <div>
            <p>
              斋号 <StudioName value={profile.studioName} prominent />
            </p>
            <button
              type="button"
              className="phase4-button"
              onClick={() => {
                revision.current++;
                setEditingStudio(true);
              }}
            >
              修改斋号
            </button>
          </div>
        )}
        {legacyStudio && !studioTouched && (
          <button
            type="button"
            className="phase4-button"
            onClick={() => {
              revision.current++;
              setStudioTouched(true);
              setEditingStudio(true);
              setStudioName("");
            }}
          >
            清除斋号
          </button>
        )}
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
          <p id={errorId} role="alert" className="phase4-error">
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
