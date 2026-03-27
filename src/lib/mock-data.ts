import { Activity, ApiKeyData, ChartData, Invoice, Notification, PaymentMethod, TaskResult } from '@/types';

// ===== Activities =====
export const MOCK_ACTIVITIES: Activity[] = [
  { id: '1', url: 'https://arxiv.org/pdf/2301.00001.pdf', strategy: 'Academic Paper', status: 'Completed', cost: '0.012', time: '2 mins ago' },
  { id: '2', url: 'https://nvidia.com/investors/FY24-Q3.pdf', strategy: 'Finance Report', status: 'Completed', cost: '0.024', time: '15 mins ago' },
  { id: '3', url: 'https://sec.gov/Archives/tsla-10k.htm', strategy: 'Legal Contract', status: 'Completed', cost: '0.018', time: '1 hour ago' },
  { id: '4', url: 'https://nature.com/articles/s41586-024-07487-w', strategy: 'Academic Paper', status: 'Failed', cost: '0.000', time: '3 hours ago' },
  { id: '5', url: 'https://openai.com/blog/gpt-4-system-card.pdf', strategy: 'Auto-Detect', status: 'Completed', cost: '0.031', time: 'Yesterday' },
];

// ===== API Keys =====
export const MOCK_API_KEYS: ApiKeyData[] = [
  { id: 'key1', key: 'sk-prismer-live-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', label: 'Production Key', created: 'Dec 1, 2024', status: 'ACTIVE' },
  { id: 'key2', key: 'sk-prismer-test-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy', label: 'Development Key', created: 'Nov 15, 2024', status: 'ACTIVE' },
  { id: 'key3', key: 'sk-prismer-old-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', label: 'Legacy Key', created: 'Oct 1, 2024', status: 'REVOKED' },
];

// ===== Chart Data =====
export const MOCK_CHART_DATA: ChartData[] = [
  { name: 'Mon', requests: 32000 },
  { name: 'Tue', requests: 45000 },
  { name: 'Wed', requests: 38000 },
  { name: 'Thu', requests: 52000 },
  { name: 'Fri', requests: 41000 },
  { name: 'Sat', requests: 22000 },
  { name: 'Sun', requests: 18000 },
];

// ===== Invoices =====
export const MOCK_INVOICES: Invoice[] = [
  { id: 'inv1', date: 'Dec 1, 2024', amount: '$49.00', status: 'Paid' },
  { id: 'inv2', date: 'Nov 1, 2024', amount: '$49.00', status: 'Paid' },
  { id: 'inv3', date: 'Oct 1, 2024', amount: '$49.00', status: 'Paid' },
];

// ===== Payment Methods =====
export const MOCK_PAYMENT_METHODS: PaymentMethod[] = [
  { id: 'pm1', type: 'card', brand: 'visa', last4: '4242', exp: '12/2026', default: true },
  { id: 'pm2', type: 'alipay', email: 'dev***@prismer.io', default: false },
];

// ===== Notifications =====
export const MOCK_NOTIFICATIONS: Notification[] = [
  { 
    id: 'notif1', 
    type: 'success', 
    title: 'Extraction Complete', 
    message: 'Your document arxiv_2301.pdf has been successfully processed.',
    time: '2 mins ago',
    read: false
  },
  { 
    id: 'notif2', 
    type: 'info', 
    title: 'Credits Added', 
    message: 'Your purchase of 30,000 credits has been confirmed.',
    time: '1 hour ago',
    read: false
  },
  { 
    id: 'notif3', 
    type: 'warning', 
    title: 'Low Credits Alert', 
    message: 'You have less than 1,000 credits remaining. Consider purchasing more.',
    time: '3 hours ago',
    read: true
  },
  { 
    id: 'notif4', 
    type: 'error', 
    title: 'Processing Failed', 
    message: 'Failed to process nature.com/articles/s41586. The URL may be restricted.',
    time: 'Yesterday',
    read: true
  },
  { 
    id: 'notif5', 
    type: 'info', 
    title: 'New API Version', 
    message: 'Prismer API v2.0 is now available with improved extraction accuracy.',
    time: '2 days ago',
    read: true
  },
];

// ===== Task Result (for Playground) =====
export const MOCK_TASK_RESULT: TaskResult = {
  hqcc: `## Summary

This is a High-Quality Curated Context (HQCC) output from the Prismer extraction pipeline.

### Key Findings

* The document discusses advanced machine learning techniques for natural language understanding.
* A novel transformer architecture is proposed with improved attention mechanisms.
* Experimental results show a 15% improvement over baseline models on standard benchmarks.

### Extracted Metadata

| Field | Value |
|-------|-------|
| **Title** | Advances in Neural Language Processing |
| **Authors** | J. Smith, A. Chen, M. Williams |
| **Year** | 2024 |
| **DOI** | 10.1234/example.2024.001 |

### Main Contributions

The paper introduces three key innovations:

1. A sparse attention mechanism that reduces computational complexity from O(n²) to O(n log n).
2. A dynamic routing algorithm for multi-task learning scenarios.
3. A new pre-training objective that better captures semantic relationships.

### Conclusion

The proposed methods represent a significant advancement in the field and open new avenues for research in efficient large-scale language models.`,

  raw: `Advances in Neural Language Processing

Abstract

This paper presents a comprehensive study of modern neural language processing techniques. We propose a novel architecture that combines sparse attention mechanisms with dynamic routing algorithms to achieve state-of-the-art performance on multiple benchmarks.

1. Introduction

Natural language processing has seen remarkable progress in recent years, driven primarily by the advent of transformer-based models. However, these models suffer from quadratic complexity with respect to sequence length, limiting their applicability to long-form documents.

2. Methodology

Our approach introduces three key innovations:
- Sparse attention with locality-sensitive hashing
- Multi-task routing networks
- Contrastive pre-training objectives

3. Results

We evaluate our model on standard NLP benchmarks including GLUE, SuperGLUE, and SQuAD 2.0. Our model achieves:
- GLUE: 89.2 (avg)
- SuperGLUE: 87.5 (avg)
- SQuAD 2.0: 91.3 F1

4. Conclusion

We have presented a novel neural architecture that achieves competitive performance while maintaining computational efficiency. Future work will explore scaling to even larger models.

References
[1] Vaswani et al. (2017). Attention is All You Need.
[2] Devlin et al. (2019). BERT: Pre-training of Deep Bidirectional Transformers.`,

  json: {
    document_id: "doc_abc123xyz",
    source_url: "https://arxiv.org/pdf/2301.00001.pdf",
    extraction_timestamp: "2024-12-15T10:30:00Z",
    processing_time_ms: 1423,
    metadata: {
      title: "Advances in Neural Language Processing",
      authors: ["J. Smith", "A. Chen", "M. Williams"],
      year: 2024,
      doi: "10.1234/example.2024.001",
      page_count: 12,
      language: "en"
    },
    content_analysis: {
      word_count: 4532,
      has_tables: true,
      has_figures: true,
      figure_count: 4,
      table_count: 2,
      citation_count: 42
    },
    embeddings: {
      model: "prismer-embed-v2",
      dimensions: 1024,
      vector_preview: [0.023, -0.156, 0.891, 0.044, -0.332]
    },
    cost: {
      credits_used: 0.012,
      cache_hit: false
    }
  }
};

