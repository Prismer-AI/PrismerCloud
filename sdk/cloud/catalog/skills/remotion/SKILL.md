---
name: remotion
scope: common
description: Use when a task involves Remotion compositions, Studio, Player, @remotion packages, programmatic video rendering, captions, media processing, maps, or Remotion and Mediabunny upgrades.
requires:
  - assets
metadata:
  aliases:
    - remotion-best-practices
    - remotion-captions
    - remotion-create
    - remotion-docs
    - remotion-interactivity
    - remotion-maps
    - remotion-markup
    - remotion-multimedia
    - remotion-render
    - remotion-saas
    - remotion-studio
    - remotion-upgrade
---

# Remotion

Build and maintain Remotion projects while preserving user changes. If a file
changed unexpectedly, treat it as intentional unless the user confirms otherwise.

## Workflow

1. Inspect `package.json`, the lockfile, existing compositions, the current
   diff, and `npx remotion versions`. Reuse the package manager and project
   shape; keep every `remotion` / `@remotion/*` package on one exact version.
2. Confirm the requested output: composition/source changes, Studio preview,
   rendered media, an embedded Player, or a rendering service.
3. Implement deterministic, frame-driven visuals and keep render inputs
   serializable.
4. Preview in Studio. Render only when the user requests a media file.
5. Verify rendered media with `ffprobe` and inspect representative frames.
6. Report changed files, preview/render evidence, and the delivery receipt. In
   Prismer, a loose sandbox path is not a delivered result.

## Prismer artifact and delivery contract

When the user requests rendered media, write the final file under
`$PRISMER_ARTIFACTS_DIR` (the dispatch `<artifacts_dir>`). Put project scaffolds,
frames, probes, and other intermediates under `$PRISMER_SCRATCH_DIR` or the
existing project tree. Then deliver each requested final file exactly once:

```bash
cloud deliver "$PRISMER_ARTIFACTS_DIR/launch-video.mp4"
```

Writing or rendering a file does not attach it. A successful `cloud deliver`
receipt is the delivery oracle. Do not deliver preview frames, temporary audio,
or duplicate encodes unless the user requested them. If no dispatch artifact
directory exists, keep the result in the user-approved project output path and
report that delivery was unavailable rather than inventing a receipt.

## Project creation and compositions

Do not scaffold over a non-empty project. When no suitable project exists,
confirm Node.js and Git are available, then run:

```bash
npx create-video@latest --yes --blank --no-tailwind my-video
cd my-video
npm install
```

Use a meaningful directory name. Add Tailwind only when the user asks for it or
the project already uses it. Inspect the generated manifest, config, and global
CSS before continuing: generator releases can still emit Tailwind dependencies
and imports when `--no-tailwind` was requested. Remove those only when the
project does not use them, and keep the Remotion package versions aligned.

In Prismer sandbox images, use a command-scoped writable npm cache for every
command that may install or invoke a missing package, including scaffolding,
`npm ci`, `remotion add`, probes, and renders:

```bash
npm_config_cache="${PRISMER_SCRATCH_DIR:-/tmp}/npm-cache" npm ci
```

Do not change the user's global npm configuration to work around a sandbox
ownership mismatch.

Keep static composition metadata inline:

```tsx
<Composition
  id="LaunchVideo"
  component={LaunchVideo}
  durationInFrames={300}
  fps={30}
  width={1920}
  height={1080}
  defaultProps={{title: 'Launch day'}}
/>
```

Use `calculateMetadata()` only when duration, dimensions, or props genuinely
depend on inputs, remote data, or media inspection. Keep `defaultProps` inline
so Studio can save prop edits back to code. For multi-scene videos, use named
`<Sequence>` boundaries and derive all timing from one fps-aware plan.

## Frame-driven animation

Drive rendered animation from `useCurrentFrame()`, `interpolate()`, springs, or
easing. Do not use CSS transitions, CSS animations, wall-clock timers, or
Tailwind animation utilities; they are not deterministic renders.

```tsx
import {
  AbsoluteFill,
  Easing,
  Interactive,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

export const Hero = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();

  return (
    <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
      <Interactive.Div
        name="Hero title"
        style={{
          opacity: interpolate(frame, [0, fps], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          scale: interpolate(frame, [0, fps], [0.9, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
            easing: Easing.spring({damping: 200}),
            output: 'perceptual-scale',
          }),
          fontSize: 88,
        }}
      >
        Launch day
      </Interactive.Div>
    </AbsoluteFill>
  );
};
```

Prefer the individual `scale`, `translate`, and `rotate` CSS properties over a
composed `transform` string. Clamp both ends of finite animations unless
extrapolation is intentional.

## Studio-editable markup

Use `Interactive.*` for HTML and SVG elements that should be selectable,
draggable, resized, rotated, styled, or keyframed in Studio. `<Img>` is already
interactive.

- Give each interactive element a short, hard-coded, descriptive `name`.
- Keep one-off text directly inside the element.
- Keep style objects, `interpolate()` ranges, outputs, easing, and extrapolation
  inline when Studio write-back matters.
