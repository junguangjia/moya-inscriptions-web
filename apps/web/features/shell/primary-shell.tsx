import { useState, type ReactNode } from "react";

import type { PresentationPlatform } from "./device-platform";

export type PrimaryDestination = "home" | "discussion" | "user";

export interface PrimaryShellProps {
  readonly activeDestination: PrimaryDestination;
  readonly platform: PresentationPlatform;
  readonly home: ReactNode;
  readonly discussion: ReactNode;
  readonly user: ReactNode;
}

export const PrimaryShell = ({
  activeDestination,
  platform,
  home,
  discussion,
  user,
}: PrimaryShellProps) => {
  // 我 loads the viewer's profile, cover, avatar and works when it mounts.
  // Mount it the first time it is opened and keep it afterwards, so a start
  // on another destination downloads none of it.
  const [userOpened, setUserOpened] = useState(activeDestination === "user");
  if (activeDestination === "user" && !userOpened) setUserOpened(true);
  return (
    <div
      data-primary-shell=""
      data-active-destination={activeDestination}
      data-platform={platform}
    >
      <section
        data-primary-destination="home"
        data-active={activeDestination === "home" ? "true" : "false"}
        hidden={activeDestination !== "home"}
      >
        {home}
      </section>
      <section
        data-primary-destination="discussion"
        data-active={activeDestination === "discussion" ? "true" : "false"}
        hidden={activeDestination !== "discussion"}
      >
        {discussion}
      </section>
      <section
        data-primary-destination="user"
        data-active={activeDestination === "user" ? "true" : "false"}
        hidden={activeDestination !== "user"}
      >
        {userOpened || activeDestination === "user" ? user : null}
      </section>
    </div>
  );
};
