# aka-ai-generator ChatLuna Integration Design

Last updated: 2026-03-23

## Purpose

This document proposes a ChatLuna-compatible design for `koishi-plugin-aka-ai-generator`.

The design targets two product goals:

1. Let users invoke image generation features through natural language in ChatLuna, instead of remembering plugin commands.
2. Support context-aware image generation similar to "continue editing the previous image" or "keep the same character and change the scene".

The design intentionally keeps `aka-ai-generator` independently publishable as a normal Koishi plugin while adding an optional built-in ChatLuna bridge, similar in spirit to `aka-lark-center`.

## Current Plugin Status

`aka-ai-generator` already has a usable capability core:

- provider abstraction for image generation
- support for text-to-image, image-to-image, multi-image composition, style presets, and optional video generation
- quota, rate limit, and safety handling
- support for both normal URLs and Koishi `internal:` resource URLs

What it does not have yet:

- full end-to-end validation of the ChatLuna tool path
- final policy tuning for room-scoped continuity behavior
- a more unified public service API that fully collapses command and ChatLuna execution paths

After the refactor work completed on 2026-03-23, the plugin already has:

- a stable `ctx.aiGenerator` service
- reusable ChatLuna-oriented tool definitions
- a built-in ChatLuna bridge
- room-scoped image context storage
- a pre-chat context injection path

The plugin is no longer centered on one oversized `src/index.ts`. It now uses a service-oriented structure with explicit command, orchestrator, and ChatLuna bridge layers.

## Why ChatLuna Fits Well

ChatLuna's extension surface is a strong match for this plugin:

- `ChatLunaPlugin.registerTool()` allows image generation capabilities to appear as reusable tools
- `selector(history)` and `authorization(session)` make it possible to gate tool use safely
- `chatluna/before-chat` and related events allow pre-chat context grounding
- room-based conversations provide a natural boundary for image context continuity

The official docs also expose room features that are directly useful here:

- `autoCreateRoomFromUser`: automatically create an isolated private room per user
- `defaultChatMode`: allows a default mode that supports tool calling

This makes ChatLuna room scope a good fit for image context isolation, especially for flows like:

- "edit the previous image"
- "continue from the last result"
- "use the same style as before"
- "keep the character but change the background"

## Product Positioning

This plugin should follow both of these paths at once:

1. Plain Koishi plugin path
   Expose a reusable `ctx.aiGenerator` service for normal plugin and command usage.
2. ChatLuna extension path
   Optionally register tools and context middleware into ChatLuna when ChatLuna is present and enabled.

This is the same architectural pattern already used by `aka-lark-center`:

- a capability layer remains reusable outside ChatLuna
- a built-in bridge adapts those capabilities into ChatLuna extension points

## Design Goals

- Preserve existing command UX and compatibility.
- Add optional ChatLuna integration without making ChatLuna a hard dependency.
- Use room-level context rather than global user-level context.
- Keep image assets out of prompt history whenever possible.
- Reuse existing quota, rate-limit, and safety logic.
- Keep the plugin independently publishable.

## Non-Goals

- Do not attempt to recreate OpenAI or Gemini native multimodal chat products exactly.
- Do not store large base64 image payloads inside ChatLuna room history.
- Do not expose high-risk admin actions such as recharge operations as ChatLuna tools in the first phase.
- Do not require a local Koishi runtime app inside this workspace.

## Architecture Overview

Recommended layers:

1. Core capability layer
   Pure image generation orchestration, provider dispatch, quota checks, and record writing.
2. Service layer
   Expose `ctx.aiGenerator` for command handlers and other plugins.
3. Shared ChatLuna bridge metadata
   Tool definitions, context block formatting, intent heuristics, and shared types.
4. ChatLuna bridge layer
   Runtime loading, tool registration, room-context injection, and room-context cleanup.

Recommended file layout:

```text
src/
  bridge/
    chatluna/
      context-injection.ts
      manager.ts
      runtime.ts
      tools.ts
  core/
    generation-service.ts
    image-context-store.ts
    image-source-resolver.ts
  service/
    index.ts
  shared/
    chatluna-tool-definitions.ts
    chatluna-context.ts
    intent-strategy.ts
    types.ts
```

## Core Service Design

Introduce a reusable `AiGeneratorService` and expose it as `ctx.aiGenerator`.

The service should provide stable methods such as:

