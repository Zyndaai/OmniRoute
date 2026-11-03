"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import Modal, { ConfirmModal } from "@/shared/components/Modal";
import Button, { type ButtonVariant } from "@/shared/components/Button";
import Input from "@/shared/components/Input";

/*
 * In-app replacements for window.confirm / window.prompt. The native dialogs are
 * suppressed in embedded browsers (desktop app panes, some webviews), where the
 * call returns false/null at once and the action silently does nothing.
 *
 *   const [confirm, confirmDialog] = useConfirmDialog();
 *   if (!(await confirm({ message: t("deleteConfirm") }))) return;
 *   ...
 *   {confirmDialog}   // render once in the component
 */

interface ConfirmOptions {
  message: ReactNode;
  title?: ReactNode;
  confirmText?: ReactNode;
  cancelText?: ReactNode;
  /** Defaults to "danger": most confirms guard a destructive action. */
  variant?: ButtonVariant;
}

export function useConfirmDialog() {
  const [open, setOpen] = useState(false);
  // Kept after closing so the content does not blank out during the close animation.
  const [options, setOptions] = useState<ConfirmOptions>({ message: "" });
  const resolveRef = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed);
    resolveRef.current = null;
    setOpen(false);
  }, []);

  const confirm = useCallback((next: ConfirmOptions | string) => {
    // A newer request supersedes one still open.
    resolveRef.current?.(false);
    setOptions(typeof next === "string" ? { message: next } : next);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const dialog = (
    <ConfirmModal
      isOpen={open}
      onClose={() => settle(false)}
      onConfirm={() => settle(true)}
      title={options.title}
      message={options.message}
      confirmText={options.confirmText}
      cancelText={options.cancelText}
      variant={options.variant}
    />
  );

  return [confirm, dialog] as const;
}

interface PromptOptions {
  /** Shown as the input's label. */
  message: ReactNode;
  title?: ReactNode;
  defaultValue?: string;
  confirmText?: ReactNode;
}

/** Resolves to the entered text, or null when cancelled (like window.prompt). */
export function usePromptDialog() {
  const t = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<PromptOptions>({ message: "" });
  const [value, setValue] = useState("");
  const resolveRef = useRef<((value: string | null) => void) | null>(null);

  const settle = useCallback((result: string | null) => {
    resolveRef.current?.(result);
    resolveRef.current = null;
    setOpen(false);
  }, []);

  const prompt = useCallback((next: PromptOptions) => {
    resolveRef.current?.(null);
    setOptions(next);
    setValue(next.defaultValue ?? "");
    setOpen(true);
    return new Promise<string | null>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const dialog = (
    <Modal
      isOpen={open}
      onClose={() => settle(null)}
      title={options.title ?? options.message}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={() => settle(null)}>
            {t("cancel")}
          </Button>
          <Button variant="primary" onClick={() => settle(value)}>
            {options.confirmText ?? t("confirmAction")}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          settle(value);
        }}
      >
        <Input
          label={options.title ? options.message : undefined}
          aria-label={typeof options.message === "string" ? options.message : undefined}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoFocus
        />
      </form>
    </Modal>
  );

  return [prompt, dialog] as const;
}
