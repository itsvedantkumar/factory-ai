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
    retries = 4,
    timeoutMs = 180_000,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }) {
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/responses`;
    this.apiKey = apiKey;
    this.model = model;
    this.tools = tools;
    this.fetch = fetch;
    this.maxSteps = maxSteps;
    this.retries = retries;
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
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
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (response.ok) return payload;
        if (!TRANSIENT_STATUS.has(response.status) || attempt === this.retries) {
          throw new Error(`Azure Responses HTTP ${response.status}: ${payload.error?.code ?? "request_failed"}`);
        }
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

  async run(prompt) {
    let input = prompt;
    let previousResponseId;
    const definitions = toolDefinitions(this.tools);
    for (let step = 0; step < this.maxSteps; step += 1) {
      const response = await this.request({
        model: this.model,
        input,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        tools: definitions,
      });
      const calls = (response.output ?? []).filter((item) => item.type === "function_call");
      if (calls.length === 0) return { text: outputText(response), responseId: response.id, steps: step + 1 };
      const outputs = [];
      for (const call of calls) {
        const tool = this.tools[call.name];
        if (!tool) throw new Error(`Tool not allowed: ${call.name}`);
        let argumentsValue;
        try {
          argumentsValue = JSON.parse(call.arguments || "{}");
        } catch {
          throw new Error(`Invalid arguments for tool: ${call.name}`);
        }
        let value;
        try {
          value = await tool.execute(argumentsValue);
        } catch (error) {
          value = `ERROR: ${String(error.message ?? error).slice(0, 4000)}`;
        }
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: typeof value === "string" ? value : JSON.stringify(value),
        });
      }
      previousResponseId = response.id;
      input = outputs;
    }
    throw new Error(`Agent exceeded step limit of ${this.maxSteps}`);
  }
}
