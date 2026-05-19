let streamProxyToken = "";

export function setStreamProxyToken(token: string): void {
  streamProxyToken = String(token ?? "").trim();
}

export function getStreamProxyToken(): string {
  return streamProxyToken;
}
