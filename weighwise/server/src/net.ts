import fs from 'node:fs';
import tls from 'node:tls';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/**
 * Node's built-in fetch ignores HTTP(S)_PROXY. When a proxy is configured (corporate network),
 * route outbound calls (e.g. the AI provider) through it, honouring NO_PROXY.
 *
 * TLS stays fully verified. If the proxy inspects TLS, point EXTRA_CA_FILE at a PEM with its CA;
 * it is added on top of Node's built-in roots (never replaces them, never disables verification).
 */
export function configureOutboundProxy() {
  const proxied = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  const caFile = process.env.EXTRA_CA_FILE;
  if (!proxied && !caFile) return;
  const ca = caFile ? [...tls.rootCertificates, fs.readFileSync(caFile, 'utf8')] : undefined;
  // "requestTls" (TLS inside the proxy tunnel) is forwarded to ProxyAgent at runtime but is missing from the Options type.
  const opts = ca ? ({ connect: { ca }, requestTls: { ca } } as EnvHttpProxyAgent.Options) : {};
  setGlobalDispatcher(new EnvHttpProxyAgent(opts));
}
