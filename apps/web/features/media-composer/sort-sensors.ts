"use client";

import {
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

import type { PointerSensorOptions } from "@dnd-kit/core";
import type { PointerEvent } from "react";

/**
 * The one sorting input of the Media Composer, shared by the publishing
 * strip and the phone 编辑 strip (#244): pointer drag for mouse and pen, a
 * long-press (~250 ms) drag on touch so a swipe still scrolls, and the
 * keyboard sensor with sortable coordinates.
 */

/** Mouse and pen only: touch input goes to the long-press TouchSensor. */
export class MousePenSensor extends PointerSensor {
  static override activators = [
    {
      eventName: "onPointerDown" as const,
      handler: (event: PointerEvent, options: PointerSensorOptions): boolean =>
        event.nativeEvent.pointerType !== "touch" &&
        PointerSensor.activators[0]!.handler(event, options),
    },
  ];
}

export const TOUCH_SORT_DELAY_MS = 250;

export interface MediaSortSensorOptions {
  /**
   * The author asked for reduced motion: a keyboard move scrolls the
   * scroller at once (`auto`) instead of smoothly. Off by default.
   */
  readonly reducedMotion?: boolean | undefined;
}

export const useMediaSortSensors = ({
  reducedMotion = false,
}: MediaSortSensorOptions = {}) =>
  useSensors(
    useSensor(MousePenSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: TOUCH_SORT_DELAY_MS, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      scrollBehavior: reducedMotion ? "auto" : "smooth",
    }),
  );

/** How long the lift tick lasts (mockup B: `navigator.vibrate(8)`). */
export const LIFT_VIBRATION_MS = 8;

/**
 * A short tick as a held thumbnail lifts under a finger: pass it as (or call
 * it from) `DndContext`'s `onDragStart`. Touch lifts only; mouse, pen and
 * keyboard lifts stay silent, and a browser that refuses vibration is fine.
 */
export const liftTick = ({
  activatorEvent,
}: {
  /** `DragStartEvent.activatorEvent`; null is tolerated. */
  readonly activatorEvent: Event | null;
}): void => {
  if (activatorEvent === null || !("touches" in activatorEvent)) return;
  try {
    navigator.vibrate?.(LIFT_VIBRATION_MS);
  } catch {
    // Some browsers refuse vibration; the lift is shown anyway.
  }
};
