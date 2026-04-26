'use client';

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { Activity, ToastMessage, ApiKeyData } from '@/types';
import { api } from '@/lib/api';

// Constants for localStorage keys
const AUTH_STORAGE_KEY = 'prismer_auth';
const ACTIVE_API_KEY_STORAGE_KEY = 'prismer_active_api_key';

interface User {
  id: number;
  email: string;
  avatar: string;
  is_active: boolean;
  email_verified: boolean;
  last_login_at: string;
  google_id: string;
  github_id: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface AppContextType {
  // Auth State
  isAuthenticated: boolean;
  isAuthLoading: boolean;
  user: User | null;
  token: string | null;
  login: (user: User, token: string) => void;
  logout: () => void;

  // Activities
  activities: Activity[];
  addActivity: (activity: Activity) => void;

  // Active API Key
  activeApiKey: ApiKeyData | null;
  setActiveApiKey: (key: ApiKeyData | null) => void;

  // Toast System
  toasts: ToastMessage[];
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  removeToast: (id: number) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function AppProvider({ children }: { children: React.ReactNode }) {
  // Auth State - start with loading state to prevent flash
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Activities State
  const [activities, setActivities] = useState<Activity[]>([]);

  // Active API Key State
  const [activeApiKey, setActiveApiKeyState] = useState<ApiKeyData | null>(null);

  // Toast State
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // Restore auth state from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(AUTH_STORAGE_KEY);
      if (stored) {
        const authData = JSON.parse(stored);
        // Check if the auth token is still valid (e.g., not expired)
        if (authData.token && authData.user && authData.expiresAt > Date.now()) {
          setIsAuthenticated(true);
          setUser(authData.user);
          setToken(authData.token);
        } else {
          // Clear expired auth data
          localStorage.removeItem(AUTH_STORAGE_KEY);
        }
      }
    } catch (error) {
      console.error('Failed to restore auth state', error);
      localStorage.removeItem(AUTH_STORAGE_KEY);
    } finally {
      setIsAuthLoading(false);
    }
  }, []);

  // Restore active API key from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(ACTIVE_API_KEY_STORAGE_KEY);
      if (stored) {
        const keyData = JSON.parse(stored) as ApiKeyData;
        if (keyData.status === 'ACTIVE') {
          setActiveApiKeyState(keyData);
        } else {
          localStorage.removeItem(ACTIVE_API_KEY_STORAGE_KEY);
        }
      }
    } catch (error) {
      console.error('Failed to restore active API key', error);
      localStorage.removeItem(ACTIVE_API_KEY_STORAGE_KEY);
    }
  }, []);

  // Load initial activities (only when authenticated via JWT or API key)
  useEffect(() => {
    // Wait for auth loading to complete
    if (isAuthLoading) {
      return;
    }
    
    // Check if authenticated via JWT or has active API key
    const hasAuth = isAuthenticated || activeApiKey !== null;
    if (!hasAuth) {
      return;
    }

    const loadActivities = async () => {
      try {
        const data = await api.getActivities();
        setActivities(data);
      } catch (error) {
        console.error('Failed to fetch activities', error);
      }
    };
    loadActivities();
  }, [isAuthLoading, isAuthenticated, activeApiKey]);

  // Auth Handlers with persistence
  const login = useCallback((userData: User, authToken: string) => {
    setIsAuthenticated(true);
    setUser(userData);
    setToken(authToken);
    // Store auth state with expiration (24 hours)
    const authData = {
      isAuthenticated: true,
      user: userData,
      token: authToken,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      loginAt: Date.now(),
    };
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authData));
  }, []);

  const logout = useCallback(() => {
    setIsAuthenticated(false);
    setUser(null);
    setToken(null);
    setActiveApiKeyState(null); // Clear API key on logout
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(ACTIVE_API_KEY_STORAGE_KEY); // Clear stored API key
  }, []);

  // Activity Handler
  const addActivity = useCallback((activity: Activity) => {
    setActivities(prev => [activity, ...prev]);
  }, []);

  // Active API Key Handler
  const setActiveApiKey = useCallback((key: ApiKeyData | null) => {
    setActiveApiKeyState(key);
    if (key) {
      localStorage.setItem(ACTIVE_API_KEY_STORAGE_KEY, JSON.stringify(key));
    } else {
      localStorage.removeItem(ACTIVE_API_KEY_STORAGE_KEY);
    }
  }, []);

  // Toast Handlers
  const addToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, type, message }]);
    
    // Auto-remove after 4 seconds
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  return (
    <AppContext.Provider
      value={{
        isAuthenticated,
        isAuthLoading,
        user,
        token,
        login,
        logout,
        activities,
        addActivity,
        activeApiKey,
        setActiveApiKey,
        toasts,
        addToast,
        removeToast,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
}

