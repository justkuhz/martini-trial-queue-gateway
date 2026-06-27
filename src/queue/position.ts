import { requestQueue } from "./enqueue";

export async function getQueuePosition(_requestId: string): Promise<number> {
  const counts = await requestQueue.getJobCounts("waiting", "prioritized");
  return (counts.waiting ?? 0) + (counts.prioritized ?? 0);
}

