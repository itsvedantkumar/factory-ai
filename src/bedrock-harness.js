import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";

function definitions(tools) {
  return Object.entries(tools).map(([name, tool]) => ({
    toolSpec: {
      name,
      description: tool.description,
      inputSchema: { json: tool.parameters },
    },
  }));
}

export class BedrockHarness {
  constructor({ client, region = process.env.AWS_REGION ?? "us-east-1", model, tools, maxSteps = 40, maxOutputTokens = 4096 }) {
    this.client = client ?? new BedrockRuntimeClient({ region });
    this.model = model;
    this.tools = tools;
    this.maxSteps = maxSteps;
    this.maxOutputTokens = maxOutputTokens;
  }

  async run(prompt) {
    const messages = [{ role: "user", content: [{ text: prompt }] }];
    const usage = { inputTokens: 0, outputTokens: 0 };
    for (let step = 0; step < this.maxSteps; step += 1) {
      const response = await this.client.send(new ConverseCommand({
        modelId: this.model,
        messages,
        inferenceConfig: { maxTokens: this.maxOutputTokens },
        ...(Object.keys(this.tools).length ? { toolConfig: { tools: definitions(this.tools) } } : {}),
      }));
      usage.inputTokens += response.usage?.inputTokens ?? 0;
      usage.outputTokens += response.usage?.outputTokens ?? 0;
      const message = response.output?.message;
      const calls = (message?.content ?? []).flatMap((item) => item.toolUse ? [item.toolUse] : []);
      if (calls.length === 0) {
        const text = (message?.content ?? []).flatMap((item) => typeof item.text === "string" ? [item.text] : []).join("\n");
        return { text, steps: step + 1, usage };
      }
      messages.push(message);
      const results = [];
      for (const call of calls) {
        const tool = this.tools[call.name];
        if (!tool) throw new Error(`Tool not allowed: ${call.name}`);
        let value;
        let status = "success";
        try { value = await tool.execute(call.input ?? {}); } catch (error) { value = `ERROR: ${String(error.message ?? error).slice(0, 4000)}`; status = "error"; }
        results.push({ toolResult: { toolUseId: call.toolUseId, content: [{ text: typeof value === "string" ? value : JSON.stringify(value) }], status } });
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error(`Agent exceeded step limit of ${this.maxSteps}`);
  }
}
