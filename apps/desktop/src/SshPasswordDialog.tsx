import { useEffect, useState } from "react";
import { message, type Host } from "./api";
import { Button, Dialog, Field, NoticeBanner, TextInput } from "./ui";

export function SshPasswordDialog({
  host,
  submit,
  cancel,
}: {
  host: Host;
  submit: (password: string) => Promise<void>;
  cancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [busy, cancel]);

  async function connect(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    try {
      await submit(password);
      setPassword("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="sm"
      className="ssh-password-modal"
      backdropClassName="ssh-password-backdrop"
      ariaLabel={`连接 ${host.name}`}
      title={`连接 ${host.name}`}
      description={`请输入 SSH 密码以连接 ${host.ssh}。本次运行期间重连无需再次输入。`}
      closeLabel="稍后连接"
      busy={busy}
      onClose={cancel}
      footer={
        <>
          <Button variant="subtle" size="md" disabled={busy} onClick={cancel}>
            稍后
          </Button>
          <Button
            type="submit"
            form="ssh-password-form"
            variant="primary"
            size="md"
            busy={busy}
            disabled={busy || !password}
          >
            {busy ? "正在连接…" : "连接"}
          </Button>
        </>
      }
    >
      <form
        id="ssh-password-form"
        onSubmit={(event) => void connect(event)}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-3)",
        }}
      >
        <Field
          label="SSH 密码"
          htmlFor="ssh-password-input"
          hint="密码仅保留在应用内存中，关闭应用后清除。"
        >
          <TextInput
            id="ssh-password-input"
            autoFocus
            required
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && <NoticeBanner tone="danger">{error}</NoticeBanner>}
      </form>
    </Dialog>
  );
}
