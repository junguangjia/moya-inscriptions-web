/**
 * Clipboard image paste for the media step (Q02). Pasted images are the
 * clipboard's copy, never a camera original: they enter staging with the
 * `paste` origin, which labels them 来自剪贴板. Text pastes into text fields
 * are left alone; nothing here reads the clipboard without a paste gesture.
 */

const isEditableTarget = (target: EventTarget | null): boolean => {
  if (typeof Element === "undefined" || !(target instanceof Element))
    return false;
  if (target.closest("input, textarea, select") !== null) return true;
  const editable = target.closest("[contenteditable]");
  return (
    editable !== null && editable.getAttribute("contenteditable") !== "false"
  );
};

/** Image files carried by one paste (files first, then file items). */
export const clipboardImageFiles = (data: DataTransfer | null): File[] => {
  if (data === null) return [];
  const files: File[] = [];
  const seen = new Set<File>();
  const add = (file: File | null) => {
    if (file === null || seen.has(file)) return;
    // The browser type only pre-filters clipboard kinds; staging identifies bytes.
    if (file.type !== "" && !file.type.startsWith("image/")) return;
    seen.add(file);
    files.push(file);
  };
  for (const file of Array.from(data.files ?? [])) add(file);
  if (files.length === 0)
    for (const item of Array.from(data.items ?? []))
      if (item.kind === "file") add(item.getAsFile());
  return files;
};

/**
 * Whether this paste belongs to the media step: it carries images, and it is
 * not a text paste into a text field (a field keeps its text when the
 * clipboard also offers text).
 */
export const imagesForMediaPaste = (event: ClipboardEvent): File[] => {
  const files = clipboardImageFiles(event.clipboardData);
  if (files.length === 0) return [];
  if (
    isEditableTarget(event.target) &&
    (event.clipboardData?.types ?? []).includes("text/plain")
  )
    return [];
  return files;
};

/**
 * Listens for image pastes on `target` while the media step is mounted.
 * `active` refuses a paste (leaving it untouched) while selection is not
 * possible or a modal dialog is open over the editor. A paste another
 * listener already took is never staged a second time.
 */
export const attachPasteCapture = (
  target: Pick<Document, "addEventListener" | "removeEventListener">,
  onImages: (files: File[]) => void,
  active: () => boolean = () => true,
): (() => void) => {
  const listener = (event: Event) => {
    if (event.defaultPrevented || !active()) return;
    const files = imagesForMediaPaste(event as ClipboardEvent);
    if (files.length === 0) return;
    event.preventDefault();
    onImages(files);
  };
  target.addEventListener("paste", listener);
  return () => target.removeEventListener("paste", listener);
};
