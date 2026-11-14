import type { ProviderResolver } from './sync/engine.ts';
import { FixtureProvider } from './sync/fixture-provider.ts';
import { PlaidProvider, resolveSecretRef } from './sync/plaid-provider.ts';

const fixture = new FixtureProvider();

export const defaultProviders: ProviderResolver = (profile) => {
  if (profile.environment === 'fixture') return fixture;
  if (profile.environment === 'sandbox') return plaidFor(profile);
  throw new Error('Production profiles are not enabled in this release');
};

export function plaidFor(profile: {
  environment: string;
  clientId: string | null;
  secretRef: string | null;
}) {
  if (profile.environment !== 'sandbox' || !profile.clientId || !profile.secretRef) {
    throw new Error('Only Sandbox profiles with credentials are supported');
  }
  return new PlaidProvider({
    environment: 'sandbox',
    clientId: profile.clientId,
    secret: resolveSecretRef(profile.secretRef),
  });
}
