import {
  cacheFetch,
  cacheFetchDetailed,
  cacheGet,
  cacheSet,
  cacheClear,
  CacheFetchResult,
} from "@/lib/cache";
import { diskGet, diskSet, diskDelete } from "@/lib/disk-cache";

export interface RuijieCredentials {
  appId: string;
  secret: string;
  bootstrapToken?: string;
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://cloud-as.ruijienetworks.com";
const DEFAULT_BOOTSTRAP_TOKEN = "d63dss0a81e4415a889ac5b78fsc904a";

// TTLs: online/offline status every 100m; device meta + site tree only via
// Settings → Fetch devices (long TTL, cleared by invalidateCredentialCaches).
// Budget (steady-state, dashboard open): status fleet ≈ 2 creds × ~15/day
//   + received/warns 100m each → far under 5k/day.
const STATUS_INTERVAL_MS = 100 * 60_000;
const TTL_TREE_MS = 7 * 24 * 60 * 60_000;
const TTL_RECEIVED_MS = STATUS_INTERVAL_MS;
const TTL_DEVICE_STATUS_MS = STATUS_INTERVAL_MS;
const TTL_DEVICE_META_MS = 7 * 24 * 60 * 60_000;
const TTL_WARN_MS = STATUS_INTERVAL_MS;

export const DEVICE_STATUS_INTERVAL_SECONDS = Math.floor(STATUS_INTERVAL_MS / 1000);

const tokenCache = new Map<string, { token: string; expiry: number }>();

export function clearTokenCache(appId?: string) {
  if (appId) {
    for (const key of tokenCache.keys()) {
      if (key.endsWith(`:${appId}`)) tokenCache.delete(key);
    }
  } else {
    tokenCache.clear();
  }
}

export async function getRuijieToken(
  creds: RuijieCredentials
): Promise<string> {
  const baseUrl = creds.baseUrl || DEFAULT_BASE_URL;
  const bootstrapToken = creds.bootstrapToken || DEFAULT_BOOTSTRAP_TOKEN;
  const cacheKey = `${baseUrl}:${creds.appId}`;

  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiry) {
    return cached.token;
  }

  if (isCoolingDown(creds) > Date.now()) {
    throw rateLimitError(creds, "oauth token");
  }

