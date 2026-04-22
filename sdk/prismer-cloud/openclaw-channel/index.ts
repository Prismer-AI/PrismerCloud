import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { prismerPlugin } from "./src/channel.js";
import { setPrismerRuntime } from "./src/runtime.js";

// NOTE (v1.9.0 — N2 fix): PARA / Mode-B modules are loaded lazily via
// `await import(...)` inside register(). They depend on
// `openclaw/plugin-sdk/hook-runtime` (a subpath that older hosts don't
// export) and on `@prismer/adapters-core` / `@prismer/wire` (workspace
// packages that may not be resolvable in every host). Loading them
// statically at the top of this file would throw during `jiti(...)`
// module evaluation, which the openclaw plugin loader reports as the
// generic "missing register/activate export" — because the thrown error
// leaves moduleExport as undefined. Dynamic imports localise the
// failure to a try/catch inside register(), so the channel always
// registers even when PARA cannot.

function warnNonFatal(api: OpenClawPluginApi, msg: string): void {
  try {
    api.logger.warn(msg);
  } catch {
    process.stderr.write(msg + "\n");
  }
}

const plugin = {
  id: "prismer",
  name: "Prismer",
  description:
    "Prismer IM channel plugin — agent messaging, discovery, and web knowledge tools",
  version: "1.9.0",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    // 1) Core channel: must always succeed.
    setPrismerRuntime(api.runtime);
    api.registerChannel({ plugin: prismerPlugin as ChannelPlugin });

    // 2) PARA adapter (v1.9.0) — observation-only, best-effort.
    //    Loaded dynamically so missing `@prismer/adapters-core`, missing
    //    `openclaw/plugin-sdk/hook-runtime` subpath, or any other runtime
    //    resolution failure does not kill the whole plugin.
    void (async () => {
      try {
        const mod = await import("./src/para/register.js");
        mod.registerParaAdapter(api);
      } catch (err) {
        warnNonFatal(
          api,
          `[openclaw-para] PARA adapter registration skipped (non-fatal): ${(err as Error).message}`,
        );
      }
    })();

    // 3) Mode B bridge (v1.9.x Task 3) — local /dispatch listener +
    //    daemon handshake. Fire-and-forget.
    //    See docs/version190/22-adapter-integration-contract.md §3.2.
    void (async () => {
      try {
        const mod = await import("./src/para/mode-b-bridge.js");
        await mod.startModeBBridge(api);
      } catch (err) {
        warnNonFatal(
          api,
          `[openclaw-mode-b] bridge startup skipped (non-fatal): ${(err as Error).message}`,
        );
      }
    })();
  },
  // Alias so older loader variants that look for `activate` still resolve.
  activate(api: OpenClawPluginApi) {
    return plugin.register(api);
  },
};

// Dual export: default (openclaw's loader looks at `moduleExport.default`
// first) AND a named `register` re-export (a safety net for loaders that
// unwrap ESM default differently, e.g. CJS-interop paths).
export default plugin;
export const register = (api: OpenClawPluginApi) => plugin.register(api);
export const activate = register;
