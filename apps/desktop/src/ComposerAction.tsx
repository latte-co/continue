import { ArrowUp, LoaderCircle, Square } from "lucide-react";
export function ComposerAction({
  active = false,
  sending = false,
  disabled = false,
  label,
  onClick,
}: {
  active?: boolean;
  sending?: boolean;
  disabled?: boolean;
  label?: string;
  onClick?: () => void;
}) {
  return (
    <button
      className={`send${active ? " stop" : ""}`}
      aria-label={
        sending ? "正在发送任务" : (label ?? (active ? "停止任务" : "发送任务"))
      }
      title={
        sending ? "正在发送任务" : (label ?? (active ? "停止任务" : "发送任务"))
      }
      disabled={disabled || sending}
      onClick={onClick}
    >
      {sending ? (
        <LoaderCircle size={15} className="spin" />
      ) : active ? (
        <Square size={11} rx={1.5} fill="currentColor" />
      ) : (
        <ArrowUp size={16} strokeWidth={2} />
      )}
    </button>
  );
}