  const response = await throttledFetch(
    creds,
    `${baseUrl}/service/api/oauth20/client/access_token?token=${bootstrapToken}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appid: creds.appId,
        secret: creds.secret,
      }),
    }
  );

  const data = await response.json();
  const token = data.accessToken as string | undefined;
  const expiresIn = data.expiresIn as number | undefined;

  if (data.code === 44) {
    startCooldown(creds);
    throw rateLimitError(creds, "oauth token");
  }

  if (data.code !== 0 || !token) {
    // Clear stale cache on auth failure
    tokenCache.delete(cacheKey);
    throw new Error(
      `Ruijie auth failed (code ${data.code}): ${data.msg || JSON.stringify(data)}`
    );
  }

  tokenCache.set(cacheKey, {
    token,
    expiry: Date.now() + (expiresIn || 3600) * 1000 - 60000,
  });

  return token;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 500; // 500ms between calls (limit is 20/sec)
/**
 * Per-credential cooldown after code 44.
 * Keyed by baseUrl:appId so one limited app doesn't freeze the other account.
 */
const cooldownUntil = new Map<string, number>();
// Long enough that the dashboard can show "limit reached" before it vanishes;
// short enough that we retry without sitting on a dead credential for minutes.
const RATE_LIMIT_COOLDOWN_MS = 120_000;

function credKey(creds: RuijieCredentials): string {
  return `${creds.baseUrl || DEFAULT_BASE_URL}:${creds.appId}`;
}

function isCoolingDown(creds: RuijieCredentials): number {
  return cooldownUntil.get(credKey(creds)) || 0;
}

function startCooldown(creds: RuijieCredentials): void {
  cooldownUntil.set(credKey(creds), Date.now() + RATE_LIMIT_COOLDOWN_MS);
}

function rateLimitError(creds: RuijieCredentials, path: string): Error {
  const remain = Math.max(0, isCoolingDown(creds) - Date.now());
  const secs = Math.ceil(remain / 1000);
  if (remain > 0) {
    return new Error(
      `Ruijie rate limited — wait ${secs}s before retrying (${path})`
    );
  }
  return new Error(`Ruijie rate limited (code 44): ${path}`);
}

/** True when an error came from this app's rate-limit handling (code 44 / cooldown). */
export function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("rate limited");
}

export interface RateLimitStatus {
  limited: boolean;
  retryInSeconds: number;
}

/** Per-credential rate-limit state for dashboard indicators. */
export function getRateLimitStatus(creds: RuijieCredentials): RateLimitStatus {
  const until = isCoolingDown(creds);
  const now = Date.now();
  if (until > now) {
    return { limited: true, retryInSeconds: Math.ceil((until - now) / 1000) };
  }
  return { limited: false, retryInSeconds: 0 };
}

async function throttledFetch(
  creds: RuijieCredentials,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const cool = isCoolingDown(creds);
  if (Date.now() < cool) {
    throw rateLimitError(creds, url);
  }
  const now = Date.now();
  const wait = MIN_REQUEST_INTERVAL - (now - lastRequestTime);
  if (wait > 0) await delay(wait);
  lastRequestTime = Date.now();
  return fetch(url, init);
}

async function fetchRuijie<T>(
  creds: RuijieCredentials,
  path: string,
  _isRetry = false
): Promise<T> {
  const baseUrl = creds.baseUrl || DEFAULT_BASE_URL;
  const token = await getRuijieToken(creds);
  const separator = path.includes("?") ? "&" : "?";
  const url = `${baseUrl}${path}${separator}access_token=${token}`;
  const response = await throttledFetch(creds, url);

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`Non-JSON response from Ruijie API: ${path}`);
  }

  const data = await response.json();

  if (data.code === 44) {
    startCooldown(creds);
    throw rateLimitError(creds, path);
  }

  // Token expired — clear cache and retry once
  if ((data.code === 3 || data.code === 401) && !_isRetry) {
    clearTokenCache(creds.appId);
    return fetchRuijie<T>(creds, path, true);
  }

  return data;
}

export interface RuijieProject {
  groupId: number;
  name: string;
  type: string;
  description: string;
  businessType: string;
  credentialId?: string;
  credentialName?: string;
  /** Site coordinates from the group tree (leaf BUILDING nodes). */
  latitude?: number;
  longitude?: number;
  /** Reverse-geocoded province (or equivalent) for the site. */
  province?: string;
}

export interface RuijieDevice {
  serialNumber: string;
  productClass: string;
  productType: string;
  commonType: string;
  onlineStatus: string;
  aliasName: string;
  name: string;
  localIp: string;
  cpeIp: string;
  mac: string;
  groupName: string;
  parentGroupName: string;
  buildingId: number;
  groupId: number;
  lastOnline: number;
  createTime: number;
  staNums: number;
  staActiveNums: number;
  softwareVersion: string;
}

interface GroupTreeNode {
  name: string;
  groupId: number;
  type: string;
  description?: string;
  businessType?: string;
  latitude?: number;
  longitude?: number;
  subGroups?: GroupTreeNode[];
}

export interface ProjectTreeNode {
  groupId: number;
  name: string;
  type: string;
  description: string;
  childIds: number[];
  children: ProjectTreeNode[];
  latitude?: number;
  longitude?: number;
}

function buildProjectTree(node: GroupTreeNode): ProjectTreeNode | null {
  if (node.groupId === 0 && (!node.subGroups || node.subGroups.length === 0)) {
    return null;
  }

  const children: ProjectTreeNode[] = [];
  if (node.subGroups) {
    for (const child of node.subGroups) {
      const built = buildProjectTree(child);
      if (built) children.push(built);
    }
  }

  return {
    groupId: node.groupId,
    name: node.name,
    type: node.type,
    description: node.description || "",
    childIds: children.map((c) => c.groupId),
    children,
    latitude: node.latitude,
    longitude: node.longitude,
  };
}

export async function fetchProjectTree(
  creds: RuijieCredentials
): Promise<{ tree: ProjectTreeNode[]; flat: RuijieProject[] }> {
  // v3: include leaf latitude/longitude from the group tree (province/geo).
  return cacheFetch(`tree:v3:${credKey(creds)}`, TTL_TREE_MS, async () => {
    const data = await fetchRuijie<{
      code: number;
      msg: string;
      groups: GroupTreeNode;
    }>(creds, "/service/api/group/single/tree");

    if (data.code !== 0 || !data.groups) {
      throw new Error(
        `Failed to fetch groups (code ${data.code}): ${data.msg}`
      );
    }

    const tree = buildProjectTree(data.groups);
    return {
      tree: tree ? tree.children : [],
      flat: flattenGroupTree(data.groups),
    };
  });
}

function flattenGroupTree(
  node: GroupTreeNode,
  credentialId?: string,
  credentialName?: string
): RuijieProject[] {
  const projects: RuijieProject[] = [];
  const hasChildren = Boolean(node.subGroups && node.subGroups.length > 0);

  // Sites are leaf groups only — skip root (0) and parent/sub-root containers.
  if (node.groupId !== 0 && !hasChildren) {
    projects.push({
      groupId: node.groupId,
      name: node.name,
      type: node.type,
      description: node.description || "",
      businessType: node.businessType || "",
      credentialId,
      credentialName,
      latitude: node.latitude,
      longitude: node.longitude,
    });
  }

  if (node.subGroups) {
    for (const child of node.subGroups) {
      projects.push(...flattenGroupTree(child, credentialId, credentialName));
    }
  }

  return projects;
}

export async function getProjects(
  creds: RuijieCredentials
): Promise<RuijieProject[]> {
  // v3: include leaf latitude/longitude; drop pre-geo flat lists.
  return cacheFetch(`projects:v3:${credKey(creds)}`, TTL_TREE_MS, async () => {
    const data = await fetchRuijie<{
      code: number;
      msg: string;
      groups: GroupTreeNode;
    }>(creds, "/service/api/group/single/tree");

    if (data.code !== 0 || !data.groups) {
      throw new Error(
        `Failed to fetch groups (code ${data.code}): ${data.msg}`
      );
    }

    return flattenGroupTree(data.groups);
  });
}

function collectLeafIdList(nodes: ProjectTreeNode[]): number[] {
  const ids: number[] = [];
  const walk = (list: ProjectTreeNode[]) => {
    for (const n of list) {
      if (n.children.length === 0) ids.push(n.groupId);
      else walk(n.children);
    }
  };
  walk(nodes);
  return ids;
}

/**
 * Normalize a saved selection to leaf project IDs only.
 * null stays null (all). Parent IDs expand to their leaf descendants.
 * IDs not present in the current tree are dropped.
 */
export function expandSelectionToLeaves(
  tree: ProjectTreeNode[],
  ids: number[] | null
): number[] | null {
  if (ids === null) return null;
  const leaves = new Set(collectLeafIdList(tree));
  const result = new Set<number>();

  const mark = (nodes: ProjectTreeNode[], underSelected: boolean) => {
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

export interface ReceivedProject {
  groupId: number;
  groupName: string;
  operation: number;
  expiredAt: number;
  tenantId: number;
  tenantName: string;
  remark: string;
  receiveTime: number;
  timezone: string;
  businessType: string;
  hasSubGroup: boolean;
  sceneType: string;
  devTypeDetail: {
    productType: string;
    onCount: number;
    offCount: number;
    totalCount: number;
    buildingId: number;
    commonType: string;
  }[];
}

export async function getReceivedProjects(
  creds: RuijieCredentials
): Promise<ReceivedProject[]> {
  return cacheFetch(
    `received:${credKey(creds)}`,
    TTL_RECEIVED_MS,
    async () => {
      const data = await fetchRuijie<{
        code: number;
        msg: string;
        sharedGroupList: ReceivedProject[];
        count: number;
      }>(creds, "/service/api/network/cooperate/share/imported-project/list?pageNum=1&pageSize=500");

      if (data.code !== 0) {
        throw new Error(
          `Failed to fetch received projects (code ${data.code}): ${data.msg}`
        );
      }

      return data.sharedGroupList || [];
    }
  );
}

/**
 * Leaf/group coordinates for a group id (`GET /service/api/group/{id}`).
 * Cached for the tree TTL — site locations rarely move.
 */
export async function getGroupGeo(
  creds: RuijieCredentials,
  groupId: number
): Promise<{ latitude?: number; longitude?: number }> {
  return cacheFetch(
    `group-geo:v1:${credKey(creds)}:${groupId}`,
    TTL_TREE_MS,
    async () => {
      const data = await fetchRuijie<{
        code: number;
        msg: string;
        groups?: { latitude?: number; longitude?: number };
      }>(creds, `/service/api/group/${groupId}`);
      if (data.code !== 0 || !data.groups) {
        return {};
      }
      const { latitude, longitude } = data.groups;
      return {
        latitude: typeof latitude === "number" ? latitude : undefined,
        longitude: typeof longitude === "number" ? longitude : undefined,
      };
    }
  );
}

async function fetchDevicesPage(
  creds: RuijieCredentials,
  groupId: number,
  page: number
): Promise<{ code: number; msg: string; deviceList?: RuijieDevice[]; totalCount?: number }> {
  return fetchRuijie(
    creds,
    `/service/api/maint/devices?group_id=${groupId}&page=${page}&per_page=200`
  );
}

type DeviceMeta = Omit<RuijieDevice, "onlineStatus" | "lastOnline">;
type DeviceStatus = Pick<RuijieDevice, "onlineStatus" | "lastOnline">;

interface DeviceStore {
  /** Cache/identity key for this credential (baseUrl:appId). */
  key: string;
  /** serialNumber → identity fields (name, IP, product, …) — long-lived. */
  meta: Map<string, DeviceMeta>;
  /** serialNumber → online/offline only — rechecked on the short TTL. */
  status: Map<string, DeviceStatus>;
  /** When online/offline was last confirmed from the API. */
  statusCheckedAt: number;
}

const deviceStores = new Map<string, DeviceStore>();

interface PersistedDeviceStore {
  meta: [string, DeviceMeta][];
  status: [string, DeviceStatus][];
  statusCheckedAt: number;
}

function deviceStoreDiskKey(key: string): string {
  return `device-store:${key}`;
}

function persistDeviceStore(store: DeviceStore): void {
  const payload: PersistedDeviceStore = {
    meta: [...store.meta],
    status: [...store.status],
    statusCheckedAt: store.statusCheckedAt,
  };
  const memKey = deviceStoreDiskKey(store.key);
  cacheClear(memKey);
  cacheSet(memKey, payload, TTL_DEVICE_META_MS);
  // Survive server restarts so Settings → Sync devices is not needed every boot.
  diskSet(memKey, payload);
}

function loadPersistedDeviceStore(key: string): PersistedDeviceStore | undefined {
  const memKey = deviceStoreDiskKey(key);
  const mem = cacheGet<PersistedDeviceStore>(memKey);
  if (mem) return mem;
  const disk = diskGet<PersistedDeviceStore>(memKey);
  if (disk) {
    // Rehydrate memory so the next process-local hit skips disk.
    cacheSet(memKey, disk, TTL_DEVICE_META_MS);
    return disk;
  }
  return undefined;
}

function getDeviceStore(creds: RuijieCredentials): DeviceStore {
  const key = credKey(creds);
  let store = deviceStores.get(key);
  if (!store) {
    const persisted = loadPersistedDeviceStore(key);
    if (persisted) {
      store = {
        key,
        meta: new Map(persisted.meta),
        status: new Map(persisted.status),
        statusCheckedAt: persisted.statusCheckedAt || 0,
      };
    } else {
      store = { key, meta: new Map(), status: new Map(), statusCheckedAt: 0 };
    }
    deviceStores.set(key, store);
  }
  return store;
}

function splitDevice(d: RuijieDevice): { meta: DeviceMeta; status: DeviceStatus } {
  const { onlineStatus, lastOnline, ...meta } = d;
  return { meta, status: { onlineStatus, lastOnline } };
}

function mergeStore(store: DeviceStore): RuijieDevice[] {
  const out: RuijieDevice[] = [];
  for (const [sn, status] of store.status) {
    const meta = store.meta.get(sn);
    if (!meta) continue;
    out.push({ ...meta, ...status });
  }
  return out;
}

function applyFleetToStore(store: DeviceStore, fleet: RuijieDevice[]): void {
  const seen = new Set<string>();
  for (const d of fleet) {
    const { meta, status } = splitDevice(d);
    store.meta.set(d.serialNumber, meta);
    store.status.set(d.serialNumber, status);
    seen.add(d.serialNumber);
  }
  for (const sn of store.status.keys()) {
    if (!seen.has(sn)) store.status.delete(sn);
  }
  store.statusCheckedAt = Date.now();
  persistDeviceStore(store);
}

/** Status-only cycle: touch online/offline for known SNs; no adds/removes. */
function applyFleetStatusOnly(store: DeviceStore, fleet: RuijieDevice[]): void {
  for (const d of fleet) {
    if (!store.meta.has(d.serialNumber)) continue;
    store.status.set(d.serialNumber, {
      onlineStatus: d.onlineStatus,
      lastOnline: d.lastOnline,
    });
  }
  store.statusCheckedAt = Date.now();
  persistDeviceStore(store);
}

function isStatusFresh(store: DeviceStore): boolean {
  return (
    store.statusCheckedAt > 0 &&
    Date.now() - store.statusCheckedAt < TTL_DEVICE_STATUS_MS &&
    store.meta.size > 0
  );
}

/** True when device identity has been loaded via Settings → Fetch devices. */
export function hasDeviceInventory(creds: RuijieCredentials): boolean {
  return getDeviceStore(creds).meta.size > 0;
}

/** Reset the 100m status window (dashboard Refresh). */
export function invalidateDeviceStatus(creds: RuijieCredentials): void {
  const key = credKey(creds);
  const store = getDeviceStore(creds);
  store.statusCheckedAt = 0;
  cacheClear(`fleet-raw:${key}`);
  cacheClear(`received:${key}`);
  cacheClear(`warns:${key}`);
}

/**
 * Settings → Fetch devices: drop site tree, device meta/membership, and
 * related caches so the next load discovers new devices/sites.
 */
export function invalidateCredentialCaches(creds: RuijieCredentials): void {
  const key = credKey(creds);
  deviceStores.delete(key);
  cacheClear(`device-store:${key}`);
  diskDelete(`device-store:${key}`);
  for (const prefix of [
    "tree:",
    "tree:v2:",
    "tree:v3:",
    "tree-raw:",
    "tree-raw:v2:",
    "projects:",
    "projects:v2:",
    "projects:v3:",
    "fleet-raw:",
    "devices:",
    "devices-status:",
    "received:",
    "warns:",
    "group-geo:v1:",
  ]) {
    cacheClear(`${prefix}${key}`);
  }
}

/** Settings → Fetch devices: clear caches, then warm projects + fleet + received. */
export async function refreshCredentialInventory(
  creds: RuijieCredentials
): Promise<{ projectCount: number; deviceCount: number; receivedCount: number }> {
  invalidateCredentialCaches(creds);

  const projects = await getProjects(creds);
  const fleet = await getFleetDevices(creds, { mode: "meta" });

  let receivedCount = 0;
  try {
    const received = await getReceivedProjects(creds);
    receivedCount = received.length;
  } catch {
    // Shared/imported list may be denied — inventory still refreshed above.
  }

  return {
    projectCount: projects.length,
    deviceCount: fleet.length,
    receivedCount,
  };
}

/** Raw fleet pages with dedupe / failure backoff / stale-on-error. */
async function fetchFleetRaw(
  creds: RuijieCredentials
): Promise<CacheFetchResult<RuijieDevice[]>> {
  const result = await cacheFetchDetailed<RuijieDevice[]>(
    `fleet-raw:${credKey(creds)}`,
    TTL_DEVICE_META_MS,
    async () => {
      const treeData = await cacheFetch(
        `tree-raw:v2:${credKey(creds)}`,
        TTL_TREE_MS,
        () =>
          fetchRuijie<{
            code: number;
            msg: string;
            groupId?: number;
            rootGroupId?: number;
            groups: GroupTreeNode;
          }>(creds, "/service/api/group/single/tree")
      );

      if (treeData.code !== 0 || !treeData.groups) {
        throw new Error(
          `Failed to fetch group tree (code ${treeData.code}): ${treeData.msg}`
        );
      }

      // Resolve root: explicit non-zero id, else single wrapper child, else
      // account root 0 when top-level groups hang directly off "dumy".
      const g = treeData.groups;
      const wrapperIds = (g.subGroups || [])
        .map((s) => s.groupId)
        .filter((id): id is number => Boolean(id));
      const hasTopLevel = (g.subGroups || []).length > 0;
      let rootId =
        treeData.groupId ||
        treeData.rootGroupId ||
        g.groupId ||
        (wrapperIds.length === 1 ? wrapperIds[0] : 0);

      // Root 0 with several direct children (no ROOT wrapper) — fleet via 0.
      if (!rootId && hasTopLevel && g.groupId === 0) {
        rootId = 0;
      }

      if (!rootId && !(hasTopLevel && g.groupId === 0)) {
        // Empty root would make a useless call; surface as failure so callers
        // don't treat "no fleet" as "zero devices" forever.
        throw new Error("Could not resolve Ruijie root groupId for fleet fetch");
      }

      const all: RuijieDevice[] = [];
      for (let page = 1; page <= 50; page++) {
        const data = await fetchDevicesPage(creds, rootId, page);
        if (data.code !== 0) {
          if (page === 1) {
            console.error(`Ruijie fleet error (code ${data.code}): ${data.msg}`);
          }
          // code 5 etc. — don't cache a partial empty fleet as success
          if (page === 1 && all.length === 0) {
            throw new Error(`Ruijie fleet denied (code ${data.code}): ${data.msg}`);
          }
          break;
        }
        const list = data.deviceList || [];
        all.push(...list);
        const total = data.totalCount ?? 0;
        if (!list.length || all.length >= total) break;
      }
      return all;
    }
  );

  return result;
}

/**
 * One paginated call for the whole account (root group).
 *
 * mode "status" (default): every 100m (or after invalidateDeviceStatus) refresh
 * online/offline only — never writes device meta (name/IP/etc.).
 * Device inventory identity is loaded only via mode "meta" (Settings → Fetch devices).
 *
 * mode "meta": full rebuild of membership + identity (Settings → Fetch devices).
 */
export async function getFleetDevices(
  creds: RuijieCredentials,
  opts?: { mode?: "status" | "meta" }
): Promise<RuijieDevice[]> {
  const mode = opts?.mode ?? "status";
  const store = getDeviceStore(creds);

  if (mode === "status") {
    if (isStatusFresh(store)) {
      return mergeStore(store);
    }
    // Status cycles must not discover/build inventory — Fetch devices only.
    if (store.meta.size === 0) {
      return [];
    }
  }

  // Live check must not reuse a long-lived raw snapshot.
  cacheClear(`fleet-raw:${credKey(creds)}`);

  try {
    const { value: fleet, stale } = await fetchFleetRaw(creds);
    // Stale-on-error must not mark status as freshly checked.
    if (!stale) {
      if (mode === "meta") {
        applyFleetToStore(store, fleet);
      } else {
        // Status cycle: online/offline only — never write name/IP/meta.
        applyFleetStatusOnly(store, fleet);
      }
    } else if (store.status.size === 0 && mode === "meta") {
      applyFleetToStore(store, fleet);
      store.statusCheckedAt = Date.now() - TTL_DEVICE_STATUS_MS;
    }
    if (store.meta.size > 0 && store.status.size > 0) return mergeStore(store);
    if (mode === "meta") return fleet;
    return store.meta.size > 0 ? mergeStore(store) : [];
  } catch (err) {
    if (store.meta.size > 0 && store.status.size > 0) {
      // Keep previous statusCheckedAt so the next call retries the check.
      return mergeStore(store);
    }
    if (mode === "status") return [];
    throw err;
  }
}

export async function getDevices(
  creds: RuijieCredentials,
  groupId: number
): Promise<RuijieDevice[]> {
  // Prefer the account-wide fleet: one status check covers every group.
  // Never discover inventory from this path — meta only via Fetch devices.
  try {
    const fleet = await getFleetDevices(creds, { mode: "status" });
    if (fleet.length > 0) {
      const scoped = fleet.filter(
        (d) => d.groupId === groupId || d.buildingId === groupId
      );
      if (scoped.length > 0) return scoped;
      // Fleet answered but this group has no devices (or is shared/denied).
    }
    if (fleet.length === 0 && getDeviceStore(creds).meta.size === 0) {
      // Inventory not loaded yet — require Settings → Fetch devices.
      return [];
    }
  } catch {
    // Fleet unavailable — fall through to cached group slice only.
  }

  const key = `devices:${credKey(creds)}:${groupId}`;

  // Status-only freshness for this group's slice.
  const groupStatusKey = `devices-status:${credKey(creds)}:${groupId}`;
  const statusCheckedAt = cacheGet<number>(groupStatusKey);
  if (
    statusCheckedAt !== undefined &&
    Date.now() - statusCheckedAt < TTL_DEVICE_STATUS_MS
  ) {
    const cached = cacheGet<RuijieDevice[]>(key);
    if (cached) return cached;
  }

  // Shared projects the fleet omits: serve cache only — no meta rebuild here.
  const cached = cacheGet<RuijieDevice[]>(key);
  if (cached) return cached;
  return [];
}

export interface RuijieWarnLog {
  id: number;
  tenantId: number;
  buildId: number;
  groupId: number;
  sn: string;
  warnEntityType: string;
  componentId: number;
  warnType: number;
  warnLevel: string;
  warnLog: string;
  warnParams: string;
  createTime: number;
  eliminateTime: number;
  updateTime: number;
  identityKey: string;
  buildName: string;
  parentGroupName: string;
  deviceName?: string;
  productClass?: string;
  productType?: string;
  isEliminate: boolean;
  warnTypeDesc: string;
}

const WARN_LOG_PAGE_SIZE = 50;
const WARN_LOG_MAX_PAGES = 5; // identity only — don't burn quota on history

export async function getWarnLogs(
  creds: RuijieCredentials
): Promise<RuijieWarnLog[]> {
  return cacheFetch(`warns:${credKey(creds)}`, TTL_WARN_MS, async () => {
    const all: RuijieWarnLog[] = [];

    for (let page = 1; page <= WARN_LOG_MAX_PAGES; page++) {
      const data = await fetchRuijie<{
        code: number;
        msg: string;
        data?: { logList?: RuijieWarnLog[]; totalCount?: number };
      }>(
        creds,
        `/service/api/warn/warnlog?page=${page}&per_page=${WARN_LOG_PAGE_SIZE}`
      );

      if (data.code !== 0) {
        if (page === 1) {
          console.error(`Ruijie warnlog error (code ${data.code}): ${data.msg}`);
        }
        break;
      }

      const list = data.data?.logList || [];
      all.push(...list);

      const total = data.data?.totalCount ?? 0;
      if (!list.length || all.length >= total) break;
    }

    return all;
  });
}

/**
 * Warn logs for a single group (server-side `group_id` filter).
 *
 * The pooled `getWarnLogs` list is capped, so groups far down the global
 * history (shared/received projects) return nothing — this endpoint scopes
 * to the group and is the only open-API source of lastOnline for shared
 * projects, whose device list is denied (code 5).
 */
const WARN_LOG_GROUP_MAX_PAGES = 3; // newest 150 rows are enough for identity

export async function getWarnLogsForGroup(
  creds: RuijieCredentials,
  groupId: number
): Promise<RuijieWarnLog[]> {
  return cacheFetch(
    `warns:g${groupId}:${credKey(creds)}`,
    TTL_WARN_MS,
    async () => {
      const all: RuijieWarnLog[] = [];

      for (let page = 1; page <= WARN_LOG_GROUP_MAX_PAGES; page++) {
        const data = await fetchRuijie<{
          code: number;
          msg: string;
          data?: { logList?: RuijieWarnLog[]; totalCount?: number };
        }>(
          creds,
          `/service/api/warn/warnlog?group_id=${groupId}&page=${page}&per_page=${WARN_LOG_PAGE_SIZE}`
        );

        if (data.code !== 0) {
          if (page === 1) {
            console.error(
              `Ruijie warnlog error for group ${groupId} (code ${data.code}): ${data.msg}`
            );
          }
          break;
        }

        const list = data.data?.logList || [];
        all.push(...list);

        const total = data.data?.totalCount ?? 0;
        if (!list.length || all.length >= total) break;
      }

      return all;
    }
  );
}
