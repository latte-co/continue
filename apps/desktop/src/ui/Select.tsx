import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import { isHiddenOrInert } from "../Modal";
import { useDefaultControlSize } from "./context";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  tone?: "warning";
}

export type SelectSize = "lg" | "md" | "sm";

/**
 * Application-owned combobox: native WebKit `<select>` menus cannot inherit custom
 * OKLCH dark/light themes. Supports `lg:36`, `md:32`, `sm:28` heights and `well`/`ghost` surfaces.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  disabled = false,
  minMenuWidth,
  align = "start",
  size,
  variant = "well",
  leading,
  placeholder = "请选择",
  compact = false,
  menuTitle,
  searchable = false,
  searchPlaceholder = "搜索选项",
  className,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  minMenuWidth?: number;
  align?: "start" | "end";
  size?: SelectSize;
  variant?: "well" | "ghost";
  leading?: ReactNode;
  placeholder?: string;
  compact?: boolean;
  menuTitle?: string;
  searchable?: boolean;
  searchPlaceholder?: string;
  className?: string;
}) {
  const contextSize = useDefaultControlSize();
  const effectiveSize: SelectSize =
    size ?? contextSize ?? (compact ? "sm" : "lg");
  const hasExplicitSize = !!(size || contextSize || compact);
  const isCompactMenu = compact || effectiveSize === "sm";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const filtered = searchable
    ? options.filter((option) =>
        `${option.label} ${option.description ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : options;
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
    maxHeight: 280,
  });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const id = useId();

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function show() {
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  }

  function choose(index: number) {
    if (!filtered[index]) return;
    onChange(filtered[index].value);
    setOpen(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const box = trigger.current.getBoundingClientRect();
    const hasDescriptions = filtered.some((o) => !!o.description);
    const optionHeight = isCompactMenu ? 36 : hasDescriptions ? 54 : 38;
    const height = Math.min(
      320,
      Math.max(1, filtered.length) * optionHeight +
        10 +
        (menuTitle ? 28 : 0) +
        (searchable ? 44 : 0),
    );
    const below = window.innerHeight - box.bottom - 12;
    const above = box.top - 12;
    const useBelow = below >= height || below >= above;
    const maxHeight = Math.max(60, Math.min(height, useBelow ? below : above));
    const width = Math.min(
      Math.max(box.width, minMenuWidth ?? 0),
      window.innerWidth - 16,
    );
    setPosition({
      left: Math.max(
        8,
        Math.min(
          align === "end" ? box.right - width : box.left,
          window.innerWidth - width - 8,
        ),
      ),
      top: useBelow ? box.bottom + 6 : box.top - maxHeight - 6,
      width,
      maxHeight,
    });
  }, [
    open,
    filtered.length,
    minMenuWidth,
    align,
    isCompactMenu,
    menuTitle,
    searchable,
  ]);

  useEffect(() => {
    if (open && searchable) search.current?.focus();
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (isHiddenOrInert(menu.current)) return;
      if (
        !trigger.current?.contains(e.target as Node) &&
        !menu.current?.contains(e.target as Node)
      )
        setOpen(false);
    };
    const resize = () => setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.isComposing || isHiddenOrInert(menu.current)) return;
      if (e.target === search.current && [" ", "Home", "End"].includes(e.key))
        return;
      if (
        ![
          "ArrowDown",
          "ArrowUp",
          "Home",
          "End",
          "Enter",
          " ",
          "Escape",
          "Tab",
        ].includes(e.key)
      )
        return;
      e.stopImmediatePropagation();
      if (e.key === "Tab") {
        setOpen(false);
        return;
      }
      e.preventDefault();
      if (e.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      } else if (e.key === "Enter" || e.key === " ") choose(active);
      else if (filtered.length)
        setActive(
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? filtered.length - 1
              : (active + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                filtered.length,
        );
    };
    const focusOutside = (e: FocusEvent) => {
      const target = e.target as Node | null;
      if (
        target &&
        !trigger.current?.contains(target) &&
        !menu.current?.contains(target)
      )
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focusOutside);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", resize);
    };
  }, [open, active, filtered, onChange]);

  useEffect(() => {
    menu.current
      ?.querySelectorAll<HTMLElement>('[role="option"]')
      [active]?.scrollIntoView({ block: "nearest" });
  }, [active, query]);

  const currentLabel = options.find((o) => o.value === value)?.label;

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={[
          "select-trigger",
          "ui-select-trigger",
          hasExplicitSize ? `ui-select-trigger--${effectiveSize}` : "",
          variant === "ghost" ? "ui-select-trigger--ghost" : "",
          className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="combobox"
        aria-label={label}
        title={currentLabel}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-activedescendant={
          open && filtered.length ? `${id}-${active}` : undefined
        }
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        {leading && (
          <span className="ui-select-leading" aria-hidden="true">
            {leading}
          </span>
        )}
        <span className="ui-select-value">{currentLabel ?? placeholder}</span>
        <ChevronDown size={14} className="ui-select-chevron" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            title={currentLabel}
            className={`select-popover ui-select-popover${isCompactMenu ? " compact" : ""}`}
            style={position}
            onMouseDown={(e) => {
              if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
            }}
          >
            {searchable && (
              <label className="select-search">
                <Search size={14} />
                <input
                  ref={search}
                  role="combobox"
                  aria-label={searchPlaceholder}
                  aria-controls={id}
                  aria-expanded={true}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    filtered.length ? `${id}-${active}` : undefined
                  }
                  placeholder={searchPlaceholder}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActive(0);
                  }}
                />
              </label>
            )}
            {menuTitle && (
              <div className="select-menu-title" role="presentation">
                {menuTitle}
              </div>
            )}
            <div id={id} role="listbox" aria-label={label}>
              {filtered.map((o, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={o.value === value}
                  id={`${id}-${index}`}
                  tabIndex={-1}
                  key={o.value}
                  title={isCompactMenu ? o.label : undefined}
                  className={[
                    active === index ? "highlighted" : "",
                    o.tone ?? "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(index)}
                >
                  <span>
                    {o.label}
                    {o.description && <small>{o.description}</small>}
                  </span>
                  {o.value === value && <Check size={14} />}
                </button>
              ))}
            </div>
            {!filtered.length && (
              <p className="select-no-results" role="status">
                没有匹配的选项
              </p>
            )}
          </div>,
          trigger.current?.closest<HTMLElement>('[role="dialog"]') ??
            document.body,
        )}
    </>
  );
}
