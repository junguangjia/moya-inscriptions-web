/**
 * Pointer capture for a crop handle (the article crop's, #341): a drag keeps
 * its pointer however far the finger strays. Both ends tolerate a pointer
 * the system already took away (WebKit throws `InvalidPointerId`); its
 * cancel event ends the drag instead.
 */

export const capturePointer = (element: Element, pointerId: number) => {
  if (typeof element.setPointerCapture !== "function") return;
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Cancelled meanwhile: pointercancel ends the drag.
  }
};

export const releasePointer = (element: Element, pointerId: number) => {
  if (typeof element.hasPointerCapture !== "function") return;
  try {
    if (element.hasPointerCapture(pointerId))
      element.releasePointerCapture(pointerId);
  } catch {
    // Already gone with its pointer.
  }
};
