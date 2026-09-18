import { joinSession } from "@github/copilot-sdk/extension";
import { createAdapter } from "./adapter.mjs";

const adapter = createAdapter();
const session = await joinSession(adapter.config);
await adapter.attach(session);

process.once("SIGTERM", () => {
  void adapter.close().then(() => process.exit(0), error => {
    console.error(`Workflow shutdown error: ${error.message}`);
    process.exit(1);
  });
});
