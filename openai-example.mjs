import OpenAI from "openai";

const authorization = process.env.FOUNDATION_READ_ONLY_KEY ?? process.env.FOUNDATION_API_KEY;
if (!authorization) throw new Error("Set FOUNDATION_READ_ONLY_KEY or FOUNDATION_API_KEY");

const client = new OpenAI();
const response = await client.responses.create({
  model: process.env.OPENAI_MODEL ?? "gpt-5",
  input: "Search my Foundation memory for preferences about terminal applications.",
  tools: [{
    type: "mcp",
    server_label: "foundation",
    server_description: "Private atomized long-term memory",
    server_url: process.env.FOUNDATION_MCP_URL ?? "https://foundation.example.com/mcp",
    authorization,
    allowed_tools: ["atom_search", "atom_context", "atom_get", "atom_stats"],
    require_approval: "never"
  }]
});

console.log(response.output_text);