- Destructure only supported values such as `fps`, `width`, `height`, and
  `durationInFrames` from `useVideoConfig()`.
- Avoid extracted style constants, object spreading, computed effect arrays,
  and arbitrary variables inside editable keyframe ranges.

For custom components, look up the current `make-component-interactive` API in
the official Remotion documentation before implementing it.

## Assets, media, and timing

Put local assets in `public/` and reference them with `staticFile()`:

```tsx
import {Audio, Video} from '@remotion/media';
import {AnimatedImage, CanvasImage, staticFile} from 'remotion';

export const MediaLayer = () => (
  <>
    <Video src={staticFile('clip.mp4')} />
    <Audio src={staticFile('music.mp3')} />
    <CanvasImage src={staticFile('logo.png')} />
    <AnimatedImage src={staticFile('sticker.gif')} />
  </>
);
```

Use `@remotion/gif` when the Chrome-backed animated-image path is unsuitable.
Install ecosystem packages with `npx remotion add <package>` so Remotion package
versions stay aligned.

Prefer local or content-addressed media for reproducible sandbox renders. Do
not bake cookies, bearer tokens, signed URLs, or map credentials into source or
composition props. For asynchronous assets, fonts, captions, and map tiles,
pair `delayRender()` / `continueRender()` with `cancelRender()` on failure so a
missing dependency fails explicitly instead of hanging until timeout.

Use `from`, `durationInFrames`, and `trimBefore` on supported components. Wrap
unsupported components in `<Sequence>`:

```tsx
<Sequence name="Product demo" from={2 * fps} durationInFrames={6 * fps}>
  <Video src={staticFile('demo.mp4')} trimBefore={1 * fps} />
</Sequence>
```

Match media duration to the intended usable segment. Keep scene timing in one
plan so transitions neither overlap accidentally nor leave blank frames.

For effects, use the least complex technique that produces the shot:

1. HTML, SVG, and CSS.
2. A Remotion effect on the element or an `HtmlInCanvas` wrapper.
3. A custom effect or shader only when the first two cannot produce it.

Keep effect arrays stable. Render separate elements instead of conditionally
changing an effect array's shape.

## Captions and multimedia inspection

Normalize captions to Remotion's `Caption[]` shape and keep ingestion timestamps
in milliseconds:

```ts
import type {Caption} from '@remotion/captions';

const caption: Caption = {
  text: 'Hello',
  startMs: 0,
  endMs: 800,
  timestampMs: null,
  confidence: null,
};
```

Convert milliseconds to frames only at the composition boundary using the
composition fps. Preserve word timing when available, group captions into
readable pages, animate from the frame clock, and verify wrapping and safe areas
at the actual output dimensions.

Use the current `@remotion/captions` parser for SRT rather than writing a
timestamp parser. Before implementing captions, confirm the current APIs for
`parse-srt`, `createTikTokStyleCaptions`, and the chosen transcription provider.

For audio visualization, use `@remotion/media-utils` with frame-windowed audio
data; never drive bars or waveforms from a realtime analyser. For charts and
text animation, compute the final geometry first and reveal it with frame-based
clipping, opacity, or transforms so bars, labels, and glyph layout stay stable.

Use Mediabunny for browser-side duration, dimensions, trimming, cropping,
metadata, and container handling. Read <https://mediabunny.dev/llms.txt> before
using unfamiliar APIs. Keep `mediabunny` and `@mediabunny/*` versions compatible
with the project's Remotion version.

## Maps

Choose one technique for the shot:

| Technique | Use when |
| --- | --- |
| Prepared raster | Deterministic static/satellite imagery with animated overlays is enough. |
| Mapbox | Polished styles, globe rendering, or 3D buildings are required. |
| MapLibre | An open-source vector runtime without a Mapbox API key is preferred. |
| MapTiler | Hosted styles or geographic annotations fit the project. |
| CesiumJS | Terrain, globe-scale 3D, or flight-camera motion is required. |

Never commit map credentials. Confirm licensing and attribution for imagery,
tiles, and styles. Before frame capture, wait for tiles, imagery, fonts, and
camera initialization. Drive camera movement from the Remotion frame clock,
keep geographic inputs local or content-addressed when repeatability matters,
and verify headless Chromium/WebGL in the actual render environment.

## Studio, render, and verification

Start Studio without opening an external browser:

```bash
npx remotion studio --no-open
```

Use the printed URL. Open a composition directly at `/<composition-id>`, for
example `http://localhost:3000/LaunchVideo`.

Useful Studio flags:

| Argument | Purpose |
| --- | --- |
| `--log=<level>` | Set `error`, `warn`, `info`, or `verbose`. |
| `--port=<number>` | Request a specific port. |
| `--force-new` | Start another instance for the same project and port. |

For a quick deterministic layout check, render one frame:

```bash
npx remotion still LaunchVideo out.png --scale=0.25 --frame=30
```

