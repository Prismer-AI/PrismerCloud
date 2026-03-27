'use client';

import React, { useState, useEffect } from 'react';
import { loadStripe, Stripe } from '@stripe/stripe-js';
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { X, CreditCard, Loader2 } from 'lucide-react';

interface StripeCardModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (paymentMethodId: string) => void;
}

// Card Element styling
const CARD_ELEMENT_OPTIONS = {
  style: {
    base: {
      fontSize: '16px',
      color: '#424770',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      '::placeholder': {
        color: '#aab7c4',
      },
      iconColor: '#666EE8',
    },
    invalid: {
      color: '#fa755a',
      iconColor: '#fa755a',
    },
  },
  hidePostalCode: true,
};

// Inner form component (must be inside Elements)
function CardForm({ onClose, onSuccess }: { onClose: () => void; onSuccess: (id: string) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [cardComplete, setCardComplete] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!stripe || !elements) {
      return;
    }

    const cardElement = elements.getElement(CardElement);
    if (!cardElement) {
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      // Create PaymentMethod directly
      const { error: stripeError, paymentMethod } = await stripe.createPaymentMethod({
        type: 'card',
        card: cardElement,
      });

      if (stripeError) {
        setError(stripeError.message || 'Failed to process card');
        setProcessing(false);
        return;
      }

      if (paymentMethod) {
        onSuccess(paymentMethod.id);
      }
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred');
      setProcessing(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Card Input */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          Card Information
        </label>
        <div className="p-4 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800">
          <CardElement
            options={CARD_ELEMENT_OPTIONS}
            onChange={(e) => {
              setCardComplete(e.complete);
              if (e.error) {
                setError(e.error.message);
              } else {
                setError(null);
              }
            }}
          />
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          disabled={processing}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!stripe || !cardComplete || processing}
          className="flex-1 px-4 py-2.5 text-sm font-medium text-white bg-gradient-to-r from-blue-500 to-purple-600 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {processing ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Processing...
            </>
          ) : (
            <>
              <CreditCard className="w-4 h-4" />
              Add Card
            </>
          )}
        </button>
      </div>

      {/* Security Note */}
      <p className="text-xs text-center text-gray-500 dark:text-gray-400">
        🔒 Your card information is securely processed by Stripe
      </p>
    </form>
  );
}

// Main Modal Component
export function StripeCardModal({ isOpen, onClose, onSuccess }: StripeCardModalProps) {
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && !stripePromise) {
      // Fetch Stripe publishable key and initialize
      fetch('/api/config/stripe')
        .then((res) => res.json())
        .then((data) => {
          if (data.success && data.data?.publishable_key) {
            setStripePromise(loadStripe(data.data.publishable_key));
            setError(null);
          } else {
            setError('Stripe is not configured');
          }
        })
        .catch(() => {
          setError('Failed to load Stripe configuration');
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [isOpen, stripePromise]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 bg-white dark:bg-gray-800 rounded-2xl shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-r from-blue-500 to-purple-600 flex items-center justify-center">
              <CreditCard className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                Add Credit Card
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                Enter your card details below
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
            </div>
          ) : error ? (
            <div className="text-center py-8">
              <p className="text-red-500 dark:text-red-400">{error}</p>
              <button
                onClick={onClose}
                className="mt-4 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200"
              >
                Close
              </button>
            </div>
          ) : stripePromise ? (
            <Elements stripe={stripePromise}>
              <CardForm onClose={onClose} onSuccess={onSuccess} />
            </Elements>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default StripeCardModal;
