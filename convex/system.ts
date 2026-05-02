import { query } from "./_generated/server";

export const getCapabilities = query({
  args: {},
  handler: async () => {
    return {
      app: "creative-factory-software",
      version: 1,
      capabilities: {
        adSetAtomicCombine: true,
      },
      checked_at: new Date().toISOString(),
    };
  },
});
