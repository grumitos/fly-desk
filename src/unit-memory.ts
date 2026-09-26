import { readFileSync } from "node:fs";
import { join } from "node:path";

/*
 * The memory of the unit this process runs in, read from its cgroup (v2): the
 * anonymous memory of every process in it — for the search runner, the runner
 * and its pooled workers — against the unit's `MemoryHigh`, or its
 * `MemoryMax` when it has no high mark. Anonymous memory is what the kernel
 * can reclaim only by swapping; the page cache of the SQLite files, which it
 * drops first, is left out.
 *
 * A host without cgroup v2, or a unit without a limit (a workstation, CI),
 * has no reading. `FLY_DESK_CGROUP_DIR` names a directory to read instead of
 * this process's own cgroup.
 */
export interface UnitMemoryReading {
  usedBytes: number;
  limitBytes: number;
}

export type UnitMemoryGauge = () => UnitMemoryReading | undefined;

function ownCgroupDir(): string | undefined {
  if (process.platform !== "linux") {
    return undefined;
  }

  try {
    const unified = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"));
    const path = unified?.slice(3).trim();
    return path ? join("/sys/fs/cgroup", path) : undefined;
  } catch {
    return undefined;
  }
}

function readLimitBytes(dir: string, file: string): number | undefined {
  try {
    const raw = readFileSync(join(dir, file), "utf8").trim();
    const bytes = Number(raw);
    return raw !== "max" && Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

function readAnonymousBytes(dir: string): number | undefined {
  try {
    const match = /^anon (\d+)$/m.exec(readFileSync(join(dir, "memory.stat"), "utf8"));
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export function createUnitMemoryGauge(
  dir = process.env.FLY_DESK_CGROUP_DIR?.trim() || ownCgroupDir(),
): UnitMemoryGauge {
  if (!dir) {
    return () => undefined;
  }

  return () => {
    const limitBytes = readLimitBytes(dir, "memory.high") ?? readLimitBytes(dir, "memory.max");
    const usedBytes = readAnonymousBytes(dir);
    return limitBytes !== undefined && usedBytes !== undefined ? { usedBytes, limitBytes } : undefined;
  };
}
