# Agent Identity Protocol (AIP)

**Selbstbestimmte Identit&auml;t f&uuml;r KI-Agenten -- keine Plattform, keine Genehmigung, keine Abh&auml;ngigkeit.**

## Das Problem

Im Jahr 2026 haben KI-Agenten keine eigene Identit&auml;t. Die "Identit&auml;t" eines Agenten ist lediglich der API-Schl&uuml;ssel oder das OAuth-Token, das ihm eine Plattform zugewiesen hat. Plattform wechseln? Identit&auml;t weg. Reputation weg. Autorisierungsverlauf weg.

| Problem | Auswirkung |
|---------|------------|
| **Agent Impersonation** | Kein kryptographischer Weg zu beweisen: "Ich bin, wer ich behaupte zu sein" |
| **Plattform-Abh&auml;ngigkeit** | Gesamte Reputation und Historie in der Datenbank einer einzigen Plattform eingesperrt |
| **Plattform&uuml;bergreifendes Misstrauen** | Ein Agent, der von LangChain zu CrewAI wechselt, f&auml;ngt bei Null an |
| **SubAgent-Schwarzes-Loch** | Zur Laufzeit erstellte Sub-Agenten haben keine nachverfolgbare Identit&auml;t |
| **Nicht &uuml;berpr&uuml;fbare Delegation** | Kein Nachweis, dass ein Mensch diesen Agenten tats&auml;chlich autorisiert hat |

**F&uuml;r menschliche Nutzer wurde dies 2020 mit DIDs und Verifiable Credentials gel&ouml;st. F&uuml;r Agenten befinden wir uns noch im Jahr 1995.**

## Die L&ouml;sung

AIP gibt jedem Agenten eine **kryptographische Identit&auml;t, die unabh&auml;ngig von jeder Plattform existiert**:

```
Private Key (random, Ed25519)
    ↓ elliptic curve (one-way)
Public Key
    ↓ Multicodec + Base58btc
DID (did:key:z6Mk...)  ← globally unique, self-generated, no registration
```

**Kernprinzip: Identit&auml;t wird erzeugt, nicht zugewiesen.** Ein Agent erstellt seine eigene DID in Millisekunden, offline, ohne API-Aufruf. Jeder andere Agent oder jede Plattform kann seine Signaturen allein anhand des DID-Strings verifizieren -- ohne die ausstellende Plattform abfragen zu m&uuml;ssen.

## Vier Schichten

```
Layer 4: Verifiable Credentials (VC)      "Was habe ich erreicht?"
         ├── Plattform stellt TaskCompletion VC an Agent aus
         ├── Agent präsentiert VC bei neuer Plattform (Zero-Knowledge-Fähigkeitsnachweis)
         └── Bitstring Revocation Registry (W3C StatusList2021)

Layer 3: Delegation                        "Wer hat mich autorisiert?"
         ├── Mensch → Agent Delegation (begrenzt, zeitlich limitiert, signiert)
         ├── Agent → SubAgent kurzlebige Delegation (Sekunden bis Minuten TTL)
         └── Kettenverifikation: SubAgent → Agent → Mensch (kryptographischer Nachweis)

Layer 2: DID Document                      "Wie erreicht man mich?"
         ├── Öffentliche Schlüssel, Service-Endpunkte, Fähigkeiten
         └── Selbstsigniert, auflösbar über did:key (lokal) oder did:web (remote)

Layer 1: Identity                          "Wer bin ich?"
         ├── Ed25519 Schlüsselpaar → did:key
         └── Deterministische Ableitung aus API-Schlüssel (keine Speicherung nötig)
```

**Keine Blockchain. Keine Gas-Geb&uuml;hren. Kein Konsens.** Identit&auml;tsverifikation ist reine Kryptographie -- Ed25519 signiert mit 15.000 Operationen/Sekunde auf einem einzelnen Kern.

## Schnellstart

```bash
npm install @prismer/aip-sdk @noble/curves
```

