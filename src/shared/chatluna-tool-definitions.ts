export interface AiGeneratorToolDefinition {
  name: string
  description: string
  usage: string
  riskLevel: 'low' | 'medium' | 'high'
  inputSchema: Record<string, unknown>
}

export const AI_GENERATOR_TOOL_DEFINITIONS: AiGeneratorToolDefinition[] = [
  {
    name: 'aigc_generate_image',
    description: 'Generate one or more images from a natural-language prompt.',
    usage: 'Use this for pure text-to-image requests. Prefer this when the user asks to generate a fresh image without referencing an existing one.',
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Image generation prompt.' },
        numImages: { type: 'number', minimum: 1, maximum: 4, description: 'Number of images to generate.' },
        aspectRatio: { type: 'string', enum: ['1:1', '4:3', '16:9', '9:16', '3:2', '2:3'] },
        resolution: { type: 'string', enum: ['1k', '2k', '4k'] },
        modelSuffix: { type: 'string', description: 'Optional configured model suffix.' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'aigc_edit_image',
    description: 'Edit an image using the current message image, quoted image, explicit image URLs, or the last generated image in the current room.',
    usage: 'Use this when the user wants to modify an uploaded image, continue the previous generated image, or preserve the same subject while changing details.',
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Editing prompt.' },
        referenceMode: {
          type: 'string',
          enum: ['current_message', 'quoted_message', 'explicit', 'last_generated'],
          description: 'Where to load reference images from.',
        },
        imageUrls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit image URLs when referenceMode is explicit.',
        },
        numImages: { type: 'number', minimum: 1, maximum: 4, description: 'Number of images to generate.' },
        aspectRatio: { type: 'string', enum: ['1:1', '4:3', '16:9', '9:16', '3:2', '2:3'] },
        resolution: { type: 'string', enum: ['1k', '2k', '4k'] },
        modelSuffix: { type: 'string', description: 'Optional configured model suffix.' },
      },
      required: ['prompt', 'referenceMode'],
      additionalProperties: false,
    },
  },
  {
    name: 'aigc_apply_style_preset',
    description: 'Apply a configured style preset to either a fresh generation or a referenced image.',
    usage: 'Use this when a configured style command matches the user request better than free-form prompt writing.',
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {
        stylePreset: { type: 'string', description: 'Configured style command name.' },
        styleQuery: { type: 'string', description: 'Natural-language style lookup query when the exact preset name is unknown.' },
        promptAdditions: { type: 'string', description: 'Optional extra prompt details.' },
        referenceMode: {
          type: 'string',
          enum: ['none', 'current_message', 'quoted_message', 'explicit', 'last_generated'],
          description: 'Where to load reference images from.',
        },
        imageUrls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit image URLs when referenceMode is explicit.',
        },
        numImages: { type: 'number', minimum: 1, maximum: 4, description: 'Number of images to generate.' },
        aspectRatio: { type: 'string', enum: ['1:1', '4:3', '16:9', '9:16', '3:2', '2:3'] },
        resolution: { type: 'string', enum: ['1k', '2k', '4k'] },
        modelSuffix: { type: 'string', description: 'Optional configured model suffix.' },
      },
      anyOf: [
        { required: ['stylePreset'] },
        { required: ['styleQuery'] },
      ],
      additionalProperties: false,
    },
  },
  {
    name: 'aigc_get_quota',
    description: 'Get the current user quota summary for image generation.',
    usage: 'Use this when the user asks how many image credits or free generations remain.',
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'aigc_list_styles',
    description: 'List configured style presets exposed by aka-ai-generator.',
    usage: 'Use this when the user asks what style presets are available.',
    riskLevel: 'low',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
]
