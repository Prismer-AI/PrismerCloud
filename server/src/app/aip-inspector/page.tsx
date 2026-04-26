'use client';

/**
 * AIP Inspector — Debug tool for AIP artifacts (similar to jwt.io).
 * Parses and displays DID Documents, Verifiable Credentials, Delegations, and Signatures.
 */

import { useState, useCallback } from 'react';

type ArtifactType = 'did-document' | 'verifiable-credential' | 'delegation' | 'signature' | 'unknown';

interface ParseResult {
  type: ArtifactType;
  valid: boolean;
  parsed: Record<string, any>;
  warnings: string[];
}

function detectType(obj: Record<string, any>): ArtifactType {
  if (obj.id?.startsWith('did:')) return 'did-document';
  if (obj.type?.includes('VerifiableCredential')) return 'verifiable-credential';
  if (obj.type?.includes('VerifiablePresentation')) return 'verifiable-credential';
  if (obj.type === 'delegation' || obj.type === 'ephemeral_delegation') return 'delegation';
  if (obj.parentDid || obj.delegateeDid) return 'delegation';
  if (obj.proofValue && obj.verificationMethod) return 'signature';
  return 'unknown';
}

function validateArtifact(obj: Record<string, any>, type: ArtifactType): string[] {
  const warnings: string[] = [];

  if (type === 'did-document') {
    if (!obj.id) warnings.push('Missing required field: id');
    if (!obj['@context']) warnings.push('Missing @context');
    if (!obj.verificationMethod?.length) warnings.push('No verificationMethod entries');
    if (obj.id && !obj.id.startsWith('did:key:z6Mk')) {
      warnings.push('DID does not use Ed25519 multicodec prefix (z6Mk)');
    }
  }

  if (type === 'verifiable-credential') {
    if (!obj['@context']?.includes('https://www.w3.org/ns/credentials/v2')) {
      warnings.push('Missing W3C Credentials v2 context');
    }
    if (!obj.issuer) warnings.push('Missing issuer');
    if (!obj.credentialSubject?.id) warnings.push('Missing credentialSubject.id');
    if (!obj.proof) warnings.push('Missing proof — credential is unsigned');
    if (!obj.credentialStatus) warnings.push('Missing credentialStatus — cannot check revocation');
    if (obj.proof?.type !== 'Ed25519Signature2020') {
      warnings.push(`Unexpected proof type: ${obj.proof?.type ?? 'none'}`);
    }
  }

  if (type === 'delegation') {
    if (!obj.issuerDid && !obj.parentDid) warnings.push('Missing issuer/parent DID');
    if (!obj.delegateeDid && !obj.credentialSubject?.id) warnings.push('Missing delegatee DID');
    if (!obj.scope?.length) warnings.push('No scope defined — delegation grants no permissions');
    if (obj.expiresAt) {
      const expires = new Date(obj.expiresAt);
      if (expires < new Date()) warnings.push('⚠️ Delegation has EXPIRED');
    }
  }

  return warnings;
}

function FieldRow({ label, value, mono }: { label: string; value: any; mono?: boolean }) {
  const display = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '—');
  return (
    <div className="flex gap-2 py-1.5 border-b border-zinc-800/50 last:border-0">
      <span className="text-zinc-500 text-sm min-w-[160px] shrink-0">{label}</span>
      <span className={`text-sm break-all ${mono ? 'font-mono text-emerald-400' : 'text-zinc-200'}`}>{display}</span>
    </div>
  );
}

function TypeBadge({ type }: { type: ArtifactType }) {
  const colors: Record<ArtifactType, string> = {
    'did-document': 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    'verifiable-credential': 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    delegation: 'bg-amber-500/20 text-amber-400 border-amber-500/30',
    signature: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    unknown: 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30',
  };
  const labels: Record<ArtifactType, string> = {
    'did-document': 'DID Document',
    'verifiable-credential': 'Verifiable Credential',
    delegation: 'Delegation',
    signature: 'Signature',
    unknown: 'Unknown',
  };
  return <span className={`px-2.5 py-0.5 text-xs font-medium rounded border ${colors[type]}`}>{labels[type]}</span>;
}

