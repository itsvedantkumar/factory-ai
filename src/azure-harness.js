import { compactCheckpoint } from "./context-compaction.js";

const TRANSIENT_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function outputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  return (response.output ?? [])
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("\n");
}

function toolDefinitions(tools) {
  return Object.entries(tools).map(([name, tool]) => ({
    type: "function",
    name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export class AzureResponsesHarness {
  constructor({
    baseUrl,
    apiKey,
    model,
    tools,
    fetch = globalThis.fetch,
    maxSteps = 40,
    maxOutputTokens = 4096,
    retries = 4,
    timeoutMs = 180_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    userAgent = `factory-ai/${process.env.FACTORY_VERSION ?? "dev"}`,
    onEvent = () => {},
    compactAfterInputTokens = 80_000,
    compactMaxCharacters = 24_000,
  }) {
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/responses`;
    this.apiKey = apiKey;
    this.model = model;
    this.tools = tools;
    this.fetch = fetch;
    this.maxSteps = maxSteps;
    this.maxOutputTokens = maxOutputTokens;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
    this.userAgent = userAgent;
    this.onEvent = onEvent;
    this.compactAfterInputTokens = compactAfterInputTokens;
    this.compactMaxCharacters = compactMaxCharacters;
  }

  async request(body) {
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      timer.unref?.();
      try {
        const response = await this.fetch(this.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "api-key": this.apiKey,
            authorization: `Bearer ${this.apiKey}`,
            "user-agent": this.userAgent,
            "x-ms-useragent": this.userAgent,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) return payload;
        if (!TRANSIENT_STATUS.has(response.status) || attempt === this.retries) {
          throw new Error(`Azure Responses HTTP ${response.status}: ${payload.error?.code ?? "request_failed"}`);
        }
        this.onEvent({ type: "model.retry", model: this.model, attempt: attempt + 1, status: response.status });
      } catch (error) {
        const transientNetworkError = error.name === "AbortError" || error instanceof TypeError;
        if (!transientNetworkError || attempt === this.retries) throw error;
      } finally {
        clearTimeout(timer);
      }
      const delay = Math.min(10_000, 500 * (2 ** attempt)) + Math.floor(Math.random() * 250);
      await this.sleep(delay);
    }
    throw new Error("Azure Responses retry loop exhausted");
  }

  async run(prompt, { immutableContext = prompt } = {}) {
    let input = prompt;
    let previousResponseId;
    const definitions = toolDefinitions(this.tools);
    const usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
    const trace = [];
    for (let step = 0; step < this.maxSteps; step += 1) {
      this.onEvent({ type: "model.request.started", model: this.model, step: step + 1 });
      let response;
      try {
        response = await this.request({
          model: this.model,
          input,
          ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
          tools: definitions,
          max_output_tokens: this.maxOutputTokens,
        });
      } catch (error) {
        this.onEvent({ type: "model.request.failed", model: this.model, step: step + 1, error: String(error.message ?? error).slice(0, 500) });
        throw error;
      }
      this.onEvent({ type: "model.request.completed", model: this.model, step: step + 1, usage: response.usage });
      usage.inputTokens += response.usage?.input_tokens ?? 0;
      usage.cachedInputTokens += response.usage?.input_tokens_details?.cached_tokens ?? 0;
      usage.outputTokens += response.usage?.output_tokens ?? 0;
      const calls = (response.output ?? []).filter((item) => item.type === "function_call");
      if (calls.length === 0) return { text: outputText(response), responseId: response.id, steps: step + 1, usage };
      const prepared = calls.map((call) => {
        const tool = this.tools[call.name];
        if (!tool) throw new Error(`Tool not allowed: ${call.name}`);
        let argumentsValue;
        try {
          argumentsValue = JSON.parse(call.arguments || "{}");
        } catch {
          throw new Error(`Invalid arguments for tool: ${call.name}`);
        }
        return { call, tool, argumentsValue };
      });
      const executeCall = async ({ call, tool, argumentsValue }) => {
        let value;
        try {
          this.onEvent({ type: "tool.started", tool: call.name, step: step + 1 });
          value = await tool.execute(argumentsValue);
          this.onEvent({ type: "tool.completed", tool: call.name, step: step + 1 });
        } catch (error) {
          this.onEvent({ type: "tool.failed", tool: call.name, step: step + 1, error: String(error.message ?? error).slice(0, 500) });
          value = `ERROR: ${String(error.message ?? error).slice(0, 4000)}`;
        }
        trace.push({ tool: call.name, output: typeof value === "string" ? value : JSON.stringify(value), status: String(value).startsWith("ERROR:") ? "error" : "success" });
        return {
          type: "function_call_output",
          call_id: call.call_id,
          output: typeof value === "string" ? value : JSON.stringify(value),
        };
      };
      const outputs = prepared.every(({ tool }) => tool.parallelSafe === true)
        ? await Promise.all(prepared.map(executeCall))
        : await prepared.reduce(async (pending, item) => [...await pending, await executeCall(item)], Promise.resolve([]));
      if (this.compactAfterInputTokens > 0 && (response.usage?.input_tokens ?? 0) >= this.compactAfterInputTokens) {
        previousResponseId = undefined;
        input = compactCheckpoint(prompt, trace, { maxCharacters: this.compactMaxCharacters, immutableContext });
        this.onEvent({ type: "context.compacted", model: this.model, step: step + 1, inputTokens: response.usage?.input_tokens ?? 0 });
      } else {
        previousResponseId = response.id;
        input = outputs;
      }
    }
    throw new Error(`Agent exceeded step limit of ${this.maxSteps}`);
  }
}
