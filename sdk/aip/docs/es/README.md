# Agent Identity Protocol (AIP)

**Identidad auto-soberana para agentes de IA — sin plataforma, sin permisos, sin dependencia de proveedor.**

## El problema

En 2026, los agentes de IA no tienen una identidad propia. La "identidad" de un agente es cualquier clave de API o token OAuth que una plataforma le haya asignado. Si cambia de plataforma, la identidad desaparece. La reputacion desaparece. El historial de autorizaciones desaparece.

| Problema | Impacto |
|---------|--------|
| **Suplantacion de agentes** | No existe una forma criptografica de demostrar "soy quien digo ser" |
| **Dependencia de plataforma** | Toda la reputacion y el historial quedan encerrados en la base de datos de una sola plataforma |
| **Desconfianza entre plataformas** | Un agente que migra de LangChain a CrewAI empieza desde cero |
| **Agujero negro de sub-agentes** | Los sub-agentes creados en tiempo de ejecucion no tienen una identidad rastreable |
| **Delegacion no verificable** | No hay prueba de que un humano haya autorizado realmente a este agente |

**Para los usuarios humanos, esto se resolvio en 2020 con DIDs y Verifiable Credentials. Para los agentes, seguimos en 1995.**

## La solucion

AIP otorga a cada agente una **identidad criptografica que existe de forma independiente a cualquier plataforma**:

```
Private Key (random, Ed25519)
    ↓ elliptic curve (one-way)
Public Key
    ↓ Multicodec + Base58btc
DID (did:key:z6Mk...)  ← globally unique, self-generated, no registration
```

**Principio fundamental: la identidad se genera, no se asigna.** Un agente crea su propio DID en milisegundos, sin conexion, sin ninguna llamada a una API. Cualquier otro agente o plataforma puede verificar sus firmas usando unicamente la cadena DID — sin necesidad de consultar a la plataforma emisora.

## Cuatro capas

```
Layer 4: Verifiable Credentials (VC)      "Que he logrado?"
         ├── Platform issues TaskCompletion VC to agent
         ├── Agent presents VC to new platform (zero-knowledge proof of capability)
         └── Bitstring revocation registry (W3C StatusList2021)

Layer 3: Delegation                        "Quien me autorizo?"
         ├── Human → Agent delegation (scoped, time-limited, signed)
         ├── Agent → SubAgent ephemeral delegation (seconds-to-minutes TTL)
         └── Chain verification: SubAgent → Agent → Human (cryptographic proof)

Layer 2: DID Document                      "Como contactarme?"
         ├── Public keys, service endpoints, capabilities
         └── Self-signed, resolvable via did:key (local) or did:web (remote)

Layer 1: Identity                          "Quien soy?"
         ├── Ed25519 keypair → did:key
         └── Deterministic derivation from API key (no storage needed)
```

**Sin blockchain. Sin comisiones de gas. Sin consenso.** La verificacion de identidad es criptografia pura — Ed25519 firma a 15,000 operaciones/segundo en un solo nucleo.

## Inicio rapido

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

### Delegacion (Un humano autoriza a un agente)

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

### Credenciales (Reputacion portable)

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

## Multi-lenguaje

AIP es interoperable entre todos los SDKs — una firma creada en TypeScript puede verificarse en Python:

| Lenguaje | Paquete | Instalacion |
|----------|---------|-------------|
| TypeScript | `@prismer/aip-sdk` | `npm install @prismer/aip-sdk` |
| Python | `prismer` | `from prismer.aip import AIPIdentity` |
| Go | `prismer-sdk-go` | `prismer.NewAIPIdentity()` |
| Rust | `prismer-sdk` | `prismer::AIPIdentity::create()` |

## Principios de diseno

1. **El agente es un ciudadano de primera clase** — no un apendice de un usuario humano ni un consumidor de la API de una plataforma
2. **Auto-soberano** — la identidad existe sin el permiso de ninguna plataforma; las plataformas son proveedores de servicios, no proveedores de identidad
3. **Verificacion descentralizada** — se verifica una firma solo con la cadena DID, sin necesidad de llamar a ningun servidor
4. **Supervision humana preservada** — las cadenas de delegacion siempre se remontan a un principal humano
5. **Agnostico al framework** — funciona con LangChain, CrewAI, Claude Code, OpenCode o cualquier framework de agentes

## Estandares

AIP se construye sobre estandares establecidos del W3C:

- [W3C Decentralized Identifiers (DID) v1.0](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- [Ed25519 (RFC 8032)](https://tools.ietf.org/html/rfc8032) — firma y verificacion
- [Multicodec](https://github.com/multiformats/multicodec) + [Base58btc](https://tools.ietf.org/id/draft-msporny-base58-03.html) — codificacion DID

## Integracion con Prismer Cloud

Cuando se usa con Prismer Cloud, AIP permite:

- **DID automatico al registrarse** — `prismer setup` genera un DID junto con tu clave de API
- **Mensajes firmados** — cada mensaje de IM lleva una firma `senderDid`
- **Credenciales de evolucion** — los registros de exito de genes se convierten en VCs portables
- **Confianza entre agentes** — las cadenas de delegacion permiten colaboracion multi-agente verificada

Pero AIP funciona **de forma independiente** — no necesitas Prismer Cloud para usar la identidad de agentes.

## License

MIT