- `generateImage(params)`
- `editImage(params)`
- `composeImages(params)`
- `applyStylePreset(params)`
- `getQuota(params)`
- `listStylePresets()`

The service should own:

- provider selection
- request option normalization
- input image resolution
- quota reservation and consumption
- safety block recording
- generation result recording

The existing command flows in `src/index.ts` should gradually become thin wrappers around this service.

## ChatLuna Tool Design

### First-Phase Tool Set

Expose only low-risk and high-frequency tools in phase 1:

- `aigc_generate_image`
- `aigc_edit_image`
- `aigc_apply_style_preset`
- `aigc_get_quota`
- `aigc_list_styles`

Do not expose these in phase 1:

- recharge commands
- recharge history
- video generation

The reasons are risk, cost, and operational complexity.

### Tool Semantics

#### `aigc_generate_image`

Use for:

- pure text-to-image generation
- requests like "generate a poster", "make a portrait", "draw a cyberpunk city"

Inputs:

- `prompt: string`
- `numImages?: number`
- `aspectRatio?: string`
- `resolution?: string`
- `modelSuffix?: string`

#### `aigc_edit_image`

Use for:

- editing a current image
- continuing from the previous result
- transforming a user-uploaded image

Inputs:

- `prompt: string`
- `referenceMode: 'current_message' | 'quoted_message' | 'explicit' | 'last_generated'`
- `imageUrls?: string[]`
- `numImages?: number`
- `aspectRatio?: string`
- `resolution?: string`
- `modelSuffix?: string`

#### `aigc_apply_style_preset`

Use for:

- explicit preset-driven generation
- requests where preset behavior is more stable than free-form prompting

Inputs:

- `stylePreset: string`
- `referenceMode?: 'current_message' | 'quoted_message' | 'explicit' | 'last_generated' | 'none'`
- `imageUrls?: string[]`
- `promptAdditions?: string`
- `numImages?: number`
- `aspectRatio?: string`
- `resolution?: string`
- `modelSuffix?: string`

#### `aigc_get_quota`

Use for:

- user-facing quota check

#### `aigc_list_styles`

Use for:

- discovering configured style presets

### Tool Registration Pattern

Register tools through a built-in ChatLuna bridge manager, using the same broad pattern as `aka-lark-center`:

- load ChatLuna runtime lazily
- create a plugin instance only when ChatLuna exists
- register tools with `selector()`, `authorization()`, and `createTool()`
- uninstall tools cleanly when disabled

## Room-Based Context Design

### Key Decision

Use ChatLuna room scope as the image context boundary.

Do not use only `userId`.
Do not use only `channelId`.

Instead, use `conversationId` as the primary context key.

Reason:

- a single user may have multiple rooms
- a room may intentionally preserve a specific creative direction
- group and private room behaviors should remain isolated

### Context Store

Add an internal `ImageContextStore` keyed by `conversationId`.

Suggested types:

```ts
interface GeneratedImageRecord {
  id: string
  conversationId: string
  userId: string
  createdAt: number
  source: 'generated' | 'upload' | 'quoted' | 'explicit'
  imageUrl: string
  prompt: string
  normalizedPrompt?: string
  provider: 'yunwu' | 'gptgod' | 'gemini'
  modelId: string
  aspectRatio?: string
  resolution?: string
  stylePreset?: string
  parentRecordId?: string
}

interface ConversationImageContext {
  conversationId: string
  lastGenerated?: GeneratedImageRecord
  recentRecords: GeneratedImageRecord[]
  pinnedStylePreset?: string
  pinnedCharacterNotes?: string
  lastUpdatedAt: number
}
```

### Store Policy

- Keep the last 10 to 20 records per room.
- Store only references and metadata, not large base64 payloads.
- Clear the room context when ChatLuna clears room history.
- Apply TTL cleanup for inactive rooms.

## Image Source Resolution

The bridge should support four reference modes:

- `none`
- `current_message`
- `quoted_message`
- `explicit`
- `last_generated`

Resolution order should be explicit and deterministic.

Recommended policy:

1. If the tool input explicitly sets `referenceMode`, follow it.
2. If the user asks to continue or modify the previous generated image, use `last_generated`.
3. If the current message contains exactly one image, prefer `current_message`.
4. If the current message quotes a message with one image, allow `quoted_message`.
5. If multiple candidate sources exist and no explicit mode is given, return a validation error instead of guessing.

