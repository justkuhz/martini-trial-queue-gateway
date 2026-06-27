import { ModelExecutionError } from "../../domain";

export async function sleepWithSignal(
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new ModelExecutionError("Model execution timed out.", "timeout");
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      reject(new ModelExecutionError("Model execution timed out.", "timeout"));
    };

    signal.addEventListener("abort", onAbort);
  });
}