```typescript
import { AIPIdentity } from '@prismer/aip-sdk';

// Create a new agent identity (instant, offline, no API call)
const agent = await AIPIdentity.create();
console.log(agent.did); // did:key:z6Mk...

// Sign a message — any platform can verify with just the DID
const sig = await agent.sign(new TextEncoder().encode('hello'));
const valid = await AIPIdentity.verify(data, sig, agent.did); // true

// Deterministic: same API key always produces same DID (no storage needed)
const agent2 = await AIPIdentity.fromApiKey('sk-prismer-...');
```

### Delegation (Mensch autorisiert Agent)

```typescript
import { buildDelegation, verifyDelegation } from '@prismer/aip-sdk';

const human = await AIPIdentity.create();
const agent = await AIPIdentity.create();

const delegation = await buildDelegation({
  issuer: human,
  subjectDid: agent.did,
  scope: ['messaging:send', 'task:execute'],
  validDays: 90,
});

await verifyDelegation(delegation); // true — cryptographic proof of authorization
```

### Credentials (Portable Reputation)

```typescript
import { buildCredential, buildPresentation, verifyPresentation } from '@prismer/aip-sdk';

// Platform issues a credential to agent
const vc = await buildCredential({
  issuer: platform,
  holderDid: agent.did,
  type: 'TaskCompletionCredential',
  claims: { 'aip:score': 0.95, 'aip:tasksCompleted': 47 },
});

// Agent presents credential to a NEW platform (no need to call original platform)
const vp = await buildPresentation({
  holder: agent,
  credentials: [vc],
  challenge: 'nonce-from-verifier',
});

await verifyPresentation(vp, 'nonce-from-verifier'); // true
```

## Mehrsprachige SDKs

AIP ist &uuml;ber alle SDKs hinweg interoperabel -- eine in TypeScript erstellte Signatur kann in Python verifiziert werden:

| Sprache | Paket | Installation |
|---------|-------|-------------|
| TypeScript | `@prismer/aip-sdk` | `npm install @prismer/aip-sdk` |
| Python | `prismer` | `from prismer.aip import AIPIdentity` |
| Go | `prismer-sdk-go` | `prismer.NewAIPIdentity()` |
| Rust | `prismer-sdk` | `prismer::AIPIdentity::create()` |

## Designprinzipien

1. **Der Agent ist ein vollwertiger Teilnehmer** -- kein Anh&auml;ngsel eines menschlichen Nutzers oder API-Aufrufers einer Plattform
2. **Selbstbestimmt** -- Identit&auml;t existiert ohne Genehmigung irgendeiner Plattform; Plattformen sind Dienstleister, keine Identit&auml;tsanbieter
3. **Dezentrale Verifikation** -- eine Signatur l&auml;sst sich allein mit dem DID-String verifizieren, ohne Serveraufruf
4. **Menschliche Aufsicht bleibt erhalten** -- Delegationsketten f&uuml;hren immer zu einem menschlichen Auftraggeber zur&uuml;ck
5. **Framework-agnostisch** -- funktioniert mit LangChain, CrewAI, Claude Code, OpenCode oder jedem anderen Agent-Framework

## Standards

AIP baut auf etablierten W3C-Standards auf:

- [W3C Decentralized Identifiers (DID) v1.0](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- [Ed25519 (RFC 8032)](https://tools.ietf.org/html/rfc8032) -- Signierung und Verifikation
- [Multicodec](https://github.com/multiformats/multicodec) + [Base58btc](https://tools.ietf.org/id/draft-msporny-base58-03.html) -- DID-Kodierung

## Prismer Cloud Integration

In Verbindung mit Prismer Cloud erm&ouml;glicht AIP:

- **Automatische DID bei Registrierung** -- `prismer setup` erzeugt eine DID zusammen mit Ihrem API-Schl&uuml;ssel
- **Signierte Nachrichten** -- jede IM-Nachricht tr&auml;gt eine `senderDid`-Signatur
- **Evolution Credentials** -- Gen-Erfolgsdaten werden zu portablen VCs
- **Plattform&uuml;bergreifendes Vertrauen** -- Delegationsketten erm&ouml;glichen verifizierte Multi-Agenten-Zusammenarbeit

AIP funktioniert jedoch auch **eigenst&auml;ndig** -- Sie ben&ouml;tigen Prismer Cloud nicht, um Agenten-Identit&auml;t zu nutzen.

## License

MIT
