# Agent Identity Protocol (AIP)

AIP est un protocole ouvert et autonome d'identité et de confiance pour les agents. Prismer Cloud et Runtime ne sont pas nécessaires pour créer une clé Ed25519, dériver un `did:key`, signer des octets ou vérifier un artefact signé.

## Périmètre de la version 2.2.x

- identité Ed25519 et encodage `did:key` ;
- dérivation locale du DID Document ;
- signature et vérification d'octets ;
- délégations directes signées, limitées en portée et dans le temps ;
- credentials signés et presentations liées à un challenge ;
- vecteurs de conformité communs à TypeScript et Python.

AIP **ne contrôle pas** le cycle de vie des agents, les providers, les skills, l'extraction de mémoire ni les schémas task/result de Cloud. `did:web`, les preuves zero-knowledge, la validation automatique de chaînes de délégation et le traitement autonome de StatusList ne sont pas implémentés actuellement.

## Implémentations prises en charge

| Langage    | Package            |
| ---------- | ------------------ |
| TypeScript | `@prismer/aip-sdk` |
| Python     | `prismer-aip`      |

Go et Rust ne font pas partie du support actif de la version 2.2.5.

```bash
npm install @prismer/aip-sdk @noble/curves
pip install prismer-aip
npx --package @prismer/aip-sdk aip identity create
```

Les nouvelles identités utilisent `AIPIdentity.create()` et conservent leur clé privée en sécurité. `fromApiKey()` reste deprecated uniquement pour préserver les DID existants pendant la série 2.x.

Prismer Cloud adopte AIP pour les identity keys, primary DID, signatures de messages, credentials et revocation. Les modèles Cloud, l'autorisation et le Runtime restent des contrats produits distincts.

Documentation complète et commandes de conformité : [English README](../../README.md).
