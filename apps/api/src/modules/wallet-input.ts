import { z } from 'zod';

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const profileHandleSchema = z.string().regex(/^[a-zA-Z0-9._-]{2,64}$/);
const gammaSearchBaseUrl = 'https://gamma-api.polymarket.com/public-search';

export function shortenAddress(address: string): string {
  if (address.length < 12) {
    return address;
  }
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  if (addressSchema.safeParse(trimmed).success) {
    return trimmed.toLowerCase();
  }
  return trimmed;
}

function parseProfilePath(pathname: string): string | null {
  const match = pathname.match(/\/profile\/(.+)$/i);
  if (!match?.[1]) {
    return null;
  }
  const decoded = decodeURIComponent(match[1]).trim();
  const withoutAt = decoded.startsWith('@') ? decoded.slice(1) : decoded;
  return withoutAt || null;
}

export async function resolveWalletAddress(input: string): Promise<string> {
  const normalized = normalizeAddress(input);
  if (addressSchema.safeParse(normalized).success) {
    return normalized;
  }

  try {
    const url = new URL(normalized);
    const candidateFromPath = parseProfilePath(url.pathname);
    if (candidateFromPath) {
      const candidate = normalizeAddress(candidateFromPath);
      if (addressSchema.safeParse(candidate).success) {
        return candidate;
      }
      if (profileHandleSchema.safeParse(candidate).success) {
        const resolvedAddress = await resolveHandleToWalletAddress(candidate);
        if (resolvedAddress) {
          return resolvedAddress;
        }
        throw new Error('Could not resolve Polymarket profile to a wallet address. Try a full 0x wallet address.');
      }
    }
  } catch {
    // not a URL, continue
  }

  const withoutAt = normalized.startsWith('@') ? normalized.slice(1) : normalized;
  if (profileHandleSchema.safeParse(withoutAt).success) {
    const resolvedAddress = await resolveHandleToWalletAddress(withoutAt);
    if (resolvedAddress) {
      return resolvedAddress;
    }
    throw new Error('Could not resolve Polymarket profile to a wallet address. Try a full 0x wallet address.');
  }

  throw new Error('Enter a valid Polymarket profile URL or 0x wallet address');
}

async function resolveHandleToWalletAddress(handle: string): Promise<string | null> {
  const normalizedHandle = handle.trim().replace(/^@/, '');
  const queryUrl = `${gammaSearchBaseUrl}?q=${encodeURIComponent(normalizedHandle)}&search_profiles=true&limit_per_type=10`;
  const response = await fetch(queryUrl, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const rawProfiles =
    (Array.isArray(payload.profiles) ? payload.profiles : null) ??
    (Array.isArray(payload.data) ? payload.data : null) ??
    [];

  const profiles = rawProfiles.filter(
    (item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object',
  );

  const exactMatch = profiles.find((profile) => {
    const names = [
      profile.username,
      profile.name,
      profile.pseudonym,
      profile.displayUsernamePublic,
      profile.handle,
    ]
      .map((value) => String(value ?? '').trim().replace(/^@/, '').toLowerCase())
      .filter(Boolean);
    return names.includes(normalizedHandle.toLowerCase());
  });

  const candidate = exactMatch ?? profiles[0];
  const wallet = String(
    candidate?.proxyWallet ?? candidate?.wallet ?? candidate?.address ?? '',
  )
    .trim()
    .toLowerCase();

  return addressSchema.safeParse(wallet).success ? wallet : null;
}
