"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";
import ConfirmModal, { ConfirmDialog } from "@/components/ConfirmModal";
import Modal from "@/components/Modal";
import ToastContainer, { ToastItem } from "@/components/Toast";
import ContactDetails from "@/components/ContactDetails";

interface Credential {
  id: string;
  name: string;
  app_id: string;
  base_url: string;
  is_active: boolean;
  created_at: string;
  selected_group_ids: number[] | null;
  selected_received_group_ids: number[] | null;
  /** Epoch ms until which Ruijie is rate-limiting this credential (0 = none). */
  rate_limited_until?: number;
}

interface Project {
  groupId: number;
  name: string;
  type: string;
  description: string;
}

interface SharedProject {
  groupId: number;
  name: string;
  type: string;
  description: string;
  tenantName: string;
  totalCount: number;
}

interface TreeNode {
  groupId: number;
  name: string;
  type: string;
  description: string;
  childIds: number[];
  children: TreeNode[];
}

function TreeNodeRow({
  node,
  credId,
  depth,
  selectedIds,
  toggleProject,
}: {
  node: TreeNode;
  credId: string;
  depth: number;
  selectedIds: Record<string, number[] | null>;
  toggleProject: (credId: string, groupId: number) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 1);
  const hasChildren = node.children.length > 0;
  const sel = selectedIds[credId];

  // Selection is stored as leaf IDs only; parents reflect their leaves.
  let isSelected: boolean;
  if (sel === null || sel === undefined) {
    isSelected = true;
  } else if (hasChildren) {
    const leaves = collectLeafIds([node]);
    isSelected = leaves.length > 0 && leaves.every((id) => sel.includes(id));
  } else {
    isSelected = sel.includes(node.groupId);
  }

  return (
    <div>
      <label
        className={`flex items-center gap-2 p-2 rounded cursor-pointer transition-colors ${isSelected ? "bg-blue-50" : "hover:bg-gray-50"}`}
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setExpanded(!expanded);
            }}
            className="w-4 h-4 flex items-center justify-center text-gray-500 hover:text-gray-700 shrink-0"
          >
            {expanded ? "\u25BC" : "\u25B6"}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => toggleProject(credId, node.groupId)}
          className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500 shrink-0"
        />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium text-gray-900">{node.name}</span>
          <span className="text-xs text-gray-500 ml-2">
            {node.type} &middot; ID: {node.groupId}
          </span>
          {hasChildren && (
            <span className="text-xs text-gray-400 ml-2">
              ({node.children.length} sub)
            </span>
          )}
        </div>
      </label>
      {expanded &&
        hasChildren &&
        node.children.map((child) => (
          <TreeNodeRow
            key={child.groupId}
            node={child}
            credId={credId}
            depth={depth + 1}
            selectedIds={selectedIds}
            toggleProject={toggleProject}
          />
        ))}
    </div>
  );
}

