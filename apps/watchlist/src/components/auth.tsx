export interface AuthContext {
  isAuthenticated: boolean;
  login: (username: string) => Promise<void>;
  logout: () => Promise<void>;
  user: string | null;
}
