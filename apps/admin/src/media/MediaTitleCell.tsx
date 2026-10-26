"use client";

import type { ComponentProps } from "react";
import { DefaultCell } from "@payloadcms/ui";

type NativeCellProps = ComponentProps<typeof DefaultCell>;
type TextCellProps = Omit<NativeCellProps, "field"> & {
  field: Extract<NativeCellProps["field"], { type: "text" }>;
};

/** Use Payload's native upload preview with the human description as its label. */
export const MediaTitleCell = (props: TextCellProps) => (
  <DefaultCell
    {...props}
    field={{ ...props.field, name: "filename" }}
    cellData={
      typeof props.rowData.alt === "string" && props.rowData.alt
        ? props.rowData.alt
        : "未填写图片说明"
    }
  />
);
