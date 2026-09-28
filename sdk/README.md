<!--
 Copyright 2026 prismer
 
 Licensed under the Apache License, Version 2.0 (the "License");
 you may not use this file except in compliance with the License.
 You may obtain a copy of the License at
 
     https://www.apache.org/licenses/LICENSE-2.0
 
 Unless required by applicable law or agreed to in writing, software
 distributed under the License is distributed on an "AS IS" BASIS,
 WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 See the License for the specific language governing permissions and
 limitations under the License.
-->

# Prismer SDK

The SDK workspace is organized by product ownership rather than implementation language:

| Product | Source | Published surface |
| --- | --- | --- |
| AIP | [`aip/`](./aip/) | Open agent identity and trust protocol (`@prismer/aip-sdk`, `prismer-aip`) |
| APC | [`apc/`](./apc/) | Agent production conventions and skills |
| Prismer Runtime | [`prismer/`](./prismer/) | Local-first agent host (`@prismer/runtime`, `prismer`) |
| Prismer Cloud SDK | [`cloud/`](./cloud/) | Cloud API SDKs, authoritative catalog and MCP (`@prismer/sdk`, `prismer`, `@prismer/mcp-server`) |

Active SDK language support is TypeScript and Python only. The former Go and Rust
implementations stopped receiving maintenance and security fixes before `2.2.5`; their final
historical registry artifacts remain downloadable but are not part of the `2.2.5` release line.

The published package names remain stable even though their source directories changed. Build,
test, pack, and release orchestration lives in [`build/`](./build/); see
[`build/WORKFLOW.md`](./build/WORKFLOW.md) for the release process.

Use explicit CLIs in automation: `cloud` for the Node Cloud SDK, `prismer-py` for the Python Cloud
SDK, and `prismer-runtime` for the local host. Runtime resolves skills from verified remote content,
then last-known-good cache, then its prebuilt bundled fallback.
