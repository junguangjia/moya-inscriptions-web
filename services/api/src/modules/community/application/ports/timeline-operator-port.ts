import type {
  CreateTimelineEntryCommand,
  OperatorTimelineEntry,
  ReorderTimelineCommand,
  TimelineReorderResult,
  UpdateTimelineEntryCommand,
} from "@moya/contracts/internal/community-operator";

/**
 * home-timeline-v1 (Issue #384 r3): the operator side of the Home timeline,
 * for the Owner's route and the AI's. The store is the master of the rows; the
 * public read stays on the discovery port. Every command is receipted and
 * audited through the content-operator tables, takes the shared
 * content-operator lock and checks the whole set as it would be stored, so a
 * refusal names its rule (`CommunityNamedConflictError`) and writes nothing.
 */
export interface TimelineOperatorPort {
  /**
   * Every stored row in the public read's order (start year, position, id),
   * hidden ones included, each with its link state; at most one past the
   * contract's maximum.
   */
  operatorTimelineEntries(): Promise<OperatorTimelineEntry[]>;
  operatorCreateTimelineEntry(
    operator: string,
    command: CreateTimelineEntryCommand,
  ): Promise<OperatorTimelineEntry>;
  operatorUpdateTimelineEntry(
    operator: string,
    id: string,
    command: UpdateTimelineEntryCommand,
  ): Promise<OperatorTimelineEntry>;
  /** One start year's rows in a new order, all or none. */
  operatorReorderTimeline(
    operator: string,
    command: ReorderTimelineCommand,
  ): Promise<TimelineReorderResult>;
}
