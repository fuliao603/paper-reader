import OpenAI from 'openai'

export const PROVIDER_DEFAULTS = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  'openai-compatible': {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  'anthropic-compatible': {
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-3-5-sonnet-latest',
  },
  custom: {
    baseUrl: '',
    model: '',
  },
}

const LEGACY_PROVIDER_DEFAULTS = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
  },
}

const VALID_PROVIDER_IDS = new Set([
  'deepseek',
  'openai-compatible',
  'anthropic-compatible',
  'custom',
])

function normalizeProviderId(provider) {
  if (provider === 'openrouter') return 'openai-compatible'
  return VALID_PROVIDER_IDS.has(provider) ? provider : 'deepseek'
}

function modelNameLooksMultimodal(model) {
  const normalizedModel = String(model || '').toLowerCase()
  if (!normalizedModel) return false

  return [
    '4o',
    '4.1',
    'gpt-5',
    'o3',
    'o4',
    'vision',
    'vl',
    'gemini',
    'claude-3',
    'claude-sonnet',
    'claude-opus',
    'claude-haiku',
    'llama-4',
    'qwen-vl',
    'kimi-vl',
    'openrouter/auto',
  ].some((token) => normalizedModel.includes(token))
}

function resolveSupportsMultimodal(config = {}) {
  if (config.enableMultimodalTranslation !== true) return false
  if (config.provider === 'deepseek' || config.provider === 'custom') return true
  if (config.provider === 'anthropic-compatible') return modelNameLooksMultimodal(config.model) || !config.model

  return modelNameLooksMultimodal(config.model) || !config.model
}

export function normalizeProviderConfig(config = {}, env = {}) {
  const rawProvider = String(config.provider || env.AI_PROVIDER || '').trim()
  const provider = normalizeProviderId(rawProvider)
  const legacyDefaults = LEGACY_PROVIDER_DEFAULTS[rawProvider]
  const defaults = legacyDefaults || PROVIDER_DEFAULTS[provider]

  return {
    provider,
    providerKey: rawProvider || provider,
    apiKey:
      config.apiKey ||
      config.deepseekApiKey ||
      env.AI_API_KEY ||
      env.DEEPSEEK_API_KEY ||
      '',
    baseUrl:
      config.baseUrl ||
      config.deepseekBaseUrl ||
      env.AI_BASE_URL ||
      env.DEEPSEEK_BASE_URL ||
      defaults.baseUrl,
    model:
      config.model ||
      config.deepseekModel ||
      env.AI_MODEL ||
      env.DEEPSEEK_MODEL ||
      defaults.model,
    prompt: String(config.prompt || env.AI_TRANSLATION_PROMPT || '').trim(),
    enableMultimodalTranslation: config.enableMultimodalTranslation === true,
  }
}

export function getProviderErrorMessage(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.error?.message ||
    error?.message ||
    'AI provider request failed. Check API Key, Base URL, model ID, account balance, and provider permissions.'
  )
}

function extractOpenAiResponseText(messageContent) {
  if (typeof messageContent === 'string') return messageContent.trim()
  if (!Array.isArray(messageContent)) return ''

  return messageContent
    .map((item) => (typeof item?.text === 'string' ? item.text : ''))
    .join('\n')
    .trim()
}

function extractAnthropicResponseText(content) {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''

  return content
    .map((item) => (item?.type === 'text' && typeof item.text === 'string' ? item.text : ''))
    .join('\n')
    .trim()
}

function isInvalidMultimodalOutputText(text) {
  const normalizedText = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase()

  if (!normalizedText) return true

  return [
    '请提供完整句子',
    '请提供完整英文文本',
    '请提供需要翻译',
    '请重新上传',
    '无法识别',
    '无法进行翻译',
    '无法翻译',
    '未提供英文文本',
    'provide the complete',
    'provide complete',
    'please provide',
    'please upload',
    'cannot identify',
    'cannot recognize',
    'unable to recognize',
    'unable to translate',
    'no translatable text',
  ].some((pattern) => normalizedText.includes(pattern))
}

function parseMultimodalLayoutJson(rawText) {
  const text = String(rawText || '').trim()
  if (!text || isInvalidMultimodalOutputText(text)) {
    throw new Error('多模态模型返回了无效说明，未返回可解析的版面 JSON')
  }

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const jsonText = fencedMatch ? fencedMatch[1].trim() : text

  try {
    return JSON.parse(jsonText)
  } catch {
    const objectMatch = jsonText.match(/\{[\s\S]*\}/)
    if (!objectMatch) throw new Error('多模态模型没有返回有效 JSON')

    try {
      return JSON.parse(objectMatch[0])
    } catch (error) {
      throw new Error(`多模态模型返回的 JSON 无法解析：${error.message}`, { cause: error })
    }
  }
}

