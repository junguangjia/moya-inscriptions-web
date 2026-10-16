"use client";
import type { ReactNode } from "react";
import {
  CatalogCardPresentation,
  CatalogCardRendererProvider,
} from "../home/catalog-card";
import type { CatalogCardProps } from "../home/catalog-card";
import { useBrowseOnly } from "../shell/browse-only-context";
import { ContentQuickActionsProvider } from "../quick-actions/content-quick-actions";
import { useContentActions } from "./content-actions";
const LiveCatalogCard = (props: CatalogCardProps) => {
  const target = { type: "catalog", id: props.item.id } as const;
  const actions = useContentActions(target, props.item.title);
  // Browse-only cards keep their plain opener: a click opens Detail, no
  // long-press menu. The provider stays so a resize does not remount cards.
  const browseOnly = useBrowseOnly();
  return (
    <ContentQuickActionsProvider
      environment={browseOnly ? undefined : actions.environment}
    >
      <CatalogCardPresentation {...props} />
    </ContentQuickActionsProvider>
  );
};
export const LiveCatalogCards = ({ children }: { children: ReactNode }) => (
  <CatalogCardRendererProvider component={LiveCatalogCard}>
    {children}
  </CatalogCardRendererProvider>
);
