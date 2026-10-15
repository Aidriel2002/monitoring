"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import Modal from "@/components/Modal";
import ConfirmModal, { ConfirmDialog } from "@/components/ConfirmModal";
import ToastContainer, { ToastItem } from "@/components/Toast";

interface Contact {
  id: string;
  name: string;
  telegramChatId: string;
  provinces: string[];
  projectIds: number[];
  createdAt: string;
}

interface ProjectOption {
  groupId: number;
  name: string;
  /** API credential this project belongs to ("Phase 3", "Bukidnon", ...). */
  credentialName?: string;
  /** Derived province (drives province → site auto-selection). */
  province?: string;
}

/** Dropdown "project" — a folder (or credential-wide entry) covering sites. */
interface ProjectGroupOption {
  key: string;
  name: string;
  credentialName: string;
  siteIds: number[];
}

interface OptionsPayload {
  contacts?: Contact[];
  provinces?: string[];
  projects?: ProjectOption[];
  projectGroups?: ProjectGroupOption[];
}

const INPUT_CLASS =
  "mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm";

/** sessionStorage: last payload, for instant paint on tab open (SWR). */
const OPTIONS_CACHE_KEY = "contact-details:v1";

function readCachedOptions(): OptionsPayload | null {
  try {
    const raw = sessionStorage.getItem(OPTIONS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OptionsPayload | null;
    return parsed && typeof parsed === "object" && Array.isArray(parsed.contacts)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function writeCachedOptions(data: OptionsPayload) {
  try {
    sessionStorage.setItem(OPTIONS_CACHE_KEY, JSON.stringify(data));
  } catch {
    // quota/private mode — the cache is best-effort
  }
}

export default function ContactDetails() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [provinces, setProvinces] = useState<string[]>([]);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectGroups, setProjectGroups] = useState<ProjectGroupOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [formName, setFormName] = useState("");
  const [formChatId, setFormChatId] = useState("");
  const [formProvinces, setFormProvinces] = useState<string[]>([]);
  const [formProjectIds, setFormProjectIds] = useState<number[]>([]);
  const [projectSearch, setProjectSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");

  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  // Dropdown state for the province / project pickers.
  const [provOpen, setProvOpen] = useState(false);
  const [projOpen, setProjOpen] = useState(false);
  const provRef = useRef<HTMLDivElement>(null);
  const projRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (provRef.current && !provRef.current.contains(e.target as Node)) {
        setProvOpen(false);
      }
      if (projRef.current && !projRef.current.contains(e.target as Node)) {
        setProjOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function applyOptions(data: OptionsPayload) {
    setContacts(data.contacts || []);
    setProvinces(data.provinces || []);
    setProjects(data.projects || []);
    setProjectGroups(data.projectGroups || []);
    writeCachedOptions(data);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Instant paint from the last session, then revalidate in background.
      const cached = readCachedOptions();
      if (cached) {
        await null;
        if (cancelled) return;
        applyOptions(cached);
        setLoading(false);
      }
      try {
        const res = await authFetch("/api/settings/contacts");
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          // Background refresh failed — keep showing the cached payload.
          if (!cached) {
            setLoadError(
              data.error ||
                "Failed to load contacts — has migration_v6.sql been applied in Supabase?"
            );
          }
          return;
        }
        applyOptions(data);
      } catch {
        if (!cancelled && !cached) setLoadError("Network error");
      } finally {
        if (!cancelled && !cached) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function pushToast(kind: ToastItem["kind"], message: string): number {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    return id;
  }

  function updateToast(id: number, kind: ToastItem["kind"], message: string) {
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, kind, message } : t))
    );
    if (kind !== "loading") {
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 4500);
    }
  }

  function dismissToast(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  async function reload() {
    try {
      const res = await authFetch("/api/settings/contacts");
      const data = await res.json();
      if (!res.ok) {
        updateToast(0, "error", data.error || "Failed to reload contacts");
        return;
      }
      applyOptions(data);
    } catch {
      pushToast("error", "Failed to reload contacts");
    }
  }

  function openAdd() {
    setEditing(null);
    setFormName("");
    setFormChatId("");
    setFormProvinces([]);
    setFormProjectIds([]);
    setProjectSearch("");
    setFormError("");
    setShowForm(true);
  }

  function openEdit(contact: Contact) {
    setEditing(contact);
    setFormName(contact.name);
    setFormChatId(contact.telegramChatId);
    setFormProvinces(contact.provinces);
    setFormProjectIds(contact.projectIds);
    setProjectSearch("");
    setFormError("");
    setShowForm(true);
  }

  function closeForm() {
    setShowForm(false);
    setFormError("");
    setProvOpen(false);
    setProjOpen(false);
  }

  /** Province toggle: also auto-ticks / unticks every site in that province. */
  function toggleFormProvince(province: string) {
    const covered = sitesByProvince.get(province) || [];
    const removing = formProvinces.includes(province);
    setFormProvinces((prev) =>
      removing ? prev.filter((p) => p !== province) : [...prev, province]
    );
    setFormProjectIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of covered) {
        if (removing) changed = next.delete(id) || changed;
        else if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? [...next] : prev;
    });
  }

  function toggleFormProject(groupId: number) {
    setFormProjectIds((prev) =>
      prev.includes(groupId)
        ? prev.filter((id) => id !== groupId)
        : [...prev, groupId]
    );
  }

  /** Site-list group header: check/uncheck every site under a credential. */
  function toggleSiteGroup(items: ProjectOption[]) {
    const ids = items.map((p) => p.groupId);
    setFormProjectIds((prev) => {
      const next = new Set(prev);
      const allChecked = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allChecked) next.delete(id);
        else next.add(id);
      }
      return [...next];
    });
  }

  /** Project-dropdown entry: auto-ticks / unticks the sites it covers. */
  function toggleProjectGroup(g: ProjectGroupOption) {
    setFormProjectIds((prev) => {
      const next = new Set(prev);
      const allChecked = g.siteIds.every((id) => next.has(id));
      for (const id of g.siteIds) {
        if (allChecked) next.delete(id);
        else next.add(id);
      }
      return [...next];
    });
  }

  /** Province → covered site ids (drives province auto-selection). */
  const sitesByProvince = new Map<string, number[]>();
  for (const p of projects) {
    if (!p.province) continue;
    const list = sitesByProvince.get(p.province) || [];
    list.push(p.groupId);
    sitesByProvince.set(p.province, list);
  }

  /** How many project-dropdown entries are fully ticked right now. */
  const checkedGroupCount = useMemo(() => {
    const selected = new Set(formProjectIds);
    return projectGroups.filter(
      (g) => g.siteIds.length > 0 && g.siteIds.every((id) => selected.has(id))
    ).length;
  }, [projectGroups, formProjectIds]);

  /** Project dropdown grouped under credential headers. */
  const groupedProjectGroups = useMemo(() => {
    const map = new Map<string, ProjectGroupOption[]>();
    for (const g of projectGroups) {
      const list = map.get(g.credentialName) || [];
      list.push(g);
      map.set(g.credentialName, list);
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }));
  }, [projectGroups]);

  const groupedProjects = useMemo(() => {
    const q = projectSearch.trim().toLowerCase();
    const groups = new Map<string, ProjectOption[]>();
    for (const p of projects) {
      if (
        q &&
        !p.name.toLowerCase().includes(q) &&
        !String(p.groupId).includes(q)
      ) {
        continue;
      }
      const label = p.credentialName?.trim() || "Other";
      const list = groups.get(label) || [];
      list.push(p);
      groups.set(label, list);
    }
    return [...groups.entries()]
      .map(([label, items]) => ({
        label,
        items: items.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [projects, projectSearch]);

  function projectName(groupId: number): string | null {
    return projects.find((p) => p.groupId === groupId)?.name || null;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");
    setSaving(true);
    try {
      const body = {
        name: formName.trim(),
        telegramChatId: formChatId.trim(),
        provinces: formProvinces,
        projectIds: formProjectIds,
      };
      const res = await authFetch("/api/settings/contacts", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(editing ? { id: editing.id, ...body } : body),
      });
      const data = await res.json();
      if (!res.ok) {
        setFormError(data.error || "Failed to save contact");
        return;
      }
      setShowForm(false);
      await reload();
      const toastId = pushToast("loading", "Saving contact...");
      updateToast(toastId, "success", "Contact saved");
    } catch {
      setFormError("Network error");
    } finally {
      setSaving(false);
    }
  }

  function handleDelete(contact: Contact) {
    setConfirmDialog({
      title: "Delete contact",
      message: `Delete ${contact.name}? They will no longer receive Telegram reports.`,
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        setConfirmDialog(null);
        authFetch(`/api/settings/contacts?id=${contact.id}`, { method: "DELETE" })
          .then(async (res) => {
            const data = await res.json().catch(() => null);
            if (!res.ok) {
              pushToast("error", data?.error || "Failed to delete contact");
              return;
            }
            await reload();
            const toastId = pushToast("loading", "Deleting contact...");
            updateToast(toastId, "success", "Contact deleted");
          })
          .catch(() => pushToast("error", "Failed to delete contact"));
      },
    });
  }

  if (loading) {
    return (
      <div className="bg-white shadow rounded-lg">
        <div className="p-6 text-center text-gray-500">Loading contacts...</div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="bg-white shadow rounded-lg">
        <div className="p-6 text-center">
          <p className="text-red-600 font-medium">Failed to load contacts</p>
          <p className="text-sm text-gray-500 mt-1">{loadError}</p>
          <button
            onClick={() => {
              setLoadError("");
              setLoading(true);
                authFetch("/api/settings/contacts")
                  .then(async (res) => {
                    const data = await res.json();
                    if (!res.ok) {
                      setLoadError(data.error || "Failed to load contacts");
                      return;
                    }
                    applyOptions(data);
                  })
                .catch(() => setLoadError("Network error"))
                .finally(() => setLoading(false));
            }}
            className="mt-3 px-4 py-2 text-sm font-medium text-blue-600 bg-transparent border border-blue-600 rounded-md hover:bg-blue-50"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white shadow rounded-lg">
      <div className="p-6 border-b border-gray-200 flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">
            Contact Incharges ({contacts.length})
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            Receive a Telegram monitoring report after every sync (100 min) and
            on manual sync. Contacts with no province or project assigned
            receive no reports.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="px-4 py-2 text-sm font-medium text-emerald-600 bg-transparent border border-emerald-600 rounded-md hover:bg-emerald-50 shrink-0"
        >
          Add Contact
        </button>
      </div>

      <div className="divide-y divide-gray-200">
        {contacts.length === 0 ? (
          <div className="p-6 text-center text-gray-500">
            No contacts yet. Add a contact incharge to receive Telegram outage
            reports.
          </div>
        ) : (
          contacts.map((contact) => (
            <div
              key={contact.id}
              className="p-4 flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                <h3 className="font-medium text-gray-900">{contact.name}</h3>
                <p className="text-sm text-gray-500">{contact.telegramChatId}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {contact.provinces.length === 0 &&
                  contact.projectIds.length === 0 ? (
                    <span className="text-xs text-gray-400 italic">
                      No assignment — no reports
                    </span>
                  ) : (
                    <>
                      {contact.provinces.map((p) => (
                        <span
                          key={`p-${p}`}
                          className="px-2 py-0.5 text-xs font-medium bg-blue-50 text-blue-700 rounded-full"
                        >
                          {p}
                        </span>
                      ))}
                      {contact.projectIds.slice(0, 8).map((id) => (
                        <span
                          key={`g-${id}`}
                          className="px-2 py-0.5 text-xs font-medium bg-purple-50 text-purple-700 rounded-full"
                        >
                          {projectName(id) || `Project ${id}`}
                        </span>
                      ))}
                      {contact.projectIds.length > 8 && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-600 rounded-full">
                          +{contact.projectIds.length - 8} more
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => openEdit(contact)}
                  className="px-3 py-1 text-sm font-medium text-blue-600 bg-transparent border border-blue-600 rounded hover:bg-blue-50"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleDelete(contact)}
                  className="px-3 py-1 text-sm font-medium text-red-600 bg-transparent border border-red-600 rounded hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      <Modal
        open={showForm}
        title={editing ? "Edit Contact" : "Add Contact"}
        onClose={closeForm}
        wide
      >
        <form onSubmit={handleSave} className="space-y-4">
          {formError && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              {formError}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Name *
              </label>
              <input
                type="text"
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Juan Dela Cruz"
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Telegram number *
              </label>
              <input
                type="tel"
                required
                value={formChatId}
                onChange={(e) => setFormChatId(e.target.value)}
                placeholder="e.g. 09171234567"
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-xs text-gray-400">
                The contact must open the bot in Telegram, tap Start, then
                send their number (or share their contact card) in that chat —
                reports are delivered there.
              </p>
            </div>
          </div>

          <div className="relative" ref={provRef}>
            <label className="block text-sm font-medium text-gray-700">
              Assigned provinces (optional)
            </label>
            <button
              type="button"
              onClick={() => setProvOpen((o) => !o)}
              className={`mt-1 w-full flex items-center justify-between gap-2 px-3 py-2 border rounded-md shadow-sm text-sm bg-white text-left ${
                provOpen ? "border-blue-500 ring-1 ring-blue-500" : "border-gray-300"
              }`}
            >
              <span className="truncate">
                {formProvinces.length === 0
                  ? provinces.length === 0
                    ? "No provinces with projects yet"
                    : "Select provinces..."
                  : formProvinces.join(", ")}
              </span>
              <span className="text-gray-400 text-xs shrink-0">
                {formProvinces.length > 0 ? `${formProvinces.length} ` : ""}▾
              </span>
            </button>
            {provOpen && provinces.length > 0 && (
              <div className="absolute z-40 mt-1 w-full max-h-56 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg p-1">
                {provinces.map((p) => (
                  <label
                    key={p}
                    className={`flex items-center gap-2 p-2 rounded cursor-pointer text-sm ${
                      formProvinces.includes(p) ? "bg-blue-50" : "hover:bg-gray-50"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={formProvinces.includes(p)}
                      onChange={() => toggleFormProvince(p)}
                      className="h-3.5 w-3.5 text-blue-600 rounded border-gray-300 shrink-0"
                    />
                    <span className="truncate">{p}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div className="relative" ref={projRef}>
            <label className="block text-sm font-medium text-gray-700">
              Assigned projects (optional)
            </label>
            <p className="mt-0.5 text-xs text-gray-400">
              Selecting a province or project auto-ticks the sites it covers —
              then fine-tune specific sites in the list below.
            </p>
            <button
              type="button"
              onClick={() => setProjOpen((o) => !o)}
              className={`mt-1 w-full flex items-center justify-between gap-2 px-3 py-2 border rounded-md shadow-sm text-sm bg-white text-left ${
                projOpen
                  ? "border-blue-500 ring-1 ring-blue-500"
                  : "border-gray-300"
              }`}
            >
              <span className="truncate">
                {checkedGroupCount === 0
                  ? projectGroups.length === 0
                    ? "No projects known yet — run Sync devices first"
                    : "Select projects..."
                  : `${checkedGroupCount} project(s) selected`}
              </span>
              <span className="text-gray-400 text-xs shrink-0">▾</span>
            </button>
            {projOpen && (
              <div className="absolute z-40 mt-1 w-full max-h-60 overflow-y-auto bg-white border border-gray-200 rounded-md shadow-lg p-1">
                {groupedProjectGroups.length === 0 ? (
                  <p className="p-3 text-center text-sm text-gray-500">
                    No projects known yet — run Sync devices in API
                    Credentials first.
                  </p>
                ) : (
                  groupedProjectGroups.map((grp) => (
                    <div key={grp.label}>
                      <div className="px-2 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                        {grp.label}
                      </div>
                      {grp.items.map((g) => {
                        const checked =
                          g.siteIds.length > 0 &&
                          g.siteIds.every((id) =>
                            formProjectIds.includes(id)
                          );
                        return (
                          <label
                            key={g.key}
                            className={`flex items-center gap-2 p-2 rounded cursor-pointer text-sm ${
                              checked ? "bg-blue-50" : "hover:bg-gray-50"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleProjectGroup(g)}
                              className="h-3.5 w-3.5 text-blue-600 rounded border-gray-300 shrink-0"
                            />
                            <span className="truncate">{g.name}</span>
                            <span className="text-xs text-gray-400 ml-auto shrink-0">
                              {g.siteIds.length}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Assigned sites (optional)
            </label>
            <p className="mt-0.5 text-xs text-gray-400">
              Specific sites to report on — grouped by API credential.
            </p>
            {projects.length === 0 ? (
              <p className="mt-1 text-xs text-gray-400">
                No sites known yet — run Sync devices in API Credentials
                first.
              </p>
            ) : (
              <>
                <input
                  type="search"
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  placeholder="Search sites..."
                  className={INPUT_CLASS}
                />
                <div className="mt-2 max-h-48 overflow-y-auto border border-gray-200 rounded">
                  {groupedProjects.length === 0 ? (
                    <p className="p-3 text-center text-sm text-gray-500">
                      No sites match
                    </p>
                  ) : (
                    groupedProjects.map((group) => (
                      <div key={group.label}>
                        <label className="sticky top-0 z-10 flex items-center gap-2 px-2 py-1 bg-gray-100 border-b border-gray-200 text-xs font-semibold text-gray-600 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={group.items.every((p) =>
                              formProjectIds.includes(p.groupId)
                            )}
                            onChange={() => toggleSiteGroup(group.items)}
                            className="h-3.5 w-3.5 text-blue-600 rounded border-gray-300 shrink-0"
                          />
                          <span className="truncate">{group.label}</span>
                          <span className="text-gray-400 shrink-0 ml-auto">
                            {group.items.length}
                          </span>
                        </label>
                        {group.items.map((p) => (
                          <label
                            key={p.groupId}
                            className={`flex items-center gap-2 p-2 cursor-pointer border-b border-gray-100 last:border-b-0 ${
                              formProjectIds.includes(p.groupId)
                                ? "bg-blue-50"
                                : "hover:bg-gray-50"
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={formProjectIds.includes(p.groupId)}
                              onChange={() => toggleFormProject(p.groupId)}
                              className="h-3.5 w-3.5 text-blue-600 rounded border-gray-300 shrink-0"
                            />
                            <span className="text-sm text-gray-900 truncate">
                              {p.name}
                            </span>
                            <span className="text-xs text-gray-400 ml-auto shrink-0">
                              ID: {p.groupId}
                            </span>
                          </label>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </div>

          <p className="text-xs text-gray-400">
            Matching is by province name and project ID. Leave both empty to
            give this contact no site reports.
          </p>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={closeForm}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-transparent border border-gray-400 rounded-md hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 text-sm font-medium text-emerald-600 bg-transparent border border-emerald-600 rounded-md hover:bg-emerald-50 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save Contact"}
            </button>
          </div>
        </form>
      </Modal>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      <ConfirmModal
        dialog={confirmDialog}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}
