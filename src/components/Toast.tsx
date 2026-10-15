"use client";

export interface ToastItem {
  id: number;
  kind: "loading" | "success" | "error";
  message: string;
}

export default function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 w-80 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2 bg-white border rounded-lg shadow-lg px-4 py-3 toast-in ${
            t.kind === "loading"
              ? "border-blue-300"
              : t.kind === "success"
                ? "border-green-300"
                : "border-red-300"
          }`}
        >
          {t.kind === "loading" ? (
            <svg
              className="animate-spin h-4 w-4 text-blue-600 shrink-0 mt-0.5"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
          ) : t.kind === "success" ? (
            <span className="text-green-600 shrink-0 mt-0.5 font-bold">
              &#x2713;
            </span>
          ) : (
            <span className="text-red-600 shrink-0 mt-0.5 font-bold">!</span>
          )}
          <p className="flex-1 text-sm text-gray-700">{t.message}</p>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
            className="text-gray-400 hover:text-gray-600 shrink-0"
          >
            &#x2715;
          </button>
        </div>
      ))}
    </div>
  );
}
