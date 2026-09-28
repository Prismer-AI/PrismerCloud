// D1 (apc M2-a, docs/apc/05 §1.D1 · 11-impl-tracker M2-a) — the APC-locked
// claude-code binary + its version pin source.
//
// Why this exists: the APC dogfood loop spawns claude-code in a tight
// reproduce/edit/verify cycle. If it spawned whatever `claude` sits on the
// developer PATH, an incidental `npm i -g @anthropic-ai/claude-code` would
// silently swap the CLI version out from under the loop and change behaviour
// (the coding adapter is written against ONE pinned CLI line). So the loop
// spawns an APC-exclusive, exactly-pinned binary under a `.prismer`-family
// prefix instead — and refuses to spawn a version that does not match the pin.

import { existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { ADAPTER_KNOWN_VERSIONS } from "../../known-versions.js";

/**
 * ⚠️ CROSS-PACKAGE CONVENTION CONSTANT (sdk/apc ↔ runtime) — user ruling
 * 2026-07-24. The APC doctor side declares the SAME path at
 * `sdk/apc/env/manifest.ts::apcPinnedClaudeBinary`
 * (`~/.prismer/apc-tools/bin/claude`). The two packages MUST NOT import each
 * other (docs/apc dependency-direction rule), so the path is written once on
 * each side — **change one side, change the other.** Same `.prismer` family as
 * the isolated config dir (`config-isolation.ts` → `~/.prismer/claude-config`).
 * `sdk/apc/env/__tests__/source-contract.test.ts` greps this file for
 * `apc-tools` and pins the segment shape across the seam.
 */
export function apcToolsPrefix(home: string = os.homedir()): string {
  return path.join(home, ".prismer", "apc-tools");
}

/** APC-locked claude-code binary — absolute path, the pinned CLI the loop spawns. */
export function apcPinnedClaudeBinary(home: string = os.homedir()): string {
  return path.join(apcToolsPrefix(home), "bin", "claude");
}

/**
 * The APC-locked binary path if it is present and a regular file, else null.
 * Presence-only — version enforcement is `verifyClaudeBinaryPin` on the spawn
 * path (so an installed-but-wrong-version binary is rejected loudly, not
 * silently skipped over to a PATH claude).
 */
export function apcPinnedClaudeBinaryIfPresent(
  home: string = os.homedir(),
): string | null {
  const p = apcPinnedClaudeBinary(home);
  try {
    if (existsSync(p) && statSync(p).isFile()) {
      return p;
    }
  } catch {
    // stat race / permission — treat as absent, fall through to PATH.
  }
  return null;
}

// ── binary version pin, sourced from image-pin.yaml (NOT hand-copied) ──────

interface ImagePinBinaries {
  binaries?: { claude?: { version?: unknown } };
}

let cachedImagePinVersion: { file: string; version: string | null } | null = null;

/**
 * Locate `infra/sandbox-image/image-pin.yaml`. Priority:
 *   1. PRISMER_IMAGE_PIN_FILE env (operator / test-fixture override)
 *   2. upward search from this module's own directory for
 *      `infra/sandbox-image/image-pin.yaml` (dogfood: runtime runs from repo)
 * Returns null when neither locates a file (packaged runtime — infra/ not on
 * disk; callers fall back to the baked mirror in known-versions.ts).
 */
function locateImagePinFile(env: NodeJS.ProcessEnv): string | null {
  const override = env.PRISMER_IMAGE_PIN_FILE;
  if (override && existsSync(override)) {
    return override;
  }
  let dir: string;
  try {
    dir = path.dirname(fileURLToPath(import.meta.url));
  } catch {
    dir = process.cwd();
  }
  const rel = path.join("infra", "sandbox-image", "image-pin.yaml");
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, rel);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Read `binaries.claude.version` from image-pin.yaml — the single source of
 * truth (T8 / 08 §5.2) for the pinned claude CLI line. Cached per resolved
 * file for the process lifetime. Returns null when the file cannot be located
 * or the field is missing/blank.
 */
export function readImagePinClaudeVersion(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const file = locateImagePinFile(env);
  if (!file) return null;
  if (cachedImagePinVersion && cachedImagePinVersion.file === file) {
    return cachedImagePinVersion.version;
  }
  let version: string | null = null;
  try {
    const parsed = parseYaml(readFileSync(file, "utf8")) as ImagePinBinaries;
    const raw = parsed?.binaries?.claude?.version;
    if (typeof raw === "string" && raw.trim()) {
      version = raw.trim();
    } else if (typeof raw === "number") {
      version = String(raw);
    }
  } catch {
    version = null;
  }
  cachedImagePinVersion = { file, version };
  return version;
}

export interface ResolvedClaudeBinaryPin {
  pin: string;
  /** 'image-pin' = read from image-pin.yaml (SSOT); 'fallback' = baked mirror. */
  source: "image-pin" | "fallback";
}

/**
 * The claude CLI binary pin the spawn path enforces. Authoritative source =
 * `image-pin.yaml binaries.claude.version`. When that file is not on disk
 * (packaged / pod runtime), fall back to the baked mirror
 * `ADAPTER_KNOWN_VERSIONS['claude-code'].binaryPin` — which a contract test
 * keeps byte-equal to image-pin.yaml so the fallback can never silently drift.
 */
export function resolveClaudeBinaryPin(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedClaudeBinaryPin {
  const fromImage = readImagePinClaudeVersion(env);
  if (fromImage) {
    return { pin: fromImage, source: "image-pin" };
  }
  return {
    pin: ADAPTER_KNOWN_VERSIONS["claude-code"]?.binaryPin ?? "unknown",
    source: "fallback",
  };
}

/** Test seam: drop the memoized image-pin read (fixtures point at different files). */
export function _resetImagePinCache(): void {
  cachedImagePinVersion = null;
}
