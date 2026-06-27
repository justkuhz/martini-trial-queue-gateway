import { requestQueue } from "./enqueue";

export async function getQueuePosition(requestId: string): Promise<number> {
  const queuedJobs = await requestQueue.getJobs(
    ["prioritized", "waiting"],
    0,
    -1,
    true,
  );
  const index = queuedJobs.findIndex((job) => job.id === requestId);
  if (index === -1) {
    return 0;
  }

  return index;
}

