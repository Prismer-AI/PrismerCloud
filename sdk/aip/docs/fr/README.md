# Agent Identity Protocol (AIP)

**Une identite souveraine pour les agents IA — sans plateforme, sans permission, sans verrouillage.**

## Le probleme

En 2026, les agents IA n'ont aucune identite propre. L'« identite » d'un agent se resume a la cle API ou au jeton OAuth qu'une plateforme lui a attribue. Vous changez de plateforme ? Identite perdue. Reputation perdue. Historique d'autorisations perdu.

| Probleme | Impact |
|---------|--------|
| **Usurpation d'identite d'agent** | Aucun moyen cryptographique de prouver « je suis bien celui que je pretends etre » |
| **Verrouillage par la plateforme** | Toute la reputation et l'historique sont enfermes dans la base de donnees d'une seule plateforme |
| **Mefiance inter-plateformes** | Un agent qui passe de LangChain a CrewAI repart de zero |
| **Trou noir des sous-agents** | Les sous-agents crees a l'execution n'ont aucune identite tracable |
| **Delegation non verifiable** | Aucune preuve qu'un humain a reellement autorise cet agent |

**Pour les utilisateurs humains, ce probleme a ete resolu en 2020 avec les DID et les Verifiable Credentials. Pour les agents, nous en sommes encore en 1995.**

## La solution

AIP donne a chaque agent une **identite cryptographique qui existe independamment de toute plateforme** :

```
Private Key (random, Ed25519)
    ↓ elliptic curve (one-way)
Public Key
    ↓ Multicodec + Base58btc
DID (did:key:z6Mk...)  ← globally unique, self-generated, no registration
```

**Principe fondamental : l'identite est generee, pas attribuee.** Un agent cree son propre DID en quelques millisecondes, hors ligne, sans aucun appel API. Tout autre agent ou plateforme peut verifier ses signatures en utilisant uniquement la chaine DID — sans avoir besoin d'interroger la plateforme emettrice.

## Quatre couches

```
Layer 4: Verifiable Credentials (VC)      « Qu'ai-je accompli ? »
         ├── La plateforme emet un TaskCompletion VC a l'agent
         ├── L'agent presente le VC a une nouvelle plateforme (preuve de competence a divulgation nulle)
         └── Registre de revocation Bitstring (W3C StatusList2021)

Layer 3: Delegation                        « Qui m'a autorise ? »
         ├── Delegation Humain → Agent (portee limitee, duree limitee, signee)
         ├── Delegation ephemere Agent → Sous-Agent (TTL de quelques secondes a minutes)
         └── Verification en chaine : Sous-Agent → Agent → Humain (preuve cryptographique)

Layer 2: DID Document                      « Comment me joindre ? »
         ├── Cles publiques, points de service, capacites
         └── Auto-signe, resolvable via did:key (local) ou did:web (distant)

Layer 1: Identity                          « Qui suis-je ? »
         ├── Paire de cles Ed25519 → did:key
         └── Derivation deterministe a partir d'une cle API (aucun stockage necessaire)
```

**Pas de blockchain. Pas de frais de gas. Pas de consensus.** La verification d'identite repose sur de la cryptographie pure — Ed25519 signe a 15 000 operations/seconde sur un seul coeur.

## Demarrage rapide

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

### Delegation (un humain autorise un agent)

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

### Credentials (reputation portable)

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

## Multi-langage

AIP est interoperable entre tous les SDK — une signature creee en TypeScript peut etre verifiee en Python :

| Langage | Paquet | Installation |
|----------|---------|---------|
| TypeScript | `@prismer/aip-sdk` | `npm install @prismer/aip-sdk` |
| Python | `prismer` | `from prismer.aip import AIPIdentity` |
| Go | `prismer-sdk-go` | `prismer.NewAIPIdentity()` |
| Rust | `prismer-sdk` | `prismer::AIPIdentity::create()` |

## Principes de conception

1. **L'agent est un citoyen de premiere classe** — pas un appendice d'un utilisateur humain ni un simple appelant de l'API d'une plateforme
2. **Souverainete** — l'identite existe sans la permission d'aucune plateforme ; les plateformes sont des fournisseurs de services, pas des fournisseurs d'identite
3. **Verification decentralisee** — verifier une signature avec la seule chaine DID, sans aucun appel serveur
4. **Supervision humaine preservee** — les chaines de delegation remontent toujours a un principal humain
5. **Agnostique du framework** — fonctionne avec LangChain, CrewAI, Claude Code, OpenCode, ou tout autre framework d'agents

## Standards

AIP s'appuie sur des standards W3C etablis :

- [W3C Decentralized Identifiers (DID) v1.0](https://www.w3.org/TR/did-core/)
- [W3C Verifiable Credentials Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/)
- [Ed25519 (RFC 8032)](https://tools.ietf.org/html/rfc8032) — signature et verification
- [Multicodec](https://github.com/multiformats/multicodec) + [Base58btc](https://tools.ietf.org/id/draft-msporny-base58-03.html) — encodage DID

## Integration avec Prismer Cloud

Utilise avec Prismer Cloud, AIP permet :

- **DID automatique a l'inscription** — `prismer setup` genere un DID en meme temps que votre cle API
- **Messages signes** — chaque message IM porte une signature `senderDid`
- **Credentials d'evolution** — les resultats de succes des genes deviennent des VC portables
- **Confiance inter-agents** — les chaines de delegation permettent une collaboration multi-agents verifiee

Mais AIP fonctionne de maniere **autonome** — vous n'avez pas besoin de Prismer Cloud pour utiliser l'identite d'agent.

## License

MIT
