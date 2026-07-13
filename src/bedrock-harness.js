import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { compactCheckpoint } from "./context-compaction.js";

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
  constructor({ client, region = process.env.AWS_REGION ?? "us-east-1", credentials, model, tools, maxSteps = 40, maxOutputTokens = 4096, onEvent = () => {}, compactAfterInputTokens = 80_000, compactMaxCharacters = 24_000 }) {
    this.client = client ?? new BedrockRuntimeClient({ region, credentials, customUserAgent: `factory-ai/${process.env.FACTORY_VERSION ?? "dev"}` });
    this.model = model;
    this.tools = tools;
    this.maxSteps = maxSteps;
    this.maxOutputTokens = maxOutputTokens;
    this.onEvent = onEvent;
    this.compactAfterInputTokens = compactAfterInputTokens;
    this.compactMaxCharacters = compactMaxCharacters;
  }

  async run(prompt, { immutableContext = prompt } = {}) {
    const messages = [{ role: "user", content: [{ text: prompt }] }];
    const usage = { inputTokens: 0, outputTokens: 0 };
    const trace = [];
    for (let step = 0; step < this.maxSteps; step += 1) {
      this.onEvent({ type: "model.request.started", model: this.model, step: step + 1 });
      let response;
      try {
        response = await this.client.send(new ConverseCommand({
          modelId: this.model,
          messages,
          inferenceConfig: { maxTokens: this.maxOutputTokens },
          ...(Object.keys(this.tools).length ? { toolConfig: { tools: definitions(this.tools) } } : {}),
        }));
      } catch (error) {
        this.onEvent({ type: "model.request.failed", model: this.model, step: step + 1, error: String(error.message ?? error).slice(0, 500) });
        throw error;
      }
      this.onEvent({ type: "model.request.completed", model: this.model, step: step + 1, usage: response.usage });
      usage.inputTokens += response.usage?.inputTokens ?? 0;
      usage.outputTokens += response.usage?.outputTokens ?? 0;
      const message = response.output?.message;
      const calls = (message?.content ?? []).flatMap((item) => item.toolUse ? [item.toolUse] : []);
      if (calls.length === 0) {
        const text = (message?.content ?? []).flatMap((item) => typeof item.text === "string" ? [item.text] : []).join("\n");
        return { text, steps: step + 1, usage };
      }
      messages.push(message);
      const prepared = calls.map((call) => {
        const tool = this.tools[call.name];
        if (!tool) throw new Error(`Tool not allowed: ${call.name}`);
        return { call, tool };
      });
      const executeCall = async ({ call, tool }) => {
        let value;
        let status = "success";
        try {
          this.onEvent({ type: "tool.started", tool: call.name, step: step + 1 });
          value = await tool.execute(call.input ?? {});
          this.onEvent({ type: "tool.completed", tool: call.name, step: step + 1 });
        } catch (error) {
          value = `ERROR: ${String(error.message ?? error).slice(0, 4000)}`;
          status = "error";
          this.onEvent({ type: "tool.failed", tool: call.name, step: step + 1, error: String(error.message ?? error).slice(0, 500) });
        }
        trace.push({ tool: call.name, output: typeof value === "string" ? value : JSON.stringify(value), status });
        return { toolResult: { toolUseId: call.toolUseId, content: [{ text: typeof value === "string" ? value : JSON.stringify(value) }], status } };
      };
      const results = prepared.every(({ tool }) => tool.parallelSafe === true)
        ? await Promise.all(prepared.map(executeCall))
        : await prepared.reduce(async (pending, item) => [...await pending, await executeCall(item)], Promise.resolve([]));
      messages.push({ role: "user", content: results });
      if (this.compactAfterInputTokens > 0 && (response.usage?.inputTokens ?? 0) >= this.compactAfterInputTokens) {
        messages.splice(0, messages.length, { role: "user", content: [{ text: compactCheckpoint(prompt, trace, { maxCharacters: this.compactMaxCharacters, immutableContext }) }] });
        this.onEvent({ type: "context.compacted", model: this.model, step: step + 1, inputTokens: response.usage?.inputTokens ?? 0 });
      }
    }
    throw new Error(`Agent exceeded step limit of ${this.maxSteps}`);
  }
}
