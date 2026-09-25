import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "fs";
import { createHash } from "crypto";
import path from "path";

/**
 * Durable file cache under .cache/ — survives server restarts
 * (in-memory Map in cache.ts does not).
 */

const DISK_CACHE_DIR = path.join(process.cwd(), ".cache");

interface DiskEnvelope<T> {
  key: string;
  value: T;
  storedAt: number;
}

function ensureDir(): void {
  try {
    if (!existsSync(DISK_CACHE_DIR)) {
      mkdirSync(DISK_CACHE_DIR, { recursive: true });
    }
  } catch {
    // read-only fs — memory-only fallback
  }
}

function filePath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 24);
  return path.join(DISK_CACHE_DIR, `${hash}.json`);
}

export function diskSet<T>(key: string, value: T): void {
  try {
    ensureDir();
    const envelope: DiskEnvelope<T> = { key, value, storedAt: Date.now() };
    writeFileSync(filePath(key), JSON.stringify(envelope), "utf8");
  } catch {
    // disk full / permission — ignore, memory cache still holds the value
  }
}

export function diskGet<T>(key: string): T | undefined {
  try {
    const file = filePath(key);
    if (!existsSync(file)) return undefined;
    const raw = readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as DiskEnvelope<T>;
    if (parsed?.key !== key) return undefined;
    return parsed.value;
  } catch {
    return undefined;
  }
}

export function diskDelete(key: string): void {
  try {
    const file = filePath(key);
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // ignore
  }
}
