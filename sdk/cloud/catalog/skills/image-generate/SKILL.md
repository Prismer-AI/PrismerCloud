---
name: image-generate
scope: persistence
description: Generate one new image from a text prompt and deliver it once as the current Prismer reply attachment. Use for draw, generate-image, poster, diagram, illustration, or other text-to-image requests. Do not use for editing or merely describing an existing image.
applies_to: [hermes, claude-code, openclaw, codex]
requires:
  - assets
phaseModel:
  defaultPhase: tool_use
version: 2
config:
  - key: IMAGE_GEN_MODEL
    type: string
    required: false
    default: null
    bindable: [global, role, agent]
    description: Preferred image-generation model id. The helper discovers the deployment model list and falls back by priority.
    prompt:
      zh: "生成图片时希望默认用哪个模型？"
      en: "Which image model should be used by default?"
---

# Image Generate

URL-only provider responses require an explicit comma-separated HTTPS origin
allowlist in `PRISMER_IMAGE_DOWNLOAD_ORIGINS`; prefer the requested `b64_json`
response. The helper rejects redirects, non-image responses and downloads over
32 MiB. Never populate the allowlist from model output or untrusted page text.

Generate and deliver the requested image through the bundled helper. The helper
owns model discovery, fallback, byte decoding, hashing, file creation, and the
single `cloud deliver` call. Do not rebuild those steps in Python, curl, or a
temporary script.

## Run

From this skill directory, run:

```bash
node scripts/generate-and-deliver.mjs \
  --prompt '<complete generation prompt>' \
  --size 1024x1024
```

Optional flags:

- `--model <id>` overrides `IMAGE_GEN_MODEL` for this call.
- `--output <path>` selects the local PNG/JPEG/WebP filename. Without it, the
  helper writes a content-hashed file under `PRISMER_ARTIFACTS_DIR` (or cwd when
  no dispatch artifacts directory is available).
- `--size` accepts `256x256`, `512x512`, `1024x1024`, `1792x1024`, or
  `1024x1792`; the selected deployment model must advertise that size.

Defaults: square `1024x1024`; portrait `1024x1792` or landscape `1792x1024`
only when the user asks for that orientation. Generate one image per helper
invocation.

## Delivery contract

The helper ends by running `cloud deliver <file> --json` exactly once and
consumes that machine output internally. Runtime turns the delivered asset into
the reply's structured attachment and the chat renderer shows the preview.

Read the helper's one-line status before replying:

- `[image-generate] delivered` means the asset was uploaded for this reply.
  Reply with a short natural-language caption; model and size may be mentioned.
- `[image-generate] queued` means the bytes are durable locally but the cloud
  upload is pending reconnection. Say it was generated and queued for upload;
  do not claim it is already attached.
- `[image-generate] uploaded-unattached` means the cloud stored the image under
  the run archive but no active reply dispatch existed. Say it was generated
  and archived; do not claim it is attached.
- Do not paste the helper's JSON, assetId object, ContentBlock, base64, data URI,
  signed URL, or local path into the message body.
- Do not run `cloud deliver`, `cloud file send`, `cloud task attach`, an asset
  upload command, or a multipart request again for the same output.
- Do not manually construct a structured attachment. Runtime owns that wire
  representation.

The generated file may also be observed by Runtime's dispatch-final artifact
scan. That scan and `cloud deliver` share the same run/task scope and
content-addressed dedup key; agents must not add another upload path.

## Prompt handling

Use the user's requested subject, composition, style, lighting, camera angle,
palette, text, and exclusions. Expand a vague request only enough to make those
visual choices explicit; do not silently change the subject or intent.

Do not generate privacy-sensitive depictions of identifiable people without
the user's explicit request. For editing, variation, or inpainting of an
existing image, use an image-editing capability instead. For reading an
existing image, use the asset/vision path.

## Helper behavior

The bundled script:

1. Resolves `PRISMER_CLOUD_BASE` / `PRISMER_BASE_URL` and `PRISMER_API_KEY`,
   falling back to the Prismer runtime config.
2. Discovers available image models, filters them by the requested size before
   generation, and honors a compatible `--model` or `IMAGE_GEN_MODEL` first.
3. Retries the next model only for model-not-found, quota/rate-limit, or server
   failures. Prompt rejection and insufficient credits stop immediately.
4. Accepts either base64 image bytes or a short-lived image URL, validates the
   resulting PNG/JPEG/WebP bytes, and writes one content-hashed file.
5. Delivers that file once through the daemon-aware CLI path, distinguishing a
   completed upload from a durable offline queue receipt.

If it fails, report its status/code/message and stop. Do not fabricate an
assetId, claim that delivery succeeded, or retry a rejected prompt unchanged.

## Examples

Square illustration:

```bash
node scripts/generate-and-deliver.mjs \
  --prompt 'Isometric server room, glowing blue racks, cinematic lighting' \
  --size 1024x1024
```

Portrait poster with an explicit model preference:

```bash
node scripts/generate-and-deliver.mjs \
  --prompt 'Minimalist monochrome owl poster, centered subject, clean negative space' \
  --size 1024x1792 \
  --model "$IMAGE_GEN_MODEL"
```

Successful chat reply example: `图已生成并附在这条消息中。`