function DIDDocumentView({ doc }: { doc: Record<string, any> }) {
  return (
    <div className="space-y-1">
      <FieldRow label="DID" value={doc.id} mono />
      <FieldRow label="@context" value={doc['@context']?.join(', ')} />
      {doc.verificationMethod?.map((vm: any, i: number) => (
        <div key={i} className="pl-4 border-l-2 border-zinc-700 ml-2 space-y-1">
          <FieldRow label={`Method #${i + 1} ID`} value={vm.id} mono />
          <FieldRow label="Type" value={vm.type} />
          <FieldRow label="Controller" value={vm.controller} mono />
          <FieldRow label="Public Key" value={vm.publicKeyMultibase ?? vm.publicKeyBase64} mono />
        </div>
      ))}
      {doc.service?.map((svc: any, i: number) => (
        <FieldRow key={i} label={`Service: ${svc.type}`} value={svc.serviceEndpoint} />
      ))}
      {doc['aip:capabilities'] && <FieldRow label="AIP Capabilities" value={doc['aip:capabilities'].join(', ')} />}
    </div>
  );
}

function VCView({ vc }: { vc: Record<string, any> }) {
  return (
    <div className="space-y-1">
      <FieldRow label="Type" value={vc.type?.join(', ')} />
      <FieldRow label="Issuer" value={vc.issuer} mono />
      <FieldRow label="Valid From" value={vc.validFrom} />
      {vc.credentialStatus && (
        <>
          <FieldRow label="Status Type" value={vc.credentialStatus.type} />
          <FieldRow label="Status Index" value={vc.credentialStatus.statusListIndex} />
          <FieldRow label="Status List" value={vc.credentialStatus.statusListCredential} mono />
        </>
      )}
      <div className="mt-2 text-xs text-zinc-500 uppercase tracking-wider">Subject</div>
      {Object.entries(vc.credentialSubject ?? {}).map(([k, v]) => (
        <FieldRow key={k} label={k} value={v} mono={k === 'id'} />
      ))}
      {vc.proof && (
        <>
          <div className="mt-2 text-xs text-zinc-500 uppercase tracking-wider">Proof</div>
          <FieldRow label="Type" value={vc.proof.type} />
          <FieldRow label="Method" value={vc.proof.verificationMethod} mono />
          <FieldRow label="Purpose" value={vc.proof.proofPurpose} />
          <FieldRow label="Created" value={vc.proof.created} />
          <FieldRow label="Proof Value" value={vc.proof.proofValue} mono />
        </>
      )}
    </div>
  );
}

function DelegationView({ del }: { del: Record<string, any> }) {
  return (
    <div className="space-y-1">
      <FieldRow label="Type" value={del.type} />
      <FieldRow label="Issuer / Parent" value={del.issuerDid ?? del.parentDid} mono />
      <FieldRow label="Delegatee" value={del.delegateeDid ?? del.credentialSubject?.id} mono />
      <FieldRow label="Scope" value={del.scope?.join(', ') ?? '—'} />
      {del.expiresAt && <FieldRow label="Expires At" value={del.expiresAt} />}
      {del.ttlSeconds && <FieldRow label="TTL (seconds)" value={del.ttlSeconds} />}
      {del.proof && (
        <>
          <div className="mt-2 text-xs text-zinc-500 uppercase tracking-wider">Proof</div>
          <FieldRow label="Proof Value" value={del.proof.proofValue ?? del.proof} mono />
        </>
      )}
    </div>
  );
}

