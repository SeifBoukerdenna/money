import { config } from '../config.js';

export type LatencyProfile = 'NORMAL' | 'TURBO';

let _profile: LatencyProfile = config.LATENCY_TURBO_MODE ? 'TURBO' : 'NORMAL';
let _updatedAt = new Date().toISOString();

export function getLatencyProfileState(): {
  profile: LatencyProfile;
  turboEnabled: boolean;
  updatedAt: string;
} {
  return {
    profile: _profile,
    turboEnabled: _profile === 'TURBO',
    updatedAt: _updatedAt,
  };
}

export function setLatencyProfile(profile: LatencyProfile): {
  profile: LatencyProfile;
  turboEnabled: boolean;
  updatedAt: string;
} {
  _profile = profile;
  _updatedAt = new Date().toISOString();
  return getLatencyProfileState();
}

export function isTurboModeEnabled(): boolean {
  return _profile === 'TURBO';
}