## Pre-Chat Context Injection

Add `chatluna/before-chat` middleware to inject light-weight image context into the current turn.

The injected block should be small and reference-based, for example:

```text
[AIGC_CONTEXT]
conversationId: xxx
lastGeneratedImage: available
lastPrompt: Generate a cinematic portrait with neon lighting
stylePreset: none
instruction: If the user asks to continue or modify the previous image, prefer aigc_edit_image with referenceMode=last_generated.
[/AIGC_CONTEXT]
```

Also attach structured data to prompt variables, for example:

- `promptVariables.aiGeneratorContext`
- `promptVariables.aiGeneratorContextData`
- `promptVariables.aiGeneratorReferenceRecommendation`

This should be conceptually similar to `aka-lark-center` document grounding, but with image metadata rather than document content.

## Post-Generation Recording

After a successful generation, write records back into `ImageContextStore`.

Each generated image should record:

- the room scope
- the user
- prompt and normalized prompt
- provider and model
- source type
- parent record link if derived from a previous image

This allows later requests such as:

- "continue the previous one"
- "same style but different pose"
- "revert to the image from two turns ago"

The first phase only needs `last_generated`.
More advanced record navigation can come later.

## ChatLuna Room Strategy

### Recommended Deployment Mode

Use ChatLuna configuration like this:

- `autoCreateRoomFromUser = true`
- a default room mode that supports tool calling

Based on the currently checked docs, the configuration page describes:

- `autoCreateRoomFromUser`: create isolated private rooms per user
- `defaultChatMode`: `chat` | `browsing` | `plugin` ...
- `plugin`: a tool-calling agent mode

This is the cleanest environment for image continuity:

- each user gets an isolated creative room
- "previous image" naturally maps to the current room
- different ongoing creative tasks can live in different rooms

### Group Chat Behavior

Group rooms are supported, but less reliable for "previous image" semantics.

For group rooms:

- prefer explicit reference modes when possible
- be more conservative about auto-selecting `last_generated`
- consider requiring quoted messages for follow-up image edits in shared rooms

## Integration with Existing Lark Pipeline

This workspace already has relevant compatibility pieces:

- `aka-adapter-lark` can emit incoming images as `data:` URLs for plugins that do not support `internal:`
- `aka-ai-generator` can already consume Koishi `internal:` URLs through `ctx.http.file()`

This means the upstream image transport problem is already partially solved for Lark usage.

Operational recommendation:

- keep `aka-ai-generator` capable of consuming both `internal:` and `data:` URL images
- use `aka-adapter-lark`'s `incomingImageMode = data-url` only when the broader ChatLuna path cannot safely carry `internal:` references
- do not force `data-url` mode unless necessary, because it increases message processing cost

## Safety and Authorization

The ChatLuna bridge should reuse existing plugin safety rules:

- user quota checks
- rate limit window checks
- existing safety block handling
- admin-only boundaries for privileged operations

Tool authorization should reject unsupported contexts early.

Examples:

- `aigc_edit_image` with `last_generated` but no room history
- `aigc_edit_image` with ambiguous image sources
- `aigc_apply_style_preset` when the preset name does not exist

## Suggested Config Additions

Add optional ChatLuna-facing config fields:

- `chatlunaEnabled: boolean`
- `chatlunaContextInjectionEnabled: boolean`
- `chatlunaExposeQuotaTool: boolean`
- `chatlunaExposeStyleListTool: boolean`
- `chatlunaContextHistorySize: number`
- `chatlunaContextTtlSeconds: number`
- `chatlunaPreferLastGeneratedInPrivateRoom: boolean`

These should default to safe values and should not require ChatLuna to be installed.

## Phased Implementation Plan

### Phase 1: Service Extraction

Goal:

- create `ctx.aiGenerator`
- make command handlers call the service instead of embedding all logic inline

Scope:

- no ChatLuna integration yet
- no behavior change for end users

### Phase 2: ChatLuna Tool Bridge

Goal:

- register image generation tools into ChatLuna

Scope:

- runtime loader
- tool definitions
- basic authorization
- no room context yet beyond direct tool calls

### Phase 3: Room Context Store

Goal:

- track `last_generated` per `conversationId`

Scope:

- write records on successful generations
- clear records on room history reset

### Phase 4: Pre-Chat Context Injection

Goal:

- support natural language follow-up generation requests

Scope:

