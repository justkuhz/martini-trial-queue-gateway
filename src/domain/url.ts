export type RequestUrls = {
  response_url: string;
  status_url: string;
  cancel_url: string;
};

export function buildRequestUrls(
  baseUrl: string,
  modelId: string,
  requestId: string,
): RequestUrls {
  const base = `${baseUrl}/v1/queue/${modelId}/requests/${requestId}`;
  return {
    response_url: `${base}/response`,
    status_url: `${base}/status`,
    cancel_url: `${base}/cancel`,
  };
}
