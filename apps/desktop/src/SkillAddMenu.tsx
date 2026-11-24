import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Box, ChevronDown, FolderInput } from "lucide-react";
import { Button, MenuRow, MenuSeparator, Popover } from "./ui";

export function SkillAddMenu({
  disabled,
  importDisabled,
  onCreate,
  onImport,
}: {
  disabled: boolean;
  importDisabled: boolean;
  onCreate?: () => void;
  onImport: () => void;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const unavailable = disabled || (importDisabled && !onCreate);
  const open = expanded && !unavailable;

  const close = useCallback((restoreFocus = true) => {
    setExpanded(false);
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (unavailable) setExpanded(false);
  }, [unavailable]);

  useEffect(() => {
    if (!open) return;
    const onBlur = () => close(false);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [open, close]);

  function choose(action: () => void) {
    // The import modal must restore focus to the surviving toolbar trigger.
    close();
    action();
  }

  return (
    <>
      <Button
        ref={trigger}
        variant="primary"
        size="md"
        className="skills-add"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={unavailable}
        trailing={<ChevronDown size={14.5} />}
        onClick={() => {
          trigger.current?.focus();
          setExpanded(!open);
        }}
        onKeyDown={(event) => {
          if (!open && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setExpanded(true);
          }
        }}
      >
        添加
      </Button>
      <Popover
        id={id}
        open={open}
        anchorRef={trigger}
        align="end"
        minWidth={184}
        role="menu"
        label="添加技能"
        className="skill-add-menu"
        restoreFocusOnEscape={false}
        onClose={(restoreFocus = true) => close(restoreFocus)}
      >
        <MenuRow
          role="menuitem"
          disabled={!onCreate}
          leading={<Box size={15} />}
          onClick={() => onCreate && choose(onCreate)}
        >
          创建技能
        </MenuRow>
        <MenuSeparator />
        <MenuRow
          role="menuitem"
          disabled={importDisabled}
          leading={<FolderInput size={15} />}
          onClick={() => choose(onImport)}
        >
          导入技能
        </MenuRow>
      </Popover>
    </>
  );
}