function normalizeRectValue(value, total, field) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  if (field !== 'x' && field !== 'y' && number > 0 && number <= 1 && total > 1) return number * total
  if ((field === 'x' || field === 'y') && number >= 0 && number <= 1 && total > 1) return number * total
  return number
}

function getRawMultimodalBbox(item = {}) {
  if (Array.isArray(item.bbox)) {
    const [x, y, width, height] = item.bbox
    return { x, y, width, height }
  }

  return item.bbox || item.box || item.boundingBox || item.rect || item
}

function normalizeMultimodalRect(item = {}, imageWidth = 0, imageHeight = 0) {
  const bbox = getRawMultimodalBbox(item)
  const rawX = bbox.x ?? bbox.left ?? bbox.x0
  const rawY = bbox.y ?? bbox.top ?? bbox.y0
  const rawWidth = bbox.width ?? (
    Number.isFinite(Number(bbox.x1)) && Number.isFinite(Number(rawX))
      ? Number(bbox.x1) - Number(rawX)
      : undefined
  )
  const rawHeight = bbox.height ?? (
    Number.isFinite(Number(bbox.y1)) && Number.isFinite(Number(rawY))
      ? Number(bbox.y1) - Number(rawY)
      : undefined
  )
  const x = normalizeRectValue(rawX, imageWidth, 'x')
  const y = normalizeRectValue(rawY, imageHeight, 'y')
  const width = normalizeRectValue(rawWidth, imageWidth, 'width')
  const height = normalizeRectValue(rawHeight, imageHeight, 'height')

  if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null

  const nextX = Math.max(0, Math.min(x, Math.max(imageWidth - 1, 0)))
  const nextY = Math.max(0, Math.min(y, Math.max(imageHeight - 1, 0)))

  return {
    x: nextX,
    y: nextY,
    width: Math.max(1, Math.min(width, Math.max(imageWidth - nextX, 1))),
    height: Math.max(1, Math.min(height, Math.max(imageHeight - nextY, 1))),
  }
}

function getTextValue(item = {}, fields = []) {
  for (const field of fields) {
    const value = item[field]
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (text) return text
  }

  return ''
}

