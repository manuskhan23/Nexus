import { create } from 'zustand';

export type ProviderId = 'gemini' | 'groq';
export type ProviderMode = 'automatic' | 'gemini_only' | 'groq_only';

export interface AuthUser {
  id: string;
  fullName: string;
  email: string;
  isEmailVerified: boolean;
  preferences: {
    theme: 'light' | 'dark' | 'system';
    defaultProviderMode: ProviderMode;
    preferredProvider: ProviderId;
    autoExecuteLowRisk: boolean;
    requireApprovalForModerate: boolean;
    autoLearnFromErrors?: boolean;
  };
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  isBootstrapping: boolean;
  setSession: (user: AuthUser, accessToken: string, refreshToken?: string) => void;
  setUser: (user: AuthUser) => void;
  clearSession: () => void;
}

const TOKEN_KEY = 'nexus-access-token';
const REFRESH_KEY = 'nexus-refresh-token';

export function getStoredAccessToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredRefreshToken(): string | null {
  try {
    return sessionStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  accessToken: getStoredAccessToken(),
  isBootstrapping: true,
  setSession: (user, accessToken, refreshToken) => {
    try {
      sessionStorage.setItem(TOKEN_KEY, accessToken);
      if (refreshToken) {
        sessionStorage.setItem(REFRESH_KEY, refreshToken);
      }
    } catch {
      // Ignore storage errors
    }
    set({ user, accessToken, isBootstrapping: false });
  },
  setUser: (user) => set({ user }),
  clearSession: () => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(REFRESH_KEY);
    } catch {
      // Ignore storage errors
    }
    set({ user: null, accessToken: null, isBootstrapping: false });
  },
}));
