// ===== View/Route Types =====
export type ViewState = 'landing' | 'playground' | 'dashboard' | 'docs' | 'auth';

// ===== Task/Processing Types =====
export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  status: 'info' | 'success' | 'process' | 'error';
}

// Single source result from Exa search
export interface SourceResult {
  id: string;
  title: string;
  url: string;
  hqcc: string;
  raw: string;
  imageLinks?: string[];
  cached?: boolean; // True if this source was retrieved from Context Server cache
}

export interface TaskResult {
  hqcc: string;
  raw: string;
  json: object;
  // Multi-source support
  sources?: SourceResult[];
  activeSourceIndex?: number;
  // Input type indicator: 'url' for direct URL, 'query' for search query
  inputType?: 'url' | 'query';
}

export enum Strategy {
  AUTO = 'Auto-Detect',
  TECHNICAL = 'Technical Content',
  FINANCE = 'Finance Report',
  ACADEMIC = 'Academic Paper',
  LEGAL = 'Legal Contract'
}

export interface Activity {
  id: string;
  url: string;
  strategy: string;
  status: 'Completed' | 'Processing' | 'Failed';
  cost: string;
  time: string;
}

// ===== Dashboard Types =====
export interface Invoice {
  id: string;
  date: string;
  amount: string;
  status: 'Paid' | 'Pending' | 'Overdue' | string;
  pdfUrl?: string | null;
  credits?: number;
}

export interface ChartData {
  name: string;
  requests: number;
}

export interface ApiKeyData {
  id: string;
  key: string;
  label: string;
  created: string;
  status: 'ACTIVE' | 'REVOKED';
}

export interface PaymentMethod {
  id: string;
  type: 'card' | 'alipay';
  brand?: string;
  last4?: string;
  exp?: string;
  email?: string;
  default: boolean;
}

export interface DashboardStats {
  monthlyRequests: number;
  cacheHitRate: number;
  creditsRemaining: number;
}

// ===== Toast Types =====
export interface ToastMessage {
  id: number;
  type: 'success' | 'error' | 'info';
  message: string;
}

// ===== Notification Types =====
export interface Notification {
  id: string;
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message: string;
  time: string;
  read: boolean;
  referenceType?: string;
  referenceId?: string;
}