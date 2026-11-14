// End-to-end: connects a real MCP client to the server in memory and calls the keyless research + check tools (needs internet).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../lib/server";
(async () => {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));
  const r: any = await client.callTool({ name: "research_content", arguments: { topic: "gutter cleaning", location: "Winnipeg, Manitoba" } });
  console.log(r.content[0].text);
  const pb: any = await client.callTool({ name: "creative_playbook", arguments: { platform: "instagram", format: "post" } });
  console.log("playbook chars:", pb.content[0].text.length, pb.content[0].text.includes("Hook formulas"));
  const cp: any = await client.callTool({ name: "check_post", arguments: { platform: "instagram", brand: { name: "Gutter Genie", location_or_market: "Winnipeg", what_they_sell: ["Eavestrough cleaning"] }, post: { format: "post", hook: "Did you know gutters matter?", caption: "Did you know gutters matter? We clean them. We are the best team and we love our work.", hashtags: ["#gutters", "#home", "#clean"], cta: "Call us" }, self_scores: { hook: 4 } } });
  console.log(cp.content[0].text);
  process.exit(0);
})();
