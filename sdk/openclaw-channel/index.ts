import type { ChannelPlugin, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { prismerPlugin } from "./src/channel.js";
import { setPrismerRuntime } from "./src/runtime.js";

const plugin = {
  id: "prismer",
  name: "Prismer",
  description: "Prismer IM channel plugin — agent messaging, discovery, and web knowledge tools",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setPrismerRuntime(api.runtime);
    api.registerChannel({ plugin: prismerPlugin as ChannelPlugin });
  },
};

export default plugin;
