import { useSyncExternalStore } from "react";

export interface SessionUser {
  id: number;
  email: string;
  displayName: string;
  role: string | null;
  scopes: string[];
}

export interface Session {
  token: string;
  user: SessionUser;
}

const KEY = "assistant.session";
const listeners = new Set<() => void>();
let current: Session | null = read();

/**
 * Reads the stored session, dropping one that cannot be read
 *
 * @return  The session, or null
 */
function read(): Session | null {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Session | null;
    return stored?.token && stored.user ? stored : null;
  } catch {
    return null;
  }
}

/**
 * Stores the session, or forgets it with null, and tells every listener
 *
 * @param   session  New session
 */
export function setSession(session: Session | null): void {
  current = session;
  if (session) {
    localStorage.setItem(KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(KEY);
  }
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Replaces only the token, as the server renews it while the session is in use
 *
 * @param   token  Renewed token
 */
export function renewToken(token: string): void {
  if (current) {
    setSession({ ...current, token });
  }
}

/**
 * Reads the current session outside React
 *
 * @return  The session, or null
 */
export function getSession(): Session | null {
  return current;
}

/**
 * Follows the session from a component
 *
 * @return  The session, or null
 */
export function useSession(): Session | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/**
 * Tells whether the person may do something
 *
 * @param   session  Session
 * @param   scope    Permission
 *
 * @return  Whether the session holds it
 */
export function can(session: Session | null, scope: string): boolean {
  return session?.user.scopes.includes(scope) ?? false;
}