- `chatluna/before-chat`
- reference recommendation
- `last_generated` guidance block

### Phase 5: Advanced Continuity

Possible additions:

- pinned character reference
- pinned style reference
- branching generation history
- multi-step edit chains
- room-aware video generation

## Open Questions

- The currently checked ChatLuna docs describe tool-calling mode as `plugin` in configuration docs, while some materials historically use `agent`. This should be re-verified against the installed ChatLuna version before implementation.
- If a shared group room frequently triggers ambiguous "previous image" references, we may need a stricter policy for group contexts.
- Some providers may support editing semantics differently. Tool-level descriptions should make capability boundaries explicit.

## Recommended First Deliverable

The smallest high-value implementation should include:

- `AiGeneratorService`
- `aigc_generate_image`
- `aigc_edit_image`
- `ImageContextStore` with `last_generated`
- `chatluna/before-chat` image context injection
- room history cleanup integration

This is enough to unlock both:

- natural-language image generation
- context-aware "continue the previous image" flows

## Implementation Progress

### Refactor Status

The architecture-oriented refactor is now largely complete.

Completed pieces:

- `ctx.aiGenerator` service extraction
- shared config, constants, and type modules
- room-scoped `ImageContextStore`
- image orchestration extraction
- command registration split into image, video, and management modules
- command runtime extraction for video and management flows
- usage reporting and safety-block handling extraction
- built-in ChatLuna bridge structure
- ChatLuna tool registration layer
- ChatLuna tool runtime layer
- ChatLuna room-context injection layer

Representative files now in place:

- `src/service/AiGeneratorService.ts`
- `src/service/UsageReporter.ts`
- `src/core/image-context-store.ts`
- `src/orchestrators/ImageGenerationOrchestrator.ts`
- `src/commands/register-image-commands.ts`
- `src/commands/register-video-commands.ts`
- `src/commands/register-management-commands.ts`
- `src/commands/video-runtime.ts`
- `src/commands/management-runtime.ts`
- `src/bridge/chatluna/manager.ts`
- `src/bridge/chatluna/tools.ts`
- `src/bridge/chatluna/tool-runtime.ts`
- `src/bridge/chatluna/context-injection.ts`

Current structural result:

- `src/index.ts` is primarily an assembly layer
- command modules are separated from command runtime logic
- ChatLuna registration is separated from ChatLuna runtime execution logic
- ChatLuna bridge behavior reads config dynamically instead of holding stale config snapshots

### Current Assessment

The refactor has reached the point of diminishing returns.

This means:

- the major architectural risks from the original single-file structure have already been addressed
- continuing to split files further would bring smaller and smaller returns
- the next highest-value work should be feature completion and validation, not more refactoring for its own sake

There is still some value in targeted cleanup during implementation, especially in these areas:

- further unifying the command path and ChatLuna tool path behind fewer service APIs
- tightening tool result formats and room-context policies based on real usage
- refining larger runtime modules only if feature work reveals concrete complexity

### Recommended Next Phase

The recommended next step is to shift from "architecture refactor" to "feature delivery with targeted cleanup".

Priority order:

1. Finish the ChatLuna image tool path as an end-to-end usable feature.
2. Validate room-scoped `last_generated` behavior in real conversation flow.
3. Only perform additional refactors where feature work reveals a concrete design problem.

In other words:

- do not open another broad refactor-only phase
- continue with implementation and verification
- keep using small, local refactors as support work

## References

ChatLuna docs checked for this design:

- Tool integration: https://chatluna.chat/development/call-core-services/model-tool.html
- ChatLuna plugin API: https://chatluna.chat/development/api-reference/chatluna-plugin.html
- ChatLuna events: https://chatluna.chat/development/api-reference/chatluna-events.html
- Room system: https://chatluna.chat/guide/session-related/room.html
- Room commands: https://chatluna.chat/guide/useful-commands/room.html
- Useful configurations: https://chatluna.chat/guide/useful-configurations.html

Local workspace references that informed this design:

- `plugins/aka-ai-generator/src/index.ts`
- `plugins/aka-ai-generator/src/providers/index.ts`
- `plugins/aka-ai-generator/src/providers/utils.ts`
- `plugins/aka-lark-center/src/bridge/chatluna/tools.ts`
- `plugins/aka-lark-center/src/bridge/chatluna/context-injection.ts`
- `plugins/aka-adapter-lark/src/bot.ts`
