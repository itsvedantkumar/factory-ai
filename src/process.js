import { spawn } from "node:child_process";

export function run(command, args, options = {}) {
  const { cwd, env, inheritEnv = true, timeoutMs = 300_000, input, allowExitCodes = [0], maxOutputBytes = 10_000_000, onStdout, onStderr } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: inheritEnv ? { ...process.env, ...env } : env,
      stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputExceeded = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, timeoutMs).unref();
    function appendOutput(stream, chunk) {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > maxOutputBytes) {
        outputExceeded = true;
        child.kill("SIGTERM");
        return;
      }
      if (stream === "stdout") stdout += chunk;
      else stderr += chunk;
    }
    child.stdout.on("data", (chunk) => { appendOutput("stdout", chunk); onStdout?.(chunk); });
    child.stderr.on("data", (chunk) => { appendOutput("stderr", chunk); onStderr?.(chunk); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      if (outputExceeded) return reject(new Error(`${command} exceeded ${maxOutputBytes} output bytes`));
      if (!allowExitCodes.includes(code)) {
        const detail = stderr.slice(-4000).replaceAll(/(token|key|secret)=\S+/gi, "$1=[REDACTED]");
        return reject(new Error(`${command} exited ${code ?? signal}: ${detail}`));
      }
      resolve({ code, stdout, stderr });
    });
    if (input) child.stdin.end(input);
  });
}
