/**
 * Billing API Service
 * 
 * Handles communication with the backend billing/payment services.
 * Backend endpoints are at: BACKGROUND_BASE_URL/api/v1/cloud/billing/*
 */

import { getBackendApiBase } from './backend-api';

// Types
export interface PaymentMethodResponse {
  id: string;
  type: 'card' | 'alipay';
  brand?: string;
  last4?: string;
  exp_month?: number;
  exp_year?: number;
  email?: string;
  default: boolean;
}

export interface AlipaySetupResponse {
  setup_intent_id: string;
  redirect_url: string;
  client_secret: string;
}

export interface ConfirmAlipayResponse {
  id: string;
  type: 'alipay';
  email?: string;
  default: boolean;
}

export interface Invoice {
  id: string;
  number: string;
  date: string;
  amount: number;
  currency: string;
  status: 'paid' | 'pending' | 'overdue' | 'void';
  pdf_url?: string;
}

// Error types
export class BillingApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string
  ) {
    super(message);
    this.name = 'BillingApiError';
  }
}

/**
 * Get auth headers from localStorage
 */
function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('prismer_auth');
      if (stored) {
        const authData = JSON.parse(stored);
        if (authData.token) {
          headers['Authorization'] = `Bearer ${authData.token}`;
        }
      }
    }
  } catch (error) {
    console.error('[BillingAPI] Failed to get auth token', error);
  }
  return headers;
}

/**
 * Billing API Service
 */
export const billingApi = {
  /**
   * Get all payment methods for the current user
   */
  async getPaymentMethods(): Promise<PaymentMethodResponse[]> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/cloud/billing/payment-methods`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to fetch payment methods',
        res.status,
        data.error?.code
      );
    }

    return data.data || [];
  },

  /**
   * Add a card payment method
   * Returns a Stripe SetupIntent client_secret for frontend confirmation
   */
  async addCardPaymentMethod(): Promise<{ client_secret: string; setup_intent_id: string }> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/cloud/billing/payment-methods`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ type: 'card' }),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to create card setup intent',
        res.status,
        data.error?.code
      );
    }

    return data.data;
  },

  /**
   * Add an Alipay payment method
   * Returns a redirect URL for Alipay authorization
   */
  async addAlipayPaymentMethod(returnUrl: string): Promise<AlipaySetupResponse> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/cloud/billing/payment-methods`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ 
        type: 'alipay',
        return_url: returnUrl
      }),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to create Alipay setup intent',
        res.status,
        data.error?.code
      );
    }

    return data.data;
  },

  /**
   * Confirm Alipay authorization after redirect
   */
  async confirmAlipay(setupIntentId: string): Promise<ConfirmAlipayResponse> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/cloud/billing/payment-methods/confirm-alipay`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ setup_intent_id: setupIntentId }),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to confirm Alipay authorization',
        res.status,
        data.error?.code
      );
    }

    return data.data;
  },

  /**
   * Set a payment method as default
   */
  async setDefaultPaymentMethod(paymentMethodId: string): Promise<void> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/cloud/billing/payment-methods/${paymentMethodId}`, {
      method: 'PATCH',
      headers: getAuthHeaders(),
      body: JSON.stringify({ default: true }),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to set default payment method',
        res.status,
        data.error?.code
      );
    }
  },

  /**
   * Remove a payment method
   */
  async removePaymentMethod(paymentMethodId: string): Promise<void> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/cloud/billing/payment-methods/${paymentMethodId}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to remove payment method',
        res.status,
        data.error?.code
      );
    }
  },

  /**
   * Get invoices for the current user
   */
  async getInvoices(): Promise<Invoice[]> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/cloud/billing/invoices`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to fetch invoices',
        res.status,
        data.error?.code
      );
    }

    return data.data || [];
  },

  /**
   * Create a top-up payment
   */
  async createTopup(amount: number, credits: number, paymentMethodId: string): Promise<{
    payment_intent_id: string;
    client_secret: string;
    status: string;
  }> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/payment/topup/create`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        amount,
        credits,
        payment_method_id: paymentMethodId,
      }),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to create top-up',
        res.status,
        data.error?.code
      );
    }

    return data.data;
  },

  /**
   * Create a subscription
   */
  async createSubscription(priceId: string, paymentMethodId: string): Promise<{
    subscription_id: string;
    client_secret?: string;
    status: string;
  }> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/subscription/create`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        price_id: priceId,
        payment_method_id: paymentMethodId,
      }),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to create subscription',
        res.status,
        data.error?.code
      );
    }

    return data.data;
  },

  /**
   * Purchase a package
   */
  async purchasePackage(packageId: string, paymentMethodId: string): Promise<{
    session_id: string;
    checkout_url: string;
  }> {
    const baseUrl = await getBackendApiBase();
    const res = await fetch(`${baseUrl}/payment/package/purchase`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({
        package_id: packageId,
        payment_method_id: paymentMethodId,
      }),
    });

    const data = await res.json();
    
    if (!res.ok || !data.success) {
      throw new BillingApiError(
        data.message || 'Failed to purchase package',
        res.status,
        data.error?.code
      );
    }

    return data.data;
  },
};
