import type { ProjectTreeNode, ReceivedProject } from "@/lib/ruijie";

export interface CachedProject {
  groupId: number;
  name: string;
  type: string;
  description: string;
}

export interface CachedSharedProject {
  groupId: number;
  name: string;
  type: string;
  description: string;
  tenantName: string;
  totalCount: number;
}

export interface ProjectsCache {
  fetchedAt: number;
  projects: CachedProject[];
  tree: ProjectTreeNode[];
  sharedProjects: CachedSharedProject[];
}

export function mapSharedProjects(
  received: ReceivedProject[]
): CachedSharedProject[] {
  return received.map((rp) => ({
    groupId: rp.groupId,
    name: rp.groupName,
    type: "RECEIVED",
    description: `Shared by ${rp.tenantName}`,
    tenantName: rp.tenantName,
    totalCount: (rp.devTypeDetail || []).reduce(
      (sum, dt) => sum + (dt.totalCount || 0),
      0
    ),
  }));
}

export function parseProjectsCache(raw: unknown): ProjectsCache | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Partial<ProjectsCache>;
  if (!Array.isArray(c.projects) || !Array.isArray(c.tree)) return null;
  if (!Array.isArray(c.sharedProjects)) return null;
  return {
    fetchedAt: typeof c.fetchedAt === "number" ? c.fetchedAt : 0,
    projects: c.projects as CachedProject[],
    tree: c.tree as ProjectTreeNode[],
    sharedProjects: c.sharedProjects as CachedSharedProject[],
  };
}
