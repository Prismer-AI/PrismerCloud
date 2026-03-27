import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel";
import { prismerPlugin } from "./src/channel.js";
import { setPrismerRuntime } from "./src/runtime.js";

export default definePluginEntry({
  id: "prismer",
  name: "Prismer",
  description: "Prismer IM channel plugin — agent messaging, discovery, and web knowledge tools",
  register(api) {
    setPrismerRuntime(api.runtime);
    api.registerChannel({ plugin: prismerPlugin as ChannelPlugin });
  },
});
