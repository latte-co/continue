import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type RefObject,
} from "react";

const stack: HTMLElement[] = [];
const overlayLayers: HTMLElement[] = [];
const MODAL_BASE_Z_INDEX = 200;

function syncOverlayLayers() {
  overlayLayers.forEach((layer, index) => {
    layer.style.zIndex = String(MODAL_BASE_Z_INDEX + index * 10);
  });
}

function registerOverlayLayer(layer: HTMLElement): () => void {
  const existing = overlayLayers.indexOf(layer);
  if (existing >= 0) overlayLayers.splice(existing, 1);
  overlayLayers.push(layer);
  syncOverlayLayers();
  return () => {
    const idx = overlayLayers.indexOf(layer);
    if (idx >= 0) {
      overlayLayers.splice(idx, 1);
      layer.style.removeProperty("z-index");
      syncOverlayLayers();
    }
  };
}

/**
 * Participates in the shared chronological overlay z-index stack for non-Modal
 * dialog surfaces (such as BrowserSiteInfo) that can spawn child Modal confirmations.
 */
export function useOverlayLayer(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
) {
  useLayoutEffect(() => {
    if (!active || !ref.current) return;
    return registerOverlayLayer(ref.current);
  }, [ref, active]);
}

export function isHiddenOrInert(item: HTMLElement | null): boolean {
  for (let cur = item; cur; cur = cur.parentElement) {
    if (cur.hidden || cur.inert || cur.hasAttribute("inert")) return true;
  }
  return false;
}

// Different dialogs may suspend the same background node. A previous-value
// snapshot per dialog would restore stale inert=true when both close together.
const inertOwners = new Map<
  HTMLElement,
  { count: number; previous: boolean }
>();
const canFocus = (item: HTMLElement) =>
  !item.matches(":disabled") &&
  !isHiddenOrInert(item) &&
  getComputedStyle(item).display !== "none" &&
  getComputedStyle(item).visibility !== "hidden" &&
  (!item.closest("details:not([open])") || item.tagName === "SUMMARY");
const tabbable = (item: HTMLElement) => item.tabIndex >= 0 && canFocus(item);
const focusable =
  "button, input, textarea, select, a[href], summary, [tabindex]";
/**
 * Shared modal focus trap, background `inert` lease, and z-index layer registration.
 * Supports both mount-bound `<Modal>` elements and persistent `active`-toggled shells.
 */
export function useModalBehavior(
  root: RefObject<HTMLElement | null>,
  active = true,
) {
  const wasActive = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  if (active && !wasActive.current) {
    trigger.current = document.activeElement as HTMLElement | null;
  }
  wasActive.current = active;

  useLayoutEffect(() => {
    const element = root.current;
    if (!active || !element) return;
    stack.push(element);
    const layerHost =
      element.closest<HTMLElement>(
        ".ui-dialog-backdrop, .modal-backdrop, .annotation-backdrop",
      ) ?? element;
    const releaseLayer = registerOverlayLayer(layerHost);
    const ancestors: HTMLElement[] = [];
    for (
      let node = trigger.current?.parentElement;
      node && node !== document.body;
      node = node.parentElement
    )
      ancestors.push(node);
    const inert: HTMLElement[] = [];
    let branch: HTMLElement = element;
    while (branch.parentElement) {
      for (const sibling of Array.from(branch.parentElement.children)) {
        if (sibling !== branch && sibling instanceof HTMLElement) {
          const owner = inertOwners.get(sibling) ?? {
            count: 0,
            previous: !!sibling.inert,
          };
          owner.count++;
          inertOwners.set(sibling, owner);
          inert.push(sibling);
          sibling.inert = true;
        }
      }
      branch = branch.parentElement;
      if (branch === document.body) break;
    }
    const candidates = () =>
      Array.from(element.querySelectorAll<HTMLElement>(focusable)).filter(
        tabbable,
      );
    if (!element.contains(document.activeElement))
      (candidates()[0] ?? element).focus();
    const key = (event: KeyboardEvent) => {
      if (
        stack.at(-1) !== element ||
        event.key !== "Tab" ||
        event.defaultPrevented
      )
        return;
      const items = candidates();
      const index = items.indexOf(document.activeElement as HTMLElement);
      event.preventDefault();
      (
        items[
          (index + (event.shiftKey ? -1 : 1) + items.length) % items.length
        ] ?? element
      ).focus();
    };
    const focus = (event: FocusEvent) => {
      if (stack.at(-1) === element && !element.contains(event.target as Node))
        (candidates()[0] ?? element).focus();
    };
    document.addEventListener("keydown", key);
    document.addEventListener("focusin", focus);
    return () => {
      stack.splice(stack.indexOf(element), 1);
      releaseLayer();
      document.removeEventListener("keydown", key);
      document.removeEventListener("focusin", focus);
      for (const item of inert) {
        const owner = inertOwners.get(item)!;
        if (--owner.count === 0) {
          // A page transition may already have removed inert explicitly.
          if (item.inert) item.inert = owner.previous;
          inertOwners.delete(item);
        }
      }
      const target = trigger.current;
      if (target?.isConnected && canFocus(target)) {
        target.focus();
        if (element.isConnected) {
          // React 19's flushMutationEffects restores priorFocusedElem at the end of
          // mutation commit when a persistent `hidden={!active}` dialog stays mounted.
          queueMicrotask(() => {
            if (
              target.isConnected &&
              canFocus(target) &&
              (document.activeElement === document.body ||
                element.contains(document.activeElement))
            ) {
              target.focus();
            }
          });
        }
      } else {
        // Wait for the closing subtree to be removed and all inert leases released.
        // A surviving parent dialog or the trigger's nearest live section is the
        // logical fallback; preserve any focus explicitly moved by the caller.
        queueMicrotask(() => {
          const activeEl = document.activeElement;
          if (
            activeEl instanceof HTMLElement &&
            activeEl !== document.body &&
            activeEl.isConnected &&
            !element.contains(activeEl) &&
            canFocus(activeEl)
          )
            return;
          const parent = stack.at(-1);
          const regions = parent ? [parent] : ancestors;
          for (const region of regions) {
            if (!region.isConnected || isHiddenOrInert(region)) continue;
            const candidate = Array.from(
              region.querySelectorAll<HTMLElement>(focusable),
            ).find(tabbable);
            if (candidate || region === parent) {
              (candidate ?? region).focus();
              return;
            }
          }
        });
      }
    };
  }, [root, active]);
}

/** Native modal behavior shared by every dialog. Nested dialogs suspend their parent. */
export function Modal(props: ComponentProps<"section">) {
  const root = useRef<HTMLElement>(null);
  useModalBehavior(root, true);
  return (
    <section
      {...props}
      ref={root}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
    />
  );
}