function getUnionRect(rects) {
  if (!rects.length) return null

  const x0 = Math.min(...rects.map((rect) => rect.x))
  const y0 = Math.min(...rects.map((rect) => rect.y))
  const x1 = Math.max(...rects.map((rect) => rect.x + rect.width))
  const y1 = Math.max(...rects.map((rect) => rect.y + rect.height))

  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

function getRawMultimodalModules(rawValue = {}) {
  if (Array.isArray(rawValue)) return rawValue

  return Array.isArray(rawValue.modules)
    ? rawValue.modules
    : Array.isArray(rawValue.blocks)
      ? rawValue.blocks
      : Array.isArray(rawValue.items)
        ? rawValue.items
        : []
}

function normalizeMultimodalLine(line = {}, lineIndex = 0, imageSize = {}) {
  const rect = normalizeMultimodalRect(line, imageSize.width, imageSize.height)
  const text = getTextValue(line, ['original', 'text', 'sourceText', 'originalText', 'lineText'])
  const translation = getTextValue(line, ['translation', 'translatedText', 'targetText', 'result'])

  if (!rect || !text || isInvalidMultimodalOutputText(text)) return null

  return {
    index: lineIndex,
    lineId: String(line.lineId || line.id || `line-${lineIndex + 1}`),
    text,
    sourceText: text,
    translation: isInvalidMultimodalOutputText(translation) ? '' : translation,
    ...rect,
    confidence: Number(line.confidence) || 100,
  }
}

function validateMultimodalLayout(layout, imageWidth, imageHeight) {
  const declaredWidth = Number(layout?.image?.width)
  const declaredHeight = Number(layout?.image?.height)

  return {
    imageWidth,
    imageHeight,
    declaredWidth: Number.isFinite(declaredWidth) ? declaredWidth : null,
    declaredHeight: Number.isFinite(declaredHeight) ? declaredHeight : null,
    sizeMismatch:
      Number.isFinite(declaredWidth) &&
      Number.isFinite(declaredHeight) &&
      (Math.abs(declaredWidth - imageWidth) > 2 || Math.abs(declaredHeight - imageHeight) > 2),
  }
}

function normalizeMultimodalLayout(rawValue = {}, imageSize = {}) {
  const imageWidth = Number(imageSize.width) || 0
  const imageHeight = Number(imageSize.height) || 0
  const rawModules = getRawMultimodalModules(rawValue)
  const validation = validateMultimodalLayout(rawValue, imageWidth, imageHeight)
  const modules = rawModules
    .map((module, index) => {
      const rawLines = Array.isArray(module?.lines) && module.lines.length ? module.lines : [module]
      const sourceBlocks = rawLines
        .map((line, lineIndex) => normalizeMultimodalLine(line, lineIndex, { width: imageWidth, height: imageHeight }))
        .filter(Boolean)
        .sort((firstLine, secondLine) => firstLine.y - secondLine.y || firstLine.x - secondLine.x)
      const ownRect = normalizeMultimodalRect(module, imageWidth, imageHeight)
      const unionRect = getUnionRect(sourceBlocks)
      const rect = ownRect || unionRect
      const text = getTextValue(module, ['original', 'text', 'sourceText', 'originalText', 'moduleText']) ||
        sourceBlocks.map((line) => line.text).join(' ').trim()
      const translation = getTextValue(module, ['translation', 'translatedText', 'targetText', 'result']) ||
        sourceBlocks.map((line) => line.translation).filter(Boolean).join('\n')

      if (!rect || !text || isInvalidMultimodalOutputText(text)) return null

      return {
        index,
        moduleId: String(module.moduleId || module.id || `m${index + 1}`),
        type: String(module.type || 'text'),
        text,
        sourceText: text,
        translation: isInvalidMultimodalOutputText(translation) ? '' : translation,
        ...rect,
        confidence: Number(module.confidence) || 100,
        sourceBlocks: sourceBlocks.length
          ? sourceBlocks
          : [{ index: 0, lineId: `m${index + 1}-l1`, text, sourceText: text, translation: '', ...rect, confidence: 100 }],
      }
    })
    .filter(Boolean)
    .sort((firstModule, secondModule) => firstModule.y - secondModule.y || firstModule.x - secondModule.x)
    .slice(0, 120)

  return {
    image: {
      width: imageWidth,
      height: imageHeight,
    },
    validation,
    modules,
    blocks: modules,
  }
}

async function completeMissingMultimodalTranslations(provider, blocks, options = {}) {
  const completedBlocks = []

  for (const block of blocks) {
    const sourceBlocks = []

    for (const line of block.sourceBlocks || []) {
      let translation = String(line.translation || '').trim()

      if (!translation || isInvalidMultimodalOutputText(translation)) {
        try {
          const result = await provider.translateText(line.text, { systemPrompt: options.systemPrompt })
          translation = String(result.translation || '').trim()
        } catch {
          translation = ''
        }
      }

      sourceBlocks.push({
        ...line,
        translation: isInvalidMultimodalOutputText(translation) ? '' : translation,
      })
    }

    const lineTranslation = sourceBlocks.map((line) => line.translation).filter(Boolean).join('\n')
    const translation = lineTranslation || block.translation

    if (!translation || isInvalidMultimodalOutputText(translation)) continue

    completedBlocks.push({
      ...block,
      translation,
      sourceBlocks,
    })
  }

  return completedBlocks
}

function parseImageDataUrl(image) {
  const match = String(image || '').match(/^data:(image\/(?:png|jpe?g|webp));base64,([\s\S]+)$/i)
  if (!match) throw new Error('多模态翻译需要有效的图片数据')

  return {
    mediaType: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'),
    base64: match[2],
    dataUrl: String(image),
  }
}

function getImageTranslationPrompt({ mode, imageWidth, imageHeight }) {
  return `你是 OCR layout parser + academic translator。任务是识别这张图片中所有可见英文文本，按视觉模块分组，并把每一行完整翻译成中文。

图片是用户刚框选的原始 OCR 区域，原始像素尺寸为 ${imageWidth} x ${imageHeight}。所有 bbox 必须基于这张原始图片左上角的像素坐标。

只返回可被 JSON.parse 解析的纯 JSON。不要返回 markdown，不要返回解释，不要请求用户提供完整文本，不要说无法翻译。如果句子被截断，也要尽力翻译可见片段。

必须返回这个结构：
{
  "image": {
    "width": ${imageWidth},
    "height": ${imageHeight}
  },
  "modules": [
    {
      "moduleId": "m1",
      "type": "paragraph",
      "bbox": {
        "x": 100,
        "y": 60,
        "width": 600,
        "height": 160
      },
      "lines": [
        {
          "lineId": "m1-l1",
          "original": "visible English line text",
          "translation": "完整自然的中文译文",
          "bbox": {
            "x": 100,
            "y": 60,
            "width": 500,
            "height": 24
          }
        }
      ]
    }
  ]
}

要求：
1. 识别所有可见英文文字模块，按视觉区域分组；模块内 lines 按从上到下、从左到右排序。
2. 每一行都必须有 original、translation、bbox.x、bbox.y、bbox.width、bbox.height。
3. bbox 必须是原始图片像素坐标；不要返回百分比、PDF 坐标、CSS 坐标或缩放后坐标。
4. bbox 不能故意扩大到整个段落；每个 line.bbox 要尽量贴合该行英文原文。
5. 翻译必须完整、自然、符合学术中文表达；保留公式、变量、数字、单位、上下标、化学式、生物学术语和缩写。
6. 忽略纯数字刻度、公式碎片、噪声、已经是中文的内容；但英文标签、标题、图例、流程图节点文字都要返回。
7. ${mode === 'compare' ? '对照模式使用 line.bbox 逐行覆盖原文，所以每一行 bbox 必须准确。' : '图解模式使用 module.bbox 放置译文标签，所以 module.bbox 必须覆盖该模块所有可见英文行。'}
8. 不要返回“请提供完整句子”“请重新上传”“无法识别”等自然语言说明。`
}

function getImageSystemPrompt(systemPrompt) {
  return `${systemPrompt}

你还需要作为图片 OCR 版面解析与学术翻译助手工作。只返回严格 JSON，不要使用 Markdown，不要解释，不要要求用户提供完整文本。`
}

function getOpenAiHeaders(config) {
  const baseUrl = String(config.baseUrl || '')
  if (config.providerKey !== 'openrouter' && !baseUrl.includes('openrouter.ai')) return undefined

  return {
    'HTTP-Referer': 'https://paper-reader.local',
    'X-Title': 'Paper Reader',
  }
}

function resolveAnthropicMessagesUrl(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/g, '')
  if (!trimmed) return ''
  if (trimmed.endsWith('/messages')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

export class AIProvider {
  constructor(config = {}) {
    this.config = config
    this.provider = config.provider
    this.supportsMultimodal = resolveSupportsMultimodal(config)
  }

  assertTextReady() {
    if (!this.config.apiKey) throw new Error('请先在设置中填写 API Key')
    if (!this.config.model) throw new Error('请先在设置中填写模型名称')
  }

  assertBaseUrlReady() {
    if (!this.config.baseUrl) throw new Error('请先在设置中填写 Base URL')
  }

  assertImageReady(image) {
    this.assertTextReady()
    this.assertBaseUrlReady()
    if (!this.supportsMultimodal) {
      throw new Error('当前模型未启用或不支持多模态图片翻译')
    }

    return parseImageDataUrl(image)
  }

  translateText() {
    throw new Error('AIProvider.translateText is not implemented')
  }

  translateImageOCR() {
    throw new Error('AIProvider.translateImageOCR is not implemented')
  }

  translateImageDiagram() {
    throw new Error('AIProvider.translateImageDiagram is not implemented')
  }
}

export class OpenAICompatibleProvider extends AIProvider {
  getClient() {
    this.assertBaseUrlReady()

    return new OpenAI({
      baseURL: this.config.baseUrl,
      apiKey: this.config.apiKey,
      defaultHeaders: getOpenAiHeaders(this.config),
    })
  }

  async translateText(input, options = {}) {
    this.assertTextReady()
    const text = String(input || '').trim()
    if (!text) throw new Error('text cannot be empty')

    const response = await this.getClient().chat.completions.create({
      model: this.config.model,
      messages: [
        {
          role: 'system',
          content: options.systemPrompt,
        },
        {
          role: 'user',
          content: text,
        },
      ],
      temperature: 0.2,
    })
    const translation = extractOpenAiResponseText(response.choices?.[0]?.message?.content)

    if (!translation) throw new Error('AI provider returned an empty translation.')
    return { translation }
  }

  async translateImageOCR(image, options = {}) {
    return this.translateImageBlocks(image, { ...options, mode: options.mode === 'diagram' ? 'diagram' : 'compare' })
  }

  async translateImageDiagram(image, options = {}) {
    return this.translateImageBlocks(image, { ...options, mode: 'diagram' })
  }

  async translateImageBlocks(image, options = {}) {
    const parsedImage = this.assertImageReady(image)
    const imageWidth = Number(options.imageWidth) || 0
    const imageHeight = Number(options.imageHeight) || 0
    if (!imageWidth || !imageHeight) throw new Error('image size cannot be empty')

    const response = await this.getClient().chat.completions.create({
      model: this.config.model,
      messages: [
        {
          role: 'system',
          content: getImageSystemPrompt(options.systemPrompt),
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: getImageTranslationPrompt({
                mode: options.mode,
                imageWidth,
                imageHeight,
              }),
            },
            {
              type: 'image_url',
              image_url: {
                url: parsedImage.dataUrl,
              },
            },
          ],
        },
      ],
      temperature: 0.1,
    })
    const rawText = extractOpenAiResponseText(response.choices?.[0]?.message?.content)
    const raw = parseMultimodalLayoutJson(rawText)
    const layout = normalizeMultimodalLayout(raw, { width: imageWidth, height: imageHeight })
    const blocks = await completeMissingMultimodalTranslations(this, layout.blocks, options)

    if (!blocks.length) throw new Error('多模态模型未返回可用的文字模块')
    return { blocks, raw, layout: { ...layout, modules: blocks, blocks }, supportsMultimodal: this.supportsMultimodal }
  }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {}

export class ClaudeProvider extends AIProvider {
  async callMessages({ systemPrompt, content, temperature = 0.2 }) {
    this.assertTextReady()
    this.assertBaseUrlReady()
    const response = await fetch(resolveAnthropicMessagesUrl(this.config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'Authorization': `Bearer ${this.config.apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 4096,
        temperature,
        system: systemPrompt,
        messages: [
          {
            role: 'user',
            content,
          },
        ],
      }),
    })
    const responseText = await response.text()
    let data

    try {
      data = responseText ? JSON.parse(responseText) : {}
    } catch {
      data = { error: { message: responseText } }
    }

    if (!response.ok) {
      throw new Error(data?.error?.message || data?.message || `Anthropic-compatible provider returned HTTP ${response.status}`)
    }

    return data
  }

  async translateText(input, options = {}) {
    const text = String(input || '').trim()
    if (!text) throw new Error('text cannot be empty')

    const data = await this.callMessages({
      systemPrompt: options.systemPrompt,
      content: text,
      temperature: 0.2,
    })
    const translation = extractAnthropicResponseText(data.content)

    if (!translation) throw new Error('AI provider returned an empty translation.')
    return { translation }
  }

  async translateImageOCR(image, options = {}) {
    return this.translateImageBlocks(image, { ...options, mode: options.mode === 'diagram' ? 'diagram' : 'compare' })
  }

  async translateImageDiagram(image, options = {}) {
    return this.translateImageBlocks(image, { ...options, mode: 'diagram' })
  }

  async translateImageBlocks(image, options = {}) {
    const parsedImage = this.assertImageReady(image)
    const imageWidth = Number(options.imageWidth) || 0
    const imageHeight = Number(options.imageHeight) || 0
    if (!imageWidth || !imageHeight) throw new Error('image size cannot be empty')

    const data = await this.callMessages({
      systemPrompt: getImageSystemPrompt(options.systemPrompt),
      content: [
        {
          type: 'text',
          text: getImageTranslationPrompt({
            mode: options.mode,
            imageWidth,
            imageHeight,
          }),
        },
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: parsedImage.mediaType,
            data: parsedImage.base64,
          },
        },
      ],
      temperature: 0.1,
    })
    const rawText = extractAnthropicResponseText(data.content)
    const raw = parseMultimodalLayoutJson(rawText)
    const layout = normalizeMultimodalLayout(raw, { width: imageWidth, height: imageHeight })
    const blocks = await completeMissingMultimodalTranslations(this, layout.blocks, options)

    if (!blocks.length) throw new Error('多模态模型未返回可用的文字模块')
    return { blocks, raw, layout: { ...layout, modules: blocks, blocks }, supportsMultimodal: this.supportsMultimodal }
  }
}

class CustomProvider extends OpenAICompatibleProvider {}

export class ProviderRouter {
  static create(config = {}) {
    switch (config.provider) {
      case 'deepseek':
        return new DeepSeekProvider(config)
      case 'anthropic-compatible':
        return new ClaudeProvider(config)
      case 'custom':
        return new CustomProvider(config)
      case 'openai-compatible':
      default:
        return new OpenAICompatibleProvider(config)
    }
  }
}
