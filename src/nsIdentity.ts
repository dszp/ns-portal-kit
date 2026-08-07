/**
 * The **service identity** for background NetSapiens work — the credential used when there is no caller.
 *
 * Every existing write path in this Worker runs under the caller's own `ns_t`, which bounds it twice: by
 * that user's scope and by the Ringotel write rail. A subscription event has no caller, so it needs a
 * stored credential — and that removes one of the two bounds. Treat this module as privileged:
 *
 * - It must be a **dedicated, least-privilege** NetSapiens key. NetSapiens supports restricting a key by
 *   `allowed-models`, `domain`, `ip-address`, and `readonly`; narrow everything the deployment can.
 * - ⚠️ It is deliberately **NOT** `NS_API_TOKEN`. That variable is the standalone/service *read* token for
 *   the internal tooling mode, a different credential with a different purpose. There is no fallback
 *   between them, on purpose — silently borrowing a read token for background writes is exactly the kind
 *   of privilege drift that is hard to notice later.
 *
 * Mirrors `ringotel-ns-sso`'s write identity so one config scheme covers both Workers: an API key, or
 * admin credentials exchanged for an OAuth access token. Admin wins when both are set.
 */
import { NsAuthClient } from '@dszp/netsapiens-lib';
import type { NsWriteIdentity } from './nsEvents.js';

export interface NsIdentityEnv {
  NS_SERVER: string;
  /** OAuth host, when it differs from NS_SERVER. */
  NS_OAUTH_SERVER?: string;
  NS_OAUTH_CLIENT_ID?: string;
  NS_OAUTH_CLIENT_SECRET?: string;
}

export class NsIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NsIdentityError';
  }
}

/**
 * Resolve the bearer token for the service identity.
 *
 * No caching: the SSO worker mints per invocation too, and the cron runs on a slow cadence, so a token
 * cache would add a stale-credential failure mode for no measurable gain. (A `TokenCache` on
 * `NsAuthClient`, mirroring the library's existing `VerdictCache`, is the place for this if it is ever
 * worth doing — not a Worker-local map.)
 */
export async function getServiceToken(identity: NsWriteIdentity, env: NsIdentityEnv): Promise<string> {
  if (identity.kind === 'api') return identity.token;

  const clientId = (env.NS_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = (env.NS_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) {
    throw new NsIdentityError('NS_ADMIN_USER/NS_ADMIN_PASS need NS_OAUTH_CLIENT_ID and NS_OAUTH_CLIENT_SECRET');
  }
  const auth = new NsAuthClient({
    server: (env.NS_OAUTH_SERVER ?? '').trim() || env.NS_SERVER,
    clientId,
    clientSecret,
  });
  const res = await auth.passwordGrant(identity.user, identity.pass);
  const token = (res.access_token ?? '').trim();
  if (!token) throw new NsIdentityError('NetSapiens returned no access_token for the service identity');
  return token;
}
