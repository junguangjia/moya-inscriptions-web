"use client";

import { useId, useState } from "react";
import type { Ref } from "react";
import { studioNameInput } from "../auth/auth-api";
export { studioNameInput } from "../auth/auth-api";
import { StudioName } from "./user-identity";
import styles from "./studio-name-field.module.css";

const suffixes = ["斋", "堂", "室", "房", "庐"] as const;

export const StudioNameField = ({
  name,
  suffix,
  onChange,
  disabled = false,
  invalid = false,
  describedBy,
  inputRef,
  inputId,
}: {
  name: string;
  suffix: string;
  onChange: (name: string, suffix: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string | undefined;
  inputRef?: Ref<HTMLInputElement>;
  inputId?: string;
}) => {
  const id = useId();
  const [custom, setCustom] = useState(!suffixes.some((s) => s === suffix));
  const [customDraft, setCustomDraft] = useState(custom ? suffix : "");
  const [composing, setComposing] = useState(false);
  const parsed = studioNameInput(name, suffix);
  const hintId = `${id}-hint`;
  const limit = (value: string, maximum: number) =>
    [...value].slice(0, maximum).join("");
  return (
    <fieldset className={styles.field} disabled={disabled}>
      <legend>
        斋号 <span>选填</span>
      </legend>
      <div className={styles.inputs}>
        <label className={styles.name} htmlFor={inputId ?? `${id}-name`}>
          名称
          <input
            id={inputId ?? `${id}-name`}
            ref={inputRef}
            value={name}
            placeholder="如：听雨"
            autoComplete="off"
            aria-invalid={invalid || undefined}
            aria-describedby={[hintId, describedBy].filter(Boolean).join(" ")}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setComposing(false);
              onChange(limit(event.currentTarget.value, 5), suffix);
            }}
            onChange={(event) =>
              onChange(
                composing ? event.target.value : limit(event.target.value, 5),
                suffix,
              )
            }
          />
        </label>
        <label className={styles.suffix}>
          称谓
          <select
            value={custom ? "other" : suffix}
            onChange={(event) => {
              const other = event.target.value === "other";
              setCustom(other);
              onChange(name, other ? customDraft : event.target.value);
            }}
          >
            {suffixes.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
            <option value="other">其他</option>
          </select>
        </label>
      </div>
      {custom && (
        <label className={styles.custom}>
          自定义称谓
          <input
            value={suffix}
            placeholder="最多 2 字，如：书屋"
            aria-invalid={invalid || undefined}
            aria-describedby={[hintId, describedBy].filter(Boolean).join(" ")}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(event) => {
              setComposing(false);
              const value = limit(event.currentTarget.value, 2);
              setCustomDraft(value);
              onChange(name, value);
            }}
            onChange={(event) => {
              const value = composing
                ? event.target.value
                : limit(event.target.value, 2);
              setCustomDraft(value);
              onChange(name, value);
            }}
          />
        </label>
      )}
      <p className={styles.hint} id={hintId}>
        名称最多 5 字，称谓最多 2 字；留空即可。
      </p>
      {parsed.success && parsed.data.studioName && (
        <p className={styles.preview} aria-live="polite">
          <span>显示为</span>
          <StudioName value={parsed.data.studioName} prominent />
        </p>
      )}
    </fieldset>
  );
};