function collectLeafIds(nodes: TreeNode[]): number[] {
  const ids: number[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.children.length === 0) ids.push(n.groupId);
      else walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

/** Expand saved IDs (may include parents) to the leaf project IDs only. */
function expandToLeafSelection(
  tree: TreeNode[],
  ids: number[] | null
): number[] | null {
  if (ids === null) return null;
  if (tree.length === 0) return ids;
  const leaves = new Set(collectLeafIds(tree));
  const result = new Set<number>();

  const mark = (nodes: TreeNode[], underSelected: boolean) => {
    for (const n of nodes) {
      const selected = underSelected || ids.includes(n.groupId);
      if (n.children.length === 0 && selected && leaves.has(n.groupId)) {
        result.add(n.groupId);
      }
      if (n.children.length > 0) mark(n.children, selected);
    }
  };
  mark(tree, false);

  if (result.size === 0) return [];
  if (result.size >= leaves.size) return null;
  return [...result];
}

function findNode(nodes: TreeNode[], groupId: number): TreeNode | null {
  for (const n of nodes) {
    if (n.groupId === groupId) return n;
    const found = findNode(n.children, groupId);
    if (found) return found;
  }
  return null;
}

export default function SettingsPage() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    appId: "",
    secret: "",
    bootstrapToken: "",
    baseUrl: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState<string | null>(null);
  const [fetchingCred, setFetchingCred] = useState<string | null>(null);
  const [togglingCred, setTogglingCred] = useState<string | null>(null);
  /** credId → epoch ms of last successful/started fetch (1/minute spam guard). */
  const [fetchCooldownUntil, setFetchCooldownUntil] = useState<Record<string, number>>({});
  /** credId → epoch ms until which the Ruijie API limit is active for it. */
  const [rateLimitedUntil, setRateLimitedUntil] = useState<Record<string, number>>({});
  const [fetchCooldownTick, setFetchCooldownTick] = useState(0);
  const [managingCredId, setManagingCredId] = useState<string | null>(null);
  const manageRef = useRef<HTMLDivElement>(null);
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog | null>(null);

  // Toast notifications (Test / Sync devices)
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastIdRef = useRef(0);

  // Project selection state
  const [projectsModalCredId, setProjectsModalCredId] = useState<string | null>(null);
  const [projectsFetchedAt, setProjectsFetchedAt] = useState<Record<string, number>>({});
  const [availableProjects, setAvailableProjects] = useState<Record<string, Project[]>>({});
  const [projectTrees, setProjectTrees] = useState<Record<string, TreeNode[]>>({});
  const [selectedIds, setSelectedIds] = useState<Record<string, number[] | null>>({});
  const [sharedProjects, setSharedProjects] = useState<Record<string, SharedProject[]>>({});
  const [selectedSharedIds, setSelectedSharedIds] = useState<Record<string, number[] | null>>({});
  const [loadingProjects, setLoadingProjects] = useState<string | null>(null);
  const [savingProjects, setSavingProjects] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState<Record<string, string>>({});
  const [authExpired, setAuthExpired] = useState(false);
  const [activeTab, setActiveTab] = useState<"credentials" | "contacts">(
    "credentials"
  );

  const router = useRouter();

  useEffect(() => {
    fetchCredentials();
  }, []);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (manageRef.current && !manageRef.current.contains(e.target as Node)) {
        setManagingCredId(null);
      }
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  // Tick cooldown labels once per second while any Sync devices cooldown or
  // API rate limit is active.
  useEffect(() => {
    const hasActive =
      Object.values(fetchCooldownUntil).some((until) => until > Date.now()) ||
      Object.values(rateLimitedUntil).some((until) => until > Date.now());
    if (!hasActive) return;
    const timer = setInterval(() => setFetchCooldownTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [fetchCooldownUntil, rateLimitedUntil]);

  function fetchDevicesCooldownSec(credId: string): number {
    void fetchCooldownTick;
    const until = fetchCooldownUntil[credId] || 0;
    const remain = Math.ceil((until - Date.now()) / 1000);
    return remain > 0 ? remain : 0;
  }

  /** Remaining seconds of the Ruijie API rate limit for this credential. */
  function rateLimitedSec(credId: string): number {
    void fetchCooldownTick;
    const until = rateLimitedUntil[credId] || 0;
    const remain = Math.ceil((until - Date.now()) / 1000);
    return remain > 0 ? remain : 0;
  }

  function markRateLimited(credId: string, retryInSeconds: number) {
    const until = Date.now() + Math.max(1, retryInSeconds) * 1000;
    setRateLimitedUntil((prev) => ({ ...prev, [credId]: until }));
    // Block Sync devices for the same window so the button counts down too.
    setFetchCooldownUntil((prev) => ({
      ...prev,
      [credId]: Math.max(prev[credId] || 0, until),
    }));
  }

  function fetchDevicesDisabled(cred: Credential): boolean {
    if (fetchingCred === cred.id) return true;
    if (fetchingCred !== null) return true; // one at a time
    return fetchDevicesCooldownSec(cred.id) > 0;
  }

  function pushToast(kind: ToastItem["kind"], message: string): number {
    const id = ++toastIdRef.current;
    setToasts((prev) => [...prev, { id, kind, message }]);
    return id;
  }

  function updateToast(
    id: number,
    kind: ToastItem["kind"],
    message: string
  ) {
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

  async function fetchCredentials() {
    try {
      const response = await authFetch("/api/settings/credentials");
      if (response.status === 401) {
        // Stay signed in — only log out when the user clicks Logout.
        setAuthExpired(true);
        return;
      }
      setAuthExpired(false);
      const data = await response.json();
      setCredentials(data.credentials || []);

      // Seed the per-credential API limit countdowns from the server's
      // live cooldown state.
      const limits: Record<string, number> = {};
      for (const cred of data.credentials || []) {
        limits[cred.id] = cred.rate_limited_until || 0;
      }
      setRateLimitedUntil(limits);

      // Initialize selected IDs from DB
      const initialSelected: Record<string, number[] | null> = {};
      const initialShared: Record<string, number[] | null> = {};
      for (const cred of data.credentials || []) {
        initialSelected[cred.id] = cred.selected_group_ids;
        initialShared[cred.id] = cred.selected_received_group_ids;
      }
      setSelectedIds(initialSelected);
      setSelectedSharedIds(initialShared);
    } catch (error) {
      console.error("Error fetching credentials:", error);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setSaving(true);

    try {
      const response = await authFetch("/api/settings/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      });

      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Failed to add credential");
        return;
      }

      setFormData({ name: "", appId: "", secret: "", bootstrapToken: "", baseUrl: "" });
      setShowForm(false);
      fetchCredentials();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  function handleDelete(id: string) {
    setConfirmDialog({
      title: "Delete credential",
      message: "Delete this credential? This cannot be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: () => {
        setConfirmDialog(null);
        authFetch(`/api/settings/credentials?id=${id}`, { method: "DELETE" })
          .then(() => fetchCredentials())
          .catch((error) => console.error("Error deleting credential:", error));
      },
    });
  }

  function handleToggleActive(cred: Credential) {
    if (togglingCred) return;
    const disabling = cred.is_active;
    if (disabling) {
      setConfirmDialog({
        title: "Disable API credential",
        message: `Disable ${cred.name}? It will stop calling the Ruijie API and its projects will disappear from the dashboard.`,
        confirmLabel: "Disable",
        danger: true,
        onConfirm: () => {
          setConfirmDialog(null);
          applyToggleActive(cred);
        },
      });
      return;
    }
    applyToggleActive(cred);
  }

  async function applyToggleActive(cred: Credential) {
    const disabling = cred.is_active;
    setTogglingCred(cred.id);
    try {
      const response = await authFetch("/api/settings/credentials", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: cred.id, isActive: !disabling }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || "Failed to update credential");
        return;
      }
      setError("");
      setCredentials((prev) =>
        prev.map((c) =>
          c.id === cred.id ? { ...c, is_active: data.isActive } : c
        )
      );
    } catch {
      setError("Network error");
    } finally {
      setTogglingCred(null);
    }
  }

  async function handleTest(cred: Credential) {
    setTesting(cred.id);
    const toastId = pushToast("loading", `Testing ${cred.name}...`);
    try {
      const response = await authFetch(`/api/projects?credentialId=${cred.id}&test=true`);
      const data = await response.json();
      if (response.ok && data.projects) {
        updateToast(toastId, "success", `OK - ${data.projects.length} project(s) found`);
      } else if (response.status === 429) {
        if (typeof data.retryInSeconds === "number" && data.retryInSeconds > 0) {
          markRateLimited(cred.id, data.retryInSeconds);
        }
        updateToast(toastId, "error", `API limit reached: ${data.error || "try again shortly"}`);
      } else {
        updateToast(toastId, "error", `Error: ${data.error || "Unknown error"}`);
      }
    } catch {
      updateToast(toastId, "error", "Error: Network request failed");
    } finally {
      setTesting(null);
    }
  }

  async function handleFetchDevices(cred: Credential) {
    // Idempotent: ignore spam clicks while in-flight or cooling down.
    if (fetchingCred) return;
    if (fetchDevicesCooldownSec(cred.id) > 0) return;

    setFetchingCred(cred.id);
    const toastId = pushToast("loading", `Syncing ${cred.name}...`);
    // Start cooldown immediately so a second click during the request is ignored.
    setFetchCooldownUntil((prev) => ({
      ...prev,
      [cred.id]: Date.now() + 60_000,
    }));
    try {
      const response = await authFetch("/api/settings/credentials/fetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentialId: cred.id }),
      });
      const data = await response.json();
      if (response.ok && data.ok) {
        updateToast(
          toastId,
          "success",
          `Synced ${data.projectCount} project(s), ${data.deviceCount} device(s)${data.receivedCount ? `, ${data.receivedCount} shared` : ""}`
        );
        // Force Projects modal to reload on next open
        setAvailableProjects((prev) => {
          const next = { ...prev };
          delete next[cred.id];
          return next;
        });
        setProjectTrees((prev) => {
          const next = { ...prev };
          delete next[cred.id];
          return next;
        });
        setSharedProjects((prev) => {
          const next = { ...prev };
          delete next[cred.id];
          return next;
        });
        setProjectsFetchedAt((prev) => {
          const next = { ...prev };
          delete next[cred.id];
          return next;
        });
      } else if (response.status === 429) {
        // Ruijie quota/rate limit — show it on the credential row and time
        // the retry from the server's remaining cooldown.
        if (typeof data.retryInSeconds === "number" && data.retryInSeconds > 0) {
          markRateLimited(cred.id, data.retryInSeconds);
        }
        updateToast(
          toastId,
          "error",
          `API limit reached: ${data.error || "try again shortly"}`
        );
      } else {
        updateToast(toastId, "error", `Error: ${data.error || "Unknown error"}`);
        // Failed fetch — allow retry after a short pause instead of full minute.
        setFetchCooldownUntil((prev) => ({
          ...prev,
          [cred.id]: Date.now() + 5_000,
        }));
      }
    } catch {
      updateToast(toastId, "error", "Error: Network request failed");
      setFetchCooldownUntil((prev) => ({
        ...prev,
        [cred.id]: Date.now() + 5_000,
      }));
    } finally {
      setFetchingCred(null);
    }
  }

  async function loadProjects(credId: string) {
    if (projectsModalCredId === credId) {
      setProjectsModalCredId(null);
      return;
    }

    setProjectsModalCredId(credId);
    setProjectsError((prev) => ({ ...prev, [credId]: "" }));
    if (availableProjects[credId] && projectTrees[credId] && sharedProjects[credId]) {
      // Re-normalize against the cached tree when reopening.
      const tree = projectTrees[credId];
      setSelectedIds((prev) => ({
        ...prev,
        [credId]: expandToLeafSelection(tree, prev[credId] ?? null),
      }));
      return;
    }

    setLoadingProjects(credId);
    try {
      const response = await authFetch(
        `/api/settings/credentials/projects?credentialId=${credId}`
      );
      const data = await response.json();
      if (response.ok) {
        setAvailableProjects((prev) => ({ ...prev, [credId]: data.projects || [] }));
        const tree: TreeNode[] = data.tree || [];
        setProjectTrees((prev) => ({ ...prev, [credId]: tree }));
        setProjectsFetchedAt((prev) => ({
          ...prev,
          [credId]: typeof data.fetchedAt === "number" ? data.fetchedAt : 0,
        }));
        // Server selection is source of truth; expand legacy parent IDs → leaves.
        const saved: number[] | null =
          data.selectedGroupIds === undefined
            ? null
            : (data.selectedGroupIds as number[] | null);
        setSelectedIds((prev) => ({
          ...prev,
          [credId]: expandToLeafSelection(tree, saved),
        }));
        // Shared/received selection (flat list).
        setSharedProjects((prev) => ({
          ...prev,
          [credId]: (data.sharedProjects || []) as SharedProject[],
        }));
        const savedShared: number[] | null =
          data.selectedReceivedGroupIds === undefined
            ? null
            : (data.selectedReceivedGroupIds as number[] | null);
        setSelectedSharedIds((prev) => ({
          ...prev,
          [credId]: savedShared,
        }));
      } else {
        setProjectsError((prev) => ({ ...prev, [credId]: data.error || "Failed to load projects" }));
      }
    } catch (error) {
      setProjectsError((prev) => ({ ...prev, [credId]: "Network error" }));
    } finally {
      setLoadingProjects(null);
    }
  }

  function getAllDescendantIds(tree: TreeNode[], groupId: number): number[] {
    const node = findNode(tree, groupId);
    if (!node) return [groupId];
    // Only leaf IDs are stored — parents are derived from their leaves.
    return collectLeafIds([node]);
  }

  function getAllIds(tree: TreeNode[]): number[] {
    return collectLeafIds(tree);
  }

  function toggleProject(credId: string, groupId: number) {
    const tree = projectTrees[credId] || [];
    const descendantIds = getAllDescendantIds(tree, groupId);
    const idsToToggle = new Set(descendantIds);

    setSelectedIds((prev) => {
      const current = prev[credId] ?? null;
      if (current === null) {
        const all = getAllIds(tree);
        return { ...prev, [credId]: all.filter((id) => !idsToToggle.has(id)) };
      }
      // Empty array means "none selected" — never coerce back to null (all).
      const next = current.filter((id) => !idsToToggle.has(id));
      const currentSet = new Set(current);
      for (const id of idsToToggle) {
        if (!currentSet.has(id)) next.push(id);
      }
      return { ...prev, [credId]: next };
    });
  }

  function selectAll(credId: string) {
    setSelectedIds((prev) => ({ ...prev, [credId]: null }));
  }

  function deselectAll(credId: string) {
    setSelectedIds((prev) => ({ ...prev, [credId]: [] }));
  }

  function toggleSharedProject(credId: string, groupId: number) {
    const list = sharedProjects[credId] || [];
    const allIds = list.map((p) => p.groupId);
    setSelectedSharedIds((prev) => {
      const current = prev[credId] ?? null;
      if (current === null) {
        // Currently all → materialize list minus toggled one.
        return { ...prev, [credId]: allIds.filter((id) => id !== groupId) };
      }
      if (current.includes(groupId)) {
        return { ...prev, [credId]: current.filter((id) => id !== groupId) };
      }
      return { ...prev, [credId]: [...current, groupId] };
    });
  }

  function selectAllShared(credId: string) {
    setSelectedSharedIds((prev) => ({ ...prev, [credId]: null }));
  }

  function deselectAllShared(credId: string) {
    setSelectedSharedIds((prev) => ({ ...prev, [credId]: [] }));
  }

  function isSharedSelected(credId: string, groupId: number): boolean {
    const sel = selectedSharedIds[credId];
    if (sel === null || sel === undefined) return true;
    return sel.includes(groupId);
  }

  function getSharedSelectionLabel(credId: string): string {
    const list = sharedProjects[credId] || [];
    const sel = selectedSharedIds[credId];
    if (sel === null || sel === undefined) return "All shared selected";
    if (sel.length === 0) return "No shared projects selected";
    return `${sel.length} of ${list.length} shared selected`;
  }

  async function saveProjectSelection(credId: string) {
    setSavingProjects(credId);
    try {
      const tree = projectTrees[credId] || [];
      const raw = selectedIds[credId] ?? null;
      const selectedGroupIds = expandToLeafSelection(tree, raw);
      const selectedReceived = selectedSharedIds[credId] ?? null;
      const response = await authFetch(
        "/api/settings/credentials/projects",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            credentialId: credId,
            selectedGroupIds,
            selectedReceivedGroupIds: selectedReceived,
          }),
        }
      );
      if (response.ok) {
        fetchCredentials();
      }
    } catch (error) {
      console.error("Error saving:", error);
    } finally {
      setSavingProjects(null);
    }
  }

  function getSelectionLabel(credId: string) {
    const tree = projectTrees[credId];
    const raw = selectedIds[credId];
    if (raw === null || raw === undefined) return "All projects";
    if (tree) {
      const expanded = expandToLeafSelection(tree, raw);
      if (expanded === null) return "All projects";
      if (expanded.length === 0) return "No projects selected";
      const leafCount = collectLeafIds(tree).length;
      return `${expanded.length} of ${leafCount} project(s) selected`;
    }
    if (raw.length === 0) return "No projects selected";
    return `${raw.length} project(s) selected`;
  }

  const projectsCred = projectsModalCredId
    ? credentials.find((c) => c.id === projectsModalCredId) ?? null
    : null;

  return (
    <div className="h-screen w-screen bg-gray-50 p-6 overflow-auto">
      <div className="w-full">
        <header className="mb-8 flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Settings</h1>
            <p className="mt-2 text-gray-600">Manage API credentials, project selection, and contact incharges</p>
          </div>
          <button
            onClick={() => router.push("/dashboard")}
            className="px-4 py-2 text-sm font-medium text-gray-600 bg-transparent border border-gray-500 rounded-md hover:bg-gray-100"
          >
            Dashboard
          </button>
        </header>

        {authExpired && (
          <div className="mb-6 bg-red-50 border border-red-200 rounded-lg p-4 flex items-center justify-between">
            <p className="text-red-800 font-medium">
              Your session has expired. You stay signed in until you log out.
            </p>
            <button
              onClick={() => router.push("/login")}
              className="px-4 py-2 text-sm font-medium text-red-600 bg-transparent border border-red-600 rounded-md hover:bg-red-50 shrink-0 ml-4"
            >
              Log in again
            </button>
          </div>
        )}

        <div className="flex gap-1 border-b border-gray-200 mb-6">
          {(
            [
              ["credentials", "API Credentials"],
              ["contacts", "Contact Details"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`px-4 py-2 text-sm font-medium rounded-t-md border-b-2 -mb-px ${
                activeTab === id
                  ? "border-blue-600 text-blue-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {activeTab === "contacts" && <ContactDetails />}

        {activeTab === "credentials" && (
        <div className="bg-white shadow rounded-lg">
          <div className="p-6 border-b border-gray-200 flex justify-between items-center">
            <h2 className="text-xl font-semibold text-gray-900">
              API Credentials ({credentials.length})
            </h2>
            <button onClick={() => setShowForm(true)} className="px-4 py-2 text-sm font-medium text-emerald-600 bg-transparent border border-emerald-600 rounded-md hover:bg-emerald-50">
              Add Credential
            </button>
          </div>

          <div className="divide-y divide-gray-200">
            {loading ? (
              <div className="p-6 text-center text-gray-500">Loading...</div>
            ) : credentials.length === 0 ? (
              <div className="p-6 text-center text-gray-500">
                No credentials configured. Add your first Ruijie API credential.
              </div>
            ) : (
              credentials.map((cred) => (
                <div key={cred.id} className="p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="font-medium text-gray-900">
                        {cred.name}
                        {!cred.is_active && (
                          <span className="ml-2 align-middle text-xs font-medium text-white bg-gray-500 rounded px-1.5 py-0.5">
                            Disabled
                          </span>
                        )}
                        {rateLimitedSec(cred.id) > 0 && (
                          <span
                            className="ml-2 align-middle text-xs font-medium text-white bg-amber-500 rounded px-1.5 py-0.5"
                            title="Ruijie API rate limit / quota reached for this credential — wait for the countdown before syncing or testing"
                          >
                            API limit reached ({rateLimitedSec(cred.id)}s)
                          </span>
                        )}
                      </h3>
                      <p className="text-sm text-gray-500">
                        App ID: {cred.app_id} | URL: {cred.base_url}
                      </p>
                      <p className="text-xs text-gray-400 mt-1 font-mono">
                        ID: {cred.id}
                      </p>
                      <p className="text-xs text-blue-600 mt-1">
                        {getSelectionLabel(cred.id)}
                      </p>
                    </div>
                    <div
                      className="relative flex items-center gap-2"
                      ref={managingCredId === cred.id ? manageRef : undefined}
                    >
                      <button
                        onClick={() => handleToggleActive(cred)}
                        disabled={togglingCred === cred.id}
                        title={
                          cred.is_active
                            ? "Stop this credential from calling the Ruijie API"
                            : "Let this credential call the Ruijie API again"
                        }
                        className={`px-3 py-1 text-sm font-medium text-white rounded disabled:opacity-50 ${
                          cred.is_active
                            ? "bg-red-600 hover:bg-red-700"
                            : "bg-green-600 hover:bg-green-700"
                        }`}
                      >
                        {togglingCred === cred.id
                          ? "Saving..."
                          : cred.is_active
                            ? "Disable API"
                            : "Enable API"}
                      </button>
                      <button
                        onClick={() =>
                          setManagingCredId((m) => (m === cred.id ? null : cred.id))
                        }
                        aria-expanded={managingCredId === cred.id}
                        aria-haspopup="menu"
                        className="px-3 py-1 text-sm font-medium text-blue-600 bg-transparent border border-blue-600 rounded hover:bg-blue-50"
                      >
                        Manage ▾
                      </button>
                      {managingCredId === cred.id && (
                        <div
                          role="menu"
                          className="absolute right-0 top-full mt-2 w-48 bg-white border border-gray-200 rounded-md shadow-lg z-20 p-1 space-y-1"
                        >
                          <button
                            role="menuitem"
                            onClick={() => {
                              setManagingCredId(null);
                              handleTest(cred);
                            }}
                            disabled={testing === cred.id}
                            className="w-full text-left px-4 py-2 text-sm text-blue-600 bg-transparent rounded hover:bg-blue-50 disabled:opacity-50"
                          >
                            {testing === cred.id ? "Testing..." : "Test"}
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              setManagingCredId(null);
                              handleFetchDevices(cred);
                            }}
                            disabled={fetchDevicesDisabled(cred)}
                            title="Sync site tree, device list, and metadata (max 1/minute)"
                            className="w-full text-left px-4 py-2 text-sm text-blue-600 bg-transparent rounded hover:bg-blue-50 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2"
                          >
                            {fetchingCred === cred.id ? (
                              <>
                                <svg
                                  className="animate-spin h-3.5 w-3.5 shrink-0"
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
                                Syncing...
                              </>
                            ) : fetchDevicesCooldownSec(cred.id) > 0 ? (
                              `Sync devices (${fetchDevicesCooldownSec(cred.id)}s)`
                            ) : (
                              "Sync devices"
                            )}
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              setManagingCredId(null);
                              loadProjects(cred.id);
                            }}
                            className="w-full text-left px-4 py-2 text-sm text-blue-600 bg-transparent rounded hover:bg-blue-50"
                          >
                            {projectsModalCredId === cred.id ? "Close projects" : "Projects"}
                          </button>
                          <button
                            role="menuitem"
                            onClick={() => {
                              setManagingCredId(null);
                              handleDelete(cred.id);
                            }}
                            className="w-full text-left px-4 py-2 text-sm text-red-600 bg-transparent rounded hover:bg-red-50"
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </div>
                  </div>


                </div>
              ))
            )}
          </div>
        </div>
        )}
      </div>
      <Modal
        open={showForm}
        title="Add Credential"
        onClose={() => {
          setShowForm(false);
          setError("");
        }}
      >
        <form onSubmit={handleAdd} className="space-y-4">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">{error}</div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">Name *</label>
              <input type="text" required value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="e.g., Main Account" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">App ID *</label>
              <input type="text" required value={formData.appId} onChange={(e) => setFormData({ ...formData, appId: e.target.value })} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Secret *</label>
              <input type="password" required value={formData.secret} onChange={(e) => setFormData({ ...formData, secret: e.target.value })} className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Bootstrap Token</label>
              <input type="text" value={formData.bootstrapToken} onChange={(e) => setFormData({ ...formData, bootstrapToken: e.target.value })} placeholder="Default if empty" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm" />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-gray-700">Base URL</label>
              <input type="text" value={formData.baseUrl} onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })} placeholder="https://cloud-as.ruijienetworks.com" className="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 text-sm" />
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setError("");
              }}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-transparent border border-gray-400 rounded-md hover:bg-gray-100"
            >
              Cancel
            </button>
            <button type="submit" disabled={saving} className="px-4 py-2 text-sm font-medium text-emerald-600 bg-transparent border border-emerald-600 rounded-md hover:bg-emerald-50 disabled:opacity-50">
              {saving ? "Saving..." : "Save Credential"}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        open={projectsCred !== null}
        title={`Projects — ${projectsCred?.name || ""}`}
        onClose={() => setProjectsModalCredId(null)}
        wide
      >
        {projectsCred &&
          (() => {
            const cred = projectsCred;
            return (
              <>
                {loadingProjects === cred.id ? (
                  <div className="text-center text-gray-500 py-8">Loading projects...</div>
                ) : projectsError[cred.id] ? (
                  <div className="text-center text-red-600 py-8">
                    <p className="font-medium">Failed to load projects</p>
                    <p className="text-sm mt-1">{projectsError[cred.id]}</p>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 className="text-sm font-medium text-gray-700">
                          Select projects to monitor
                        </h4>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {projectsFetchedAt[cred.id]
                            ? `Last synced ${new Date(projectsFetchedAt[cred.id]).toLocaleString()}`
                            : "Not synced yet — run Sync devices to refresh the project list"}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => selectAll(cred.id)} className="text-xs font-medium text-blue-600 bg-transparent border border-blue-600 hover:bg-blue-50 rounded px-2 py-1">
                          Select All
                        </button>
                        <button onClick={() => deselectAll(cred.id)} className="text-xs font-medium text-red-600 bg-transparent border border-red-600 hover:bg-red-50 rounded px-2 py-1">
                          Deselect All
                        </button>
                        <button onClick={() => saveProjectSelection(cred.id)} disabled={savingProjects === cred.id} className="px-3 py-1 text-xs font-medium text-green-600 bg-transparent border border-green-600 rounded hover:bg-green-50 disabled:opacity-50">
                          {savingProjects === cred.id ? "Saving..." : "Save Selection"}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1">
                      {(projectTrees[cred.id] || []).length > 0 ? (
                        (projectTrees[cred.id] || []).map((node) => (
                          <TreeNodeRow
                            key={node.groupId}
                            node={node}
                            credId={cred.id}
                            depth={0}
                            selectedIds={selectedIds}
                            toggleProject={toggleProject}
                          />
                        ))
                      ) : (availableProjects[cred.id] || []).length > 0 ? (
                        (availableProjects[cred.id] || []).map((project) => {
                          const rawSel = selectedIds[cred.id];
                          const treeSel = projectTrees[cred.id]
                            ? expandToLeafSelection(projectTrees[cred.id], rawSel ?? null)
                            : (rawSel as number[] | null);
                          const isSelected =
                            treeSel === null ||
                            treeSel === undefined ||
                            treeSel.includes(project.groupId);
                          return (
                            <label
                              key={project.groupId}
                              className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${isSelected ? "bg-blue-50" : "hover:bg-gray-100"}`}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleProject(cred.id, project.groupId)}
                                className="h-4 w-4 text-blue-600 rounded border-gray-300 focus:ring-blue-500"
                              />
                              <div className="flex-1 min-w-0">
                                <span className="text-sm font-medium text-gray-900">
                                  {project.name}
                                </span>
                                <span className="text-xs text-gray-500 ml-2">
                                  {project.type} &middot; ID: {project.groupId}
                                </span>
                              </div>
                            </label>
                          );
                        })
                      ) : (
                        <p className="text-sm text-gray-500 text-center py-4">
                          No projects found for this credential
                        </p>
                      )}
                    </div>

                    <p className="text-xs text-gray-400 mt-3">
                      {selectedIds[cred.id] === null || selectedIds[cred.id] === undefined
                        ? "All projects are selected (default)"
                        : (() => {
                            const tree = projectTrees[cred.id];
                            const expanded = tree
                              ? expandToLeafSelection(tree, selectedIds[cred.id]!)
                              : selectedIds[cred.id];
                            const leafTotal = tree
                              ? collectLeafIds(tree).length
                              : (availableProjects[cred.id] || []).length;
                            if (expanded === null) {
                              return "All projects are selected (default)";
                            }
                            return `${expanded.length} of ${leafTotal} leaf projects selected`;
                          })()}
                    </p>

                    {/* Shared/received projects checklist */}
                    {(sharedProjects[cred.id] || []).length > 0 && (
                      <div className="mt-5 pt-4 border-t border-gray-200">
                        <div className="flex items-center justify-between mb-3">
                          <div>
                            <h4 className="text-sm font-medium text-gray-700">
                              Shared projects to monitor
                            </h4>
                            <p className="text-xs text-gray-400 mt-0.5">
                              Projects shared with this account
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => selectAllShared(cred.id)}
                              className="text-xs font-medium text-blue-600 bg-transparent border border-blue-600 hover:bg-blue-50 rounded px-2 py-1"
                            >
                              Select All
                            </button>
                            <button
                              onClick={() => deselectAllShared(cred.id)}
                              className="text-xs font-medium text-red-600 bg-transparent border border-red-600 hover:bg-red-50 rounded px-2 py-1"
                            >
                              Deselect All
                            </button>
                          </div>
                        </div>

                        <div className="space-y-1">
                          {(sharedProjects[cred.id] || []).map((sp) => {
                            const isSelected = isSharedSelected(cred.id, sp.groupId);
                            return (
                              <label
                                key={sp.groupId}
                                className={`flex items-center gap-3 p-2 rounded cursor-pointer transition-colors ${isSelected ? "bg-purple-50" : "hover:bg-gray-100"}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleSharedProject(cred.id, sp.groupId)}
                                  className="h-4 w-4 text-purple-600 rounded border-gray-300 focus:ring-purple-500"
                                />
                                <div className="flex-1 min-w-0">
                                  <span className="text-sm font-medium text-gray-900">
                                    {sp.name}
                                  </span>
                                  <span className="text-xs text-gray-500 ml-2">
                                    SHARED &middot; ID: {sp.groupId}
                                    {sp.totalCount > 0 && ` \u00B7 ${sp.totalCount} devices`}
                                  </span>
                                </div>
                                {sp.tenantName && (
                                  <span className="text-xs text-purple-500 shrink-0">
                                    {sp.tenantName}
                                  </span>
                                )}
                              </label>
                            );
                          })}
                        </div>

                        <p className="text-xs text-gray-400 mt-3">
                          {getSharedSelectionLabel(cred.id)}
                        </p>
                      </div>
                    )}
                  </>
                )}
              </>
            );
          })()}
      </Modal>

      <ToastContainer toasts={toasts} onDismiss={dismissToast} />
      <ConfirmModal
        dialog={confirmDialog}
        onCancel={() => setConfirmDialog(null)}
      />
    </div>
  );
}
