"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { AuthorProfile } from "@moya/contracts";
import { useAuthors } from "../authors/author-context";
import { authorClient, AuthorRequestError } from "../authors/author-data";
import { ProfileEditor } from "../authors/profile-editor";
import { ProfileSettings } from "../authors/profile-settings";
import { useProductShell } from "../product-shell/product-shell";

const focusableOpener = (node: Element | null | undefined) =>
  node instanceof HTMLElement &&
  node !== document.body &&
  node !== document.documentElement &&
  node.matches("button, a[href], input, select, textarea, [tabindex]")
    ? node
    : null;

/** One complete settings surface, outside the pager's hidden primary pages. */
export const ProductSettingsHost = ({
  open,
  onOpen,
  onClose,
  initialOpener,
  onDeparture,
}: {
  readonly open: boolean;
  readonly onOpen: (opener?: HTMLElement) => void;
  readonly onClose: () => void;
  readonly initialOpener?: HTMLElement | null | undefined;
  readonly onDeparture?: (() => void) | undefined;
}) => {
  const author = useAuthors();
  const shell = useProductShell();
  const actor = author.viewer?.id ?? null;
  const [editing, setEditing] = useState(false);
  const [retry, setRetry] = useState(0);
  const opener = useRef<HTMLElement | null>(null);
  const requestedOpener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const focusFrame = useRef<number | null>(null);
  const [read, setRead] = useState<{
    actor: string | null;
    profile: AuthorProfile | null;
    error: string;
  }>({ actor: null, profile: null, error: "" });
  const cached = actor
    ? (author.cache.get(`profile:${actor}`) as AuthorProfile | undefined)
    : undefined;
  const candidate = read.actor === actor ? read.profile : cached;
  const profile =
    actor && candidate?.id === actor && candidate.isOwner ? candidate : null;
  const error = author.sessionError
    ? "账户状态暂时无法确认，请重试。"
    : read.actor === actor
      ? read.error
      : "";

  const requestOpen = useCallback(
    (element: HTMLElement) => {
      requestedOpener.current = element;
      onOpen(element);
    },
    [onOpen],
  );
  useLayoutEffect(
    () => shell.registerSettingsIntent(requestOpen),
    [shell.registerSettingsIntent, shell.settingsOpen, requestOpen],
  );
  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const active = document.activeElement;
      opener.current =
        focusableOpener(initialOpener) ??
        focusableOpener(requestedOpener.current) ??
        (!active?.closest("dialog") ? focusableOpener(active) : null);
      requestedOpener.current = null;
    }
    wasOpen.current = open;
  }, [open, initialOpener]);
  useEffect(
    () => () => {
      if (focusFrame.current !== null) cancelAnimationFrame(focusFrame.current);
    },
    [],
  );
  useEffect(() => setEditing(false), [actor, open]);
  useEffect(() => {
    if (!open || !actor || author.checking || author.sessionError) return;
    let current = true;
    const key = `profile:${actor}`;
    const previous = author.cache.get(key) as AuthorProfile | undefined;
    setRead((old) => ({
      actor,
      profile:
        previous?.id === actor && previous.isOwner
          ? previous
          : old.actor === actor
            ? old.profile
            : null,
      error: "",
    }));
    void authorClient.profile(actor).then(
      (next) => {
        if (!current) return;
        if (next.id !== actor || !next.isOwner) {
          setRead({
            actor,
            profile: null,
            error: "账户资料暂时无法读取，请重试。",
          });
          return;
        }
        author.cache.set(key, next);
        setRead({ actor, profile: next, error: "" });
      },
      (reason: unknown) => {
        if (current)
          setRead((old) => ({
            actor,
            profile: old.actor === actor ? old.profile : null,
            error:
              reason instanceof AuthorRequestError
                ? reason.message
                : "账户资料暂时无法读取，请重试。",
          }));
      },
    );
    return () => {
      current = false;
    };
  }, [
    open,
    actor,
    author.checking,
    author.sessionError,
    author.revision,
    author.cache,
    retry,
  ]);

  const refreshProfile = useCallback(() => {
    if (actor) author.cache.delete(`profile:${actor}`);
    author.mutate();
    setRetry((value) => value + 1);
  }, [actor, author.cache, author.mutate]);
  const retryRead = () => {
    if (author.sessionError) void author.refresh();
    setRetry((value) => value + 1);
  };
  const finishClose = () => {
    onClose();
    focusFrame.current = requestAnimationFrame(() => {
      focusFrame.current = null;
      const target =
        opener.current?.isConnected &&
        opener.current.getBoundingClientRect().width > 0 &&
        !opener.current.closest('[hidden], [inert], [aria-hidden="true"]')
          ? opener.current
          : [
              ...document.querySelectorAll<HTMLElement>(
                'button[aria-label="设置"]',
              ),
            ].find(
              (node) =>
                node.getBoundingClientRect().width > 0 &&
                !node.closest('[hidden], [inert], [aria-hidden="true"]'),
            );
      target?.focus({ preventScroll: true });
    });
  };
  if (!open) return null;
  if (editing && profile)
    return (
      <ProfileEditor
        key={profile.id}
        profile={profile}
        onClose={() => setEditing(false)}
        onSaved={refreshProfile}
      />
    );
  return (
    <ProfileSettings
      key={actor ?? "guest"}
      profile={profile}
      onClose={finishClose}
      onDeparture={onDeparture}
      onSaved={refreshProfile}
      onEdit={profile ? () => setEditing(true) : undefined}
      accountRead={{
        loading: author.checking || Boolean(actor && !profile && !error),
        error,
        onRetry: retryRead,
      }}
    />
  );
};