At 30 fps, frame 30 is one second. Skip this when an existing visual test
already provides sufficient evidence.

Before rendering, verify the CLI sees the intended composition:

```bash
npx remotion versions
npx remotion compositions
```

Let Remotion manage its compatible browser by default. A Prismer image may also
carry a Playwright browser, but its presence is not a compatibility guarantee:
the full Chrome binary can fail under sandbox crashpad policy, while a newer
Headless Shell can pass a still render yet fail a multi-frame render. Pass
`--browser-executable` only for an image-owned, version-paired executable that
has passed an adjacent-frame render test. Never search the whole filesystem for
a browser or treat a successful launch as compatibility evidence.

Render only when the user asks for a media file:

```bash
npx remotion render LaunchVideo out.mp4 --codec=h264
npx remotion still LaunchVideo out.png --frame=0
```

The Prismer sandbox provides Node and FFmpeg, and Remotion manages a compatible
browser in the project cache. Prefer H.264 video plus AAC audio in MP4 for broad
playback unless transparency or lossless output is required. Keep the writable
npm-cache override scoped to each command:

```bash
npm_config_cache=/tmp/npm-cache npx remotion render LaunchVideo out.mp4 --codec=h264
```

For CJK content, explicitly load and await a pinned font; do not rely only on a
system fallback family being present. Inspect adjacent encoded frames as well as
isolated stills: a headless renderer may produce a correct still while a
fallback font run flickers or loses glyphs during a full render.

Treat media inspection as the delivery oracle:

```bash
ffprobe -v error \
  -show_entries format=duration:stream=codec_name,width,height \
  -of compact out.mp4
```

Confirm duration, dimensions, codecs, and the expected audio stream. Inspect
representative frames, including several adjacent frames in animated or
text-heavy sections, or play the result when possible. A successful render
command alone is not delivery evidence. If isolated stills are correct but the
encoded render has partial or flickering frames, use the programmatic
`renderStill()` API with one bundled serve URL and one browser instance to emit
the verified frame sequence, then assemble it with the sandbox FFmpeg. Do not
loop the CLI and rebundle once per frame; report the fallback and probe the
assembled file again.

## Players, editors, and rendering services

Use Remotion's `<Player>` for an interactive React preview. Keep the composition
usable by both Player and render paths; do not fork visual logic.

Choose rendering architecture by workload:

- Browser/client rendering for bounded, user-local work.
- A Node worker and queue for a controlled server.
- Remotion Lambda for AWS-native elastic rendering.
- The current official Vercel or Cloudflare integration when it matches the
  hosting platform and installed Remotion version.

Non-trivial rendering should be asynchronous: return a job ID, expose progress
and failure, store output durably, and make retries idempotent.

For editors, model composition props and timeline state explicitly. Keep render
inputs serializable and versioned, validate untrusted props, bound remote asset
access, and separate preview state from durable project state.

Remotion's rendering surface is React. For Vue, Angular, or Svelte hosts, use
the current official integration and keep the React composition boundary
explicit rather than relying on a memorized starter.

## Current documentation and upgrades

Prefer current official documentation over memorized APIs. Append `.md` to a
Remotion docs URL to fetch Markdown, for example:

```text
https://www.remotion.dev/docs/sequence.md
```

The Remotion docs search can also be queried through its Algolia index:

```http
POST https://plsduol1ca-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=3e42dbd4f895fe93ff5cf40d860c4a85&x-algolia-application-id=PLSDUOL1CA
Content-Type: application/json

{
  "requests": [{
    "query": "<concept or API>",
    "indexName": "remotion",
    "params": "attributesToRetrieve=[\"hierarchy.lvl0\",\"hierarchy.lvl1\",\"hierarchy.lvl2\",\"url\"]&hitsPerPage=10"
  }]
}
```

For upgrades:

1. Inspect every manifest and the lockfile; preserve unrelated changes.
2. Run `npx remotion upgrade` when the local CLI supports it.
3. Otherwise, update every `remotion` and `@remotion/*` package to the same
   exact stable version.
4. Check <https://www.remotion.dev/docs/mediabunny/version> and align all
   Mediabunny packages.
5. Update the lockfile with the project's package manager.
6. Run `npx remotion versions`, typecheck/tests, Studio preview, and a
   representative still or short render when rendering behavior changed.
7. Review <https://github.com/remotion-dev/remotion/releases> for relevant
   breaking changes.

Do not modify Prismer's bundled Remotion skill while upgrading an application;
the skill is delivered by Runtime catalog/OTA and is not owned by that project.

## Completion checklist

- Existing project structure, package manager, versions, and user diff inspected.
- Animation is frame-driven and finite interpolation is clamped intentionally.
- Assets use `public/` plus `staticFile()` and ecosystem package versions align.
- Studio preview or existing visual evidence covers interaction and timing.
- Requested renders pass `ffprobe` and representative visual inspection.
- Final media is attached through the workspace asset flow when running in Prismer.
