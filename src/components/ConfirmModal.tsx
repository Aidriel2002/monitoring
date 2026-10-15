"use client";

import { useEffect } from "react";

export interface ConfirmDialog {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export default function ConfirmModal({
  dialog,
  onCancel,
}: {
  dialog: ConfirmDialog | null;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!dialog) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dialog, onCancel]);

  if (!dialog) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/30"
        onClick={onCancel}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={dialog.title}
        className="relative w-full max-w-md mx-4 bg-white border border-gray-200 rounded-lg shadow-xl p-6"
      >
        <h3 className="text-lg font-semibold text-gray-900">{dialog.title}</h3>
        <p className="mt-2 text-sm text-gray-600 whitespace-pre-line">
          {dialog.message}
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-transparent border border-gray-400 rounded-md hover:bg-gray-100"
          >
            {dialog.cancelLabel || "Cancel"}
          </button>
          <button
            type="button"
            onClick={dialog.onConfirm}
            autoFocus
            className={
              dialog.danger
                ? "px-4 py-2 text-sm font-medium text-red-600 bg-transparent border border-red-600 rounded-md hover:bg-red-50"
                : "px-4 py-2 text-sm font-medium text-blue-600 bg-transparent border border-blue-600 rounded-md hover:bg-blue-50"
            }
          >
            {dialog.confirmLabel || "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
