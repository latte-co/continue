import { useRef } from "react";
import { Check, FileText } from "lucide-react";
import { MenuRow, Popover } from "./ui";

export function ReviewOptions({
  trigger,
  fullContext,
  frozen,
  choose,
  close,
}: {
  trigger: HTMLButtonElement;
  fullContext: boolean;
  frozen: boolean;
  choose: () => void;
  close: (restoreFocus?: boolean) => void;
}) {
  const triggerRef = useRef<HTMLElement>(trigger);
  triggerRef.current = trigger;

  return (
    <Popover
      open
      anchorRef={triggerRef}
      align="end"
      minWidth={232}
      role="menu"
      label="更多差异选项"
      className="review-options"
      restoreFocusOnEscape={false}
      onClose={(restoreFocus = true) => close(restoreFocus)}
    >
      <MenuRow
        role="menuitemcheckbox"
        aria-checked={fullContext && !frozen}
        active={fullContext && !frozen}
        disabled={frozen}
        leading={<FileText size={15} />}
        trailing={fullContext && !frozen ? <Check size={14.5} /> : undefined}
        onClick={() => {
          choose();
          close(true);
        }}
      >
        加载完整文件
      </MenuRow>
      {frozen && <p className="ui-menu-note">回合快照仅保留采集时的上下文。</p>}
    </Popover>
  );
}
