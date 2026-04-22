// setup-entry.ts is the file openclaw loads when package.json's
// openclaw.setupEntry field points here. v1.9.0 closure report §15.5
// regression showed that on openclaw 2026.4.15 the runtime plugin
// loader picks this file over extensions[0] = "./index.ts" — so
// setup-entry MUST also expose the runtime `register` function,
// otherwise the loader reports the misleading "missing register/activate
// export". We re-use the main plugin's register to keep the two paths
// in sync without duplicating logic.
import mainPlugin from "./index.js";

const setupPlugin = {
  id: "prismer",
  name: "Prismer",
  description: "Prismer IM channel — agent messaging, discovery, and web knowledge tools",
  configSchema: mainPlugin.configSchema,
  register: mainPlugin.register,
  setup: {
    configSchema: {
      type: "object",
      properties: {
        apiKey: { type: "string", description: "Prismer API key (sk-prismer-...)" },
        baseUrl: { type: "string", description: "API base URL", default: "https://prismer.cloud" },
        agentName: { type: "string", description: "Agent display name" },
      },
      required: ["apiKey"],
      additionalProperties: false,
    },
  },
};

export default setupPlugin;
export const register = mainPlugin.register;
export const activate = register;
