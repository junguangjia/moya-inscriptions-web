import { Icon } from "@moya/ui";
import { QuickActionIcon } from "../quick-actions/quick-action-card-action";
export function CategoryIcon({
  kind,
}: {
  kind: "followers" | "reactions" | "comments";
}) {
  return kind === "reactions" ? (
    <QuickActionIcon action="like" />
  ) : kind === "comments" ? (
    <Icon name="message" aria-hidden="true" />
  ) : (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="3" />
      <path
        d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"
        strokeLinecap="round"
      />
    </svg>
  );
}
