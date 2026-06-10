const setupPlugin = {
  id: "prismer",
  name: "Prismer",
  description: "Prismer IM channel — agent messaging, discovery, and web knowledge tools",
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
