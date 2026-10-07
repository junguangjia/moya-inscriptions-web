"use client";
import type { CSSProperties } from "react";
import type { CoverDevice, HeaderBox } from "./profile-cover";
import { HeaderGhost } from "./profile-cover-stage";
import type { CoverIdentity } from "./profile-cover-stage";
import presentation from "../user/user-presentation.module.css";
import styles from "./profile-background-editor.module.css";

/**
 * A scaled replica of the owner's header built from the live cover classes,
 * so its anchor, panel fade and theme cannot drift from the real profile.
 */
export const ProfileCoverPreview = ({
  src,
  header,
  device,
  identity,
}: {
  src: string | null;
  header: HeaderBox;
  device: CoverDevice;
  identity: CoverIdentity;
}) => (
  <div
    className={styles.preview}
    data-device={device}
    data-cover-preview={device}
    aria-hidden="true"
    style={
      {
        aspectRatio: `${header.width} / ${header.height}`,
        // One header pixel in the replica, for the live blur and fade.
        "--cover-px": `${100 / header.width}cqw`,
      } as CSSProperties
    }
  >
    <div className={presentation.profileCover}>
      {src && <img src={src} alt="" />}
    </div>
    <HeaderGhost header={header} identity={identity} />
  </div>
);
