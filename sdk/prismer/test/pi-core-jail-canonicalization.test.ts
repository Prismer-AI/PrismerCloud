// pi-core-jail-canonicalization.test.ts — P3 hardening pin (review).
//
// realpathSync can throw EACCES/EPERM on platform states where existsSync
// still succeeded (TCC-protected ancestors, mode-000 parents, races): the
// jail walk must NOT blow up on an IN-JAIL file when canonicalization is
// refused. The pinned contract:
//   - EACCES/EPERM on realpath → fall back to the lexical (already
//     symlink-walked) prefix: in-jail reads keep working.
//   - the fallback must not weaken the jail: an escape outside cwd is still
//     denied with permission_denied.
//
// The EACCES trigger is deterministic: `node:fs` is mocked with a
// passthrough whose realpathSync throws EACCES for the marked file only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CwdJailedExecutionEnv } from "../src/adapters/runtime-engine/pi-core/agent.js";

const EACCES_MARKER = "eacces-marker.txt";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    realpathSync: (p: string) => {
      if (p.endsWith(`/${EACCES_MARKER}`)) {
        const err = new Error(`EACCES: permission denied, realpath '${p}'`) as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      return actual.realpathSync(p);
    },
  };
});

describe("pi-core jail canonicalization — EACCES fallback (review P3)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* */
      }
    }
  });

  it("in-jail read still succeeds when realpathSync is refused with EACCES (lexical fallback)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-eacces-"));
    tempDirs.push(cwd);
    writeFileSync(join(cwd, EACCES_MARKER), "JAIL_READ_OK", "utf8");

    const env = new CwdJailedExecutionEnv(new NodeExecutionEnv({ cwd }), cwd);
    const res = await env.readTextFile(EACCES_MARKER, undefined);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe("JAIL_READ_OK");
  });

  it("escape is still denied with permission_denied when canonicalization falls back (jail not weakened)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "prismer-pi-eacces-"));
    tempDirs.push(cwd);
    const outsideName = `prismer-pi-outside-${process.pid}-${Date.now()}.txt`;
    const outside = join(tmpdir(), outsideName);
    writeFileSync(outside, "OUTSIDE", "utf8");
    tempDirs.push(outside);

    const env = new CwdJailedExecutionEnv(new NodeExecutionEnv({ cwd }), cwd);
    const res = await env.readTextFile(`../${outsideName}`, undefined);

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("permission_denied");
  });
});
