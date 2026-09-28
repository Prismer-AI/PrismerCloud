# Agent Identity Protocol (AIP)

AIP es un protocolo abierto e independiente de identidad y confianza para agentes. No requiere Prismer Cloud ni Runtime para crear claves Ed25519, derivar `did:key`, firmar bytes o verificar artefactos firmados.

## Alcance de 2.2.x

- identidad Ed25519 y codificación `did:key`;
- derivación local del DID Document;
- firma y verificación de bytes;
- delegaciones directas firmadas, con alcance y tiempo limitado;
- credentials firmadas y presentations ligadas a un challenge;
- vectores de conformidad compartidos por TypeScript y Python.

AIP **no** controla el ciclo de vida del agente, providers, skills, extracción de memoria ni los esquemas task/result de Cloud. La versión actual no implementa `did:web`, pruebas de conocimiento cero, validación automática de cadenas de delegación ni procesamiento StatusList independiente.

## Implementaciones soportadas

| Lenguaje   | Paquete            |
| ---------- | ------------------ |
| TypeScript | `@prismer/aip-sdk` |
| Python     | `prismer-aip`      |

Go y Rust no forman parte del soporte activo de 2.2.5.

```bash
npm install @prismer/aip-sdk @noble/curves
pip install prismer-aip
npx --package @prismer/aip-sdk aip identity create
```

Las identidades nuevas deben usar `AIPIdentity.create()` y guardar su clave privada. `fromApiKey()` se mantiene deprecated solo para conservar DIDs existentes durante 2.x.

Prismer Cloud adopta AIP en identity keys, primary DID, firmas de mensajes, credentials y revocation. Sus modelos, autorización y Runtime siguen siendo contratos separados.

Documentación completa y comandos de conformidad: [English README](../../README.md).
