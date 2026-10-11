// @vitest-environment jsdom
import { KeyboardSensor, TouchSensor } from "@dnd-kit/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LIFT_VIBRATION_MS,
  MousePenSensor,
  TOUCH_SORT_DELAY_MS,
  liftTick,
  useMediaSortSensors,
} from "./sort-sensors";

import type { MediaSortSensorOptions } from "./sort-sensors";
import type { SensorDescriptor, SensorOptions } from "@dnd-kit/core";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sensorsOf = (options?: MediaSortSensorOptions) => {
  let result: SensorDescriptor<SensorOptions>[] = [];
  const Probe = () => {
    result = useMediaSortSensors(options);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => root.unmount());
  return result;
};

const optionsOf = (
  sensors: SensorDescriptor<SensorOptions>[],
  sensor: unknown,
) => sensors.find((entry) => entry.sensor === sensor)?.options;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMediaSortSensors", () => {
  it("drags with mouse and pen at 6px, touch after a long press, and the keyboard", () => {
    const sensors = sensorsOf();
    expect(sensors.map((entry) => entry.sensor)).toEqual([
      MousePenSensor,
      TouchSensor,
      KeyboardSensor,
    ]);
    expect(optionsOf(sensors, MousePenSensor)).toEqual({
      activationConstraint: { distance: 6 },
    });
    expect(optionsOf(sensors, TouchSensor)).toEqual({
      activationConstraint: { delay: TOUCH_SORT_DELAY_MS, tolerance: 8 },
    });
    expect(TOUCH_SORT_DELAY_MS).toBe(250);
  });

  it("scrolls smoothly on a keyboard move by default, at once with reduced motion", () => {
    expect(optionsOf(sensorsOf(), KeyboardSensor)).toMatchObject({
      scrollBehavior: "smooth",
    });
    expect(
      optionsOf(sensorsOf({ reducedMotion: false }), KeyboardSensor),
    ).toMatchObject({ scrollBehavior: "smooth" });
    expect(
      optionsOf(sensorsOf({ reducedMotion: true }), KeyboardSensor),
    ).toMatchObject({ scrollBehavior: "auto" });
  });
});

describe("liftTick", () => {
  it("ticks once for a touch lift only", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", { ...navigator, vibrate });
    liftTick({ activatorEvent: new Event("pointerdown") });
    liftTick({ activatorEvent: null });
    expect(vibrate).not.toHaveBeenCalled();
    const touch = Object.assign(new Event("touchstart"), { touches: [] });
    liftTick({ activatorEvent: touch });
    expect(vibrate).toHaveBeenCalledOnce();
    expect(vibrate).toHaveBeenCalledWith(LIFT_VIBRATION_MS);
    expect(LIFT_VIBRATION_MS).toBe(8);
  });

  it("lifts quietly where vibration is missing or refused", () => {
    const touch = Object.assign(new Event("touchstart"), { touches: [] });
    vi.stubGlobal("navigator", { ...navigator, vibrate: undefined });
    expect(() => liftTick({ activatorEvent: touch })).not.toThrow();
    vi.stubGlobal("navigator", {
      ...navigator,
      vibrate: () => {
        throw new Error("refused");
      },
    });
    expect(() => liftTick({ activatorEvent: touch })).not.toThrow();
  });
});
