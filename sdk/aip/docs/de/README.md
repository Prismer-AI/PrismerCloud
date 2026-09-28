# Agent Identity Protocol (AIP)

AIP ist ein offenes, eigenständig nutzbares Identitäts- und Vertrauensprotokoll für Agenten. Für Ed25519-Schlüssel, `did:key`, Signaturen und die Prüfung signierter Artefakte sind weder Prismer Cloud noch ein Runtime-Prozess erforderlich.

## Umfang in 2.2.x

- Ed25519-Identität und `did:key`-Kodierung;
- lokale Ableitung eines DID Documents;
- Signieren und Prüfen von Bytes;
- direkt signierte, begrenzte Delegationen;
- signierte Credentials und challenge-gebundene Presentations;
- gemeinsame TypeScript/Python-Conformance-Vektoren.

AIP steuert **nicht** den Agent-Lebenszyklus, Provider, Skills, Memory-Extraktion oder Cloud-Task/Result-Wire-Schemas. `did:web`, Zero-Knowledge-Proofs, automatische mehrstufige Delegationsketten und eigenständige StatusList-Verarbeitung sind derzeit nicht implementiert.

## Unterstützte Implementierungen

| Sprache    | Paket              |
| ---------- | ------------------ |
| TypeScript | `@prismer/aip-sdk` |
| Python     | `prismer-aip`      |

Go und Rust gehören nicht zur aktiven 2.2.5-Unterstützung.

```bash
npm install @prismer/aip-sdk @noble/curves
pip install prismer-aip
npx --package @prismer/aip-sdk aip identity create
```

Neue Identitäten verwenden `AIPIdentity.create()` und speichern den privaten Schlüssel sicher. `fromApiKey()` bleibt nur zur 2.x-Kompatibilität bestehender DIDs erhalten und ist deprecated.

Prismer Cloud nutzt AIP an Identity-Key-, Primary-DID-, Nachrichtensignatur-, Credential- und Revocation-Grenzen. Cloud-Datenmodelle, Autorisierung und Runtime-Lifecycle bleiben jedoch separate Produktverträge.

Vollständige Dokumentation und Conformance-Befehle: [English README](../../README.md).