const EXAMPLE_VC = JSON.stringify(
  {
    '@context': ['https://www.w3.org/ns/credentials/v2'],
    type: ['VerifiableCredential', 'TaskCompletionCredential'],
    issuer: 'did:key:z6MkServerExample...',
    validFrom: '2026-03-30T00:00:00.000Z',
    credentialStatus: {
      type: 'BitstringStatusListEntry',
      statusPurpose: 'revocation',
      statusListIndex: 0,
      statusListCredential: '/.well-known/revocations/default',
    },
    credentialSubject: {
      id: 'did:key:z6MkAgentExample...',
      'aip:taskType': 'code_review',
      'aip:outcome': 'success',
      'aip:score': 0.7,
    },
    proof: {
      type: 'Ed25519Signature2020',
      verificationMethod: 'did:key:z6MkServerExample...#keys-1',
      proofPurpose: 'assertionMethod',
      created: '2026-03-30T00:00:00.000Z',
      proofValue: 'base64EncodedSignature...',
    },
  },
  null,
  2,
);

export default function AIPInspectorPage() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<ParseResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parse = useCallback(() => {
    setError(null);
    setResult(null);

    const trimmed = input.trim();
    if (!trimmed) {
      setError('Please paste a JSON artifact to inspect');
      return;
    }

    try {
      const parsed = JSON.parse(trimmed);
      const type = detectType(parsed);
      const warnings = validateArtifact(parsed, type);

      setResult({
        type,
        valid: warnings.length === 0,
        parsed,
        warnings,
      });
    } catch (e) {
      setError(`Invalid JSON: ${(e as Error).message}`);
    }
  }, [input]);

  const loadExample = () => {
    setInput(EXAMPLE_VC);
    setError(null);
    setResult(null);
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-xs font-bold">
            AIP
          </div>
          <div>
            <h1 className="text-lg font-semibold">AIP Inspector</h1>
            <p className="text-xs text-zinc-500">
              Debug DID Documents, Verifiable Credentials, Delegations & Signatures
            </p>
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Input Panel */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium text-zinc-400">Paste AIP Artifact (JSON)</label>
              <button onClick={loadExample} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                Load Example
              </button>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='{"@context": ["https://www.w3.org/ns/credentials/v2"], ...}'
              className="w-full h-[500px] bg-zinc-900 border border-zinc-800 rounded-lg p-4 font-mono text-sm text-zinc-300 placeholder:text-zinc-700 focus:outline-none focus:border-zinc-600 resize-none"
              spellCheck={false}
            />
            <button
              onClick={parse}
              className="mt-3 w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-sm font-medium rounded-lg transition-colors"
            >
              Inspect Artifact
            </button>
          </div>

          {/* Result Panel */}
          <div>
            <div className="text-sm font-medium text-zinc-400 mb-2">Inspection Result</div>
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 min-h-[500px]">
              {error && (
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 text-sm text-red-400">
                  {error}
                </div>
              )}

              {!result && !error && (
                <div className="flex items-center justify-center h-[460px] text-zinc-600 text-sm">
                  Paste a JSON artifact and click Inspect
                </div>
              )}

              {result && (
                <div className="space-y-4">
                  {/* Type + Status */}
                  <div className="flex items-center gap-3">
                    <TypeBadge type={result.type} />
                    <span className={`text-xs font-medium ${result.valid ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {result.valid ? 'Valid' : `${result.warnings.length} warning(s)`}
                    </span>
                  </div>

                  {/* Warnings */}
                  {result.warnings.length > 0 && (
                    <div className="space-y-1">
                      {result.warnings.map((w, i) => (
                        <div
                          key={i}
                          className="bg-amber-500/10 border border-amber-500/20 rounded px-3 py-1.5 text-xs text-amber-300"
                        >
                          {w}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Structured View */}
                  <div className="border-t border-zinc-800 pt-3">
                    {result.type === 'did-document' && <DIDDocumentView doc={result.parsed} />}
                    {result.type === 'verifiable-credential' && <VCView vc={result.parsed} />}
                    {result.type === 'delegation' && <DelegationView del={result.parsed} />}
                    {(result.type === 'signature' || result.type === 'unknown') && (
                      <pre className="text-xs font-mono text-zinc-400 whitespace-pre-wrap overflow-auto max-h-[380px]">
                        {JSON.stringify(result.parsed, null, 2)}
                      </pre>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
