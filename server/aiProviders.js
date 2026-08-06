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
  glm: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: '',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: '',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: '',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    model: '',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
  },
  siliconflow: {
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: '',
  },
  custom: {
    baseUrl: '',
    model: '',
  },
}

const VALID_PROVIDER_IDS = new Set([
  'deepseek',
  'openai-compatible',
  'anthropic-compatible',
  'glm',
  'gemini',
  'qwen',
  'kimi',
  'openrouter',
  'siliconflow',
  'custom',
])

const generationOptionsCache = new Map()
const DEFAULT_CUSTOM_TEMPERATURE = 0.2

function normalizeProviderId(provider) {
  return VALID_PROVIDER_IDS.has(provider) ? provider : 'deepseek'
}

function normalizeTemperature(value, fallback = DEFAULT_CUSTOM_TEMPERATURE) {
  const temperature = Number(value)
  return Number.isFinite(temperature)
    ? Math.max(0, Math.min(2, temperature))
    : fallback
}

function resolveSupportsMultimodal(config = {}) {
  if (config.enableMultimodalTranslation !== true) return false
  return true
}

export function normalizeProviderConfig(config = {}, env = {}) {
  const rawProvider = String(config.provider || env.AI_PROVIDER || '').trim()
  const provider = normalizeProviderId(rawProvider)
  const defaults = PROVIDER_DEFAULTS[provider]
  const environmentTemperature = String(env.AI_TEMPERATURE ?? '').trim()
  const temperatureMode =
    config.temperatureMode === 'custom' || environmentTemperature
      ? 'custom'
      : 'auto'

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
    modelSupportsMultimodal:
      typeof config.modelSupportsMultimodal === 'boolean'
        ? config.modelSupportsMultimodal
        : null,
    prompt: String(config.prompt || env.AI_TRANSLATION_PROMPT || '').trim(),
    enableMultimodalTranslation: config.enableMultimodalTranslation === true,
    temperatureMode,
    temperature: normalizeTemperature(
      config.temperature ?? environmentTemperature,
    ),
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

function getGenerationCacheKey(config, endpoint) {
  return [
    config.provider,
    String(config.baseUrl || '').replace(/\/+$/g, '').toLowerCase(),
    String(config.model || '').trim().toLowerCase(),
    endpoint,
  ].join('|')
}

function getKnownGenerationOptions(config) {
  const provider = String(config.provider || '').toLowerCase()
  const model = String(config.model || '').trim().toLowerCase()

  if (provider === 'kimi' && /^kimi-k2\.6(?:$|[-:])/.test(model)) {
    return { temperature: 1 }
  }

  return {}
}

function resolveGenerationOptions(config, endpoint) {
  if (config.temperatureMode === 'custom') {
    return { temperature: normalizeTemperature(config.temperature) }
  }

  const cacheKey = getGenerationCacheKey(config, endpoint)
  if (generationOptionsCache.has(cacheKey)) {
    return { ...generationOptionsCache.get(cacheKey) }
  }

  return getKnownGenerationOptions(config)
}

function getTemperatureRetryOptions(error, attemptedOptions) {
  const message = getProviderErrorMessage(error)
  if (!/\btemperature\b/i.test(message)) return null

  const exactValueMatch =
    message.match(
      /\bonly\s+(?:the\s+default\s*)?\(?(-?\d+(?:\.\d+)?)\)?\s+(?:is\s+)?(?:allowed|supported)/i,
    ) ||
    message.match(
      /\btemperature\b[\s\S]{0,100}?\bmust(?:\s+be|\s+equal\s+to)?\s+(-?\d+(?:\.\d+)?)/i,
    )

  if (exactValueMatch) {
    const requiredTemperature = normalizeTemperature(exactValueMatch[1], Number.NaN)
    if (
      Number.isFinite(requiredTemperature) &&
      attemptedOptions.temperature !== requiredTemperature
    ) {
      return { temperature: requiredTemperature }
    }
  }

  if (
    Object.hasOwn(attemptedOptions, 'temperature') &&
    /(?:unsupported|not supported|unknown|unrecognized|not allowed)[\s\S]{0,80}\btemperature\b|\btemperature\b[\s\S]{0,80}(?:unsupported|not supported|unknown|unrecognized|not allowed)/i.test(
      message,
    )
  ) {
    return {}
  }

  return null
}

async function requestWithAdaptiveGenerationOptions(
  config,
  endpoint,
  createRequest,
) {
  const initialOptions = resolveGenerationOptions(config, endpoint)

  try {
    return await createRequest(initialOptions)
  } catch (error) {
    if (config.temperatureMode === 'custom') throw error

    const retryOptions = getTemperatureRetryOptions(error, initialOptions)
    if (!retryOptions) throw error

    const result = await createRequest(retryOptions)
    generationOptionsCache.set(
      getGenerationCacheKey(config, endpoint),
      { ...retryOptions },
    )
    return result
  }
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

function normalizeMultimodalConfidence(value, fallback = 100) {
  const confidence = Number(value)
  return Number.isFinite(confidence)
    ? Math.max(0, Math.min(100, confidence))
    : fallback
}

function normalizeMultimodalFormulaRegions(item = {}, imageSize = {}) {
  const regions = Array.isArray(item.formulaRegions)
    ? item.formulaRegions
    : Array.isArray(item.formula_regions)
      ? item.formula_regions
      : Array.isArray(item.inlineFormulas)
        ? item.inlineFormulas
        : []

  return regions
    .map((region, index) => {
      const rect = normalizeMultimodalRect(region, imageSize.width, imageSize.height)
      const text = getTextValue(region, ['original', 'text', 'sourceText', 'formula'])
      if (!rect || !text) return null

      return {
        id: String(region.id || region.formulaId || `formula-${index + 1}`),
        type: String(region.type || 'inline_formula'),
        text,
        latex: String(region.latex || region.tex || '').trim(),
        confidence: normalizeMultimodalConfidence(region.confidence),
        ...rect,
      }
    })
    .filter(Boolean)
}

function normalizeMultimodalLine(line = {}, lineIndex = 0, imageSize = {}) {
  const rect = normalizeMultimodalRect(line, imageSize.width, imageSize.height)
  const text = getTextValue(line, ['original', 'text', 'sourceText', 'originalText', 'lineText'])
  const translation = getTextValue(line, ['translation', 'translatedText', 'targetText', 'result'])

  if (!rect || !text || isInvalidMultimodalOutputText(text)) return null

  return {
    index: lineIndex,
    lineId: String(line.lineId || line.id || `line-${lineIndex + 1}`),
    type: String(line.type || line.contentType || 'text'),
    text,
    sourceText: text,
    translation: isInvalidMultimodalOutputText(translation) ? '' : translation,
    latex: String(line.latex || line.tex || '').trim(),
    symbolDensity: Math.max(0, Math.min(1, Number(line.symbolDensity || line.symbol_density) || 0)),
    formulaRegions: normalizeMultimodalFormulaRegions(line, imageSize),
    ...rect,
    fontSize: Math.max(
      1,
      Number(line.fontSize || line.font_size || line.font?.size) || rect.height * 0.82,
    ),
    confidence: normalizeMultimodalConfidence(line.confidence),
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

function normalizeMultimodalLayout(rawValue = {}, imageSize = {}, options = {}) {
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
        latex: String(module.latex || module.tex || '').trim(),
        symbolDensity: Math.max(0, Math.min(1, Number(module.symbolDensity || module.symbol_density) || 0)),
        formulaRegions: normalizeMultimodalFormulaRegions(module, {
          width: imageWidth,
          height: imageHeight,
        }),
        ...rect,
        confidence: normalizeMultimodalConfidence(module.confidence),
        sourceBlocks: sourceBlocks.length
          ? sourceBlocks
          : [{
              index: 0,
              lineId: `m${index + 1}-l1`,
              text,
              sourceText: text,
              translation: '',
              ...rect,
              fontSize: Math.max(1, Number(module.fontSize || module.font_size) || rect.height * 0.82),
              confidence: 100,
            }],
      }
    })
    .filter(Boolean)
    .sort((firstModule, secondModule) => firstModule.y - secondModule.y || firstModule.x - secondModule.x)
    .slice(0, options.mode === 'diagram' ? rawModules.length : 120)

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

function parseImageDataUrl(image) {
  const match = String(image || '').match(/^data:(image\/(?:png|jpe?g|webp));base64,([\s\S]+)$/i)
  if (!match) throw new Error('多模态翻译需要有效的图片数据')

  return {
    mediaType: match[1].toLowerCase().replace('image/jpg', 'image/jpeg'),
    base64: match[2],
    dataUrl: String(image),
  }
}

function getImageTranslationPrompt({ mode, imageWidth, imageHeight, reviewContext }) {
  const modeInstruction = mode === 'diagram'
    ? '图解模式：独立标题、图例项、流程节点和短标签必须分别成块；相邻但不属于同一文本框的文字不得合并。'
    : mode === 'compare'
      ? '对照模式：按语义段落或标签分模块，但每一条实际文字行都必须独立写入 lines，不能用一个大框代替多行坐标。'
      : mode === 'selection'
        ? '划词模式：图片由用户划选的文字行纵向拼接而成，只识别实际可见内容。'
        : '文本模式：按正常阅读顺序识别框选区域内全部可见内容。'
  const reviewInstruction = reviewContext
    ? `
这是一次边界复核（第 ${reviewContext.attempt} 次，失败原因：${reviewContext.reason || 'boundary-invalid'}）。
目标模块和相邻模块在当前裁剪图中的位置如下：
${JSON.stringify({
    targetModule: reviewContext.targetModule,
    neighborModules: reviewContext.neighborModules,
  })}
只返回目标区域校正后的模块。判断目标是漏掉了相邻文字，还是错误合并了多个模块；不要把仅用于参照的无关相邻模块重复返回。`
    : ''

  return `你是学术文献的视觉版面识别器。你只负责识别图片中的文字结构、类型和像素坐标，不翻译、不改写、不总结、不补全被截断的句子。

当前图片尺寸为 ${imageWidth} x ${imageHeight}，坐标原点位于左上角。${reviewInstruction}
${modeInstruction}

只返回可由 JSON.parse 解析的纯 JSON：
{
  "image": {"width": ${imageWidth}, "height": ${imageHeight}},
  "modules": [
    {
      "moduleId": "m1",
      "type": "paragraph",
      "original": "complete visible source text",
      "confidence": 96,
      "symbolDensity": 0.08,
      "bbox": {"x": 100, "y": 60, "width": 600, "height": 160},
      "formulaRegions": [
        {
          "id": "f1",
          "type": "inline_formula",
          "original": "E = mc²",
          "latex": "E = mc^2",
          "confidence": 91,
          "bbox": {"x": 260, "y": 92, "width": 88, "height": 24}
        }
      ],
      "lines": [
        {
          "lineId": "m1-l1",
          "type": "text",
          "original": "visible source line",
          "fontSize": 22,
          "confidence": 97,
          "symbolDensity": 0.03,
          "bbox": {"x": 100, "y": 60, "width": 500, "height": 27},
          "formulaRegions": []
        }
      ]
    }
  ]
}

模块 type 使用 paragraph、title、label、legend、formula_block、dense_symbol_region 或 noise。
行及公式区域 type 使用 text、inline_formula、formula_block、dense_symbol_region 或 noise。

要求：
1. 返回模块和每一行的原文、置信度、符号密度、像素 bbox 与原文字号；original 中只写实际看见的字符。
2. 模块 bbox 必须覆盖其全部 lines，但不能故意扩展到邻近模块；每行 bbox 必须紧贴该行实际文字。
3. 相邻栏、独立标签、图例项和流程节点不得错误合并；同一文本框中语义连续的自然换行可以合并。
4. 重复出现的视觉文字只返回一次，不得生成重复模块。
5. 整块公式、高符号密度区域和纯符号图例仍需标注类型与 bbox，但不要尝试解释或翻译。
6. 普通文字中的少量公式或可疑符号必须写入 formulaRegions；其 bbox 使用当前整张图片的像素坐标。
7. 不确定的字符不要猜测，保留能确认的可见字符并降低 confidence。
8. 不返回 translation 字段，不返回 Markdown，不返回任何说明文字。`
}

function getImageSystemPrompt() {
  return '你只作为学术文献图片的视觉 OCR 与版面结构识别器工作，不执行翻译。只返回严格 JSON，不使用 Markdown，不解释，不补全不可见内容。'
}

function getOpenAiHeaders(config) {
  const baseUrl = String(config.baseUrl || '')
  if (config.provider !== 'openrouter' && !baseUrl.includes('openrouter.ai')) return undefined

  return {
    'HTTP-Referer': 'https://paper-reader.local',
    'X-Title': 'Paper Reader',
  }
}

function appendBaseUrlPath(baseUrl, pathName) {
  const trimmed = String(baseUrl || '').replace(/\/+$/g, '')
  if (!trimmed) return ''
  return `${trimmed}/${String(pathName || '').replace(/^\/+/g, '')}`
}

function resolveAnthropicMessagesUrl(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/g, '')
  if (!trimmed) return ''
  if (trimmed.endsWith('/messages')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/messages`
  return `${trimmed}/v1/messages`
}

function resolveAnthropicModelsUrl(baseUrl) {
  const trimmed = String(baseUrl || '').replace(/\/+$/g, '')
  if (!trimmed) return ''
  if (trimmed.endsWith('/models')) return trimmed
  if (trimmed.endsWith('/v1')) return `${trimmed}/models`
  return `${trimmed}/v1/models`
}

function resolveOpenAiModelsUrl(config = {}) {
  const baseUrl = String(config.baseUrl || '').replace(/\/+$/g, '')
  if (!baseUrl) return ''
  if (baseUrl.endsWith('/models') || baseUrl.endsWith('/models/user')) return baseUrl
  if (config.provider === 'openrouter' && baseUrl.includes('openrouter.ai')) {
    return appendBaseUrlPath(baseUrl, 'models/user')
  }
  if (config.provider === 'siliconflow' && baseUrl.includes('siliconflow')) {
    return `${appendBaseUrlPath(baseUrl, 'models')}?type=text&sub_type=chat`
  }
  return appendBaseUrlPath(baseUrl, 'models')
}

function isLikelyChatModel(model = {}) {
  const id = String(model.id || model.model || '').trim().toLowerCase()
  if (!id) return false

  const modelType = String(model.type || model.sub_type || model.object_type || '').toLowerCase()
  if (['embedding', 'reranker', 'image', 'audio', 'video'].includes(modelType)) return false

  const outputModalities =
    model.architecture?.output_modalities ||
    model.output_modalities ||
    model.outputModalities
  if (Array.isArray(outputModalities) && outputModalities.length && !outputModalities.includes('text')) {
    return false
  }

  return ![
    'embedding',
    'rerank',
    'moderation',
    'whisper',
    'transcribe',
    'speech',
    'text-to-speech',
    'tts-',
    'realtime',
    'dall-e',
    'sora',
    'stable-diffusion',
    'text-to-image',
    'image-generation',
    'text-to-video',
  ].some((token) => id.includes(token))
}

function getModelInputModalities(model = {}) {
  const candidates = [
    model.architecture?.input_modalities,
    model.input_modalities,
    model.inputModalities,
    model.capabilities?.input_modalities,
    model.capabilities?.inputModalities,
    model.modalities?.input,
  ]
  const modalities = candidates.find(Array.isArray) || []

  return Array.from(new Set(
    modalities
      .map((modality) => String(modality || '').trim().toLowerCase())
      .filter(Boolean),
  ))
}

function normalizeModelList(rawValue) {
  const rawModels = Array.isArray(rawValue)
    ? rawValue
    : Array.isArray(rawValue?.data)
      ? rawValue.data
      : Array.isArray(rawValue?.models)
        ? rawValue.models
        : []
  const modelsById = new Map()

  rawModels.forEach((rawModel) => {
    const model = typeof rawModel === 'string' ? { id: rawModel } : rawModel
    if (!model || !isLikelyChatModel(model)) return

    const id = String(model.id || model.model || '').trim()
    if (!id || modelsById.has(id)) return
    const inputModalities = getModelInputModalities(model)

    modelsById.set(id, {
      id,
      name: String(model.name || model.display_name || model.displayName || '').trim(),
      ownedBy: String(model.owned_by || model.ownedBy || '').trim(),
      inputModalities,
      supportsMultimodal:
        inputModalities.length > 0
          ? inputModalities.some((modality) =>
              modality === 'image' || modality === 'vision' || modality === 'multimodal',
            )
          : null,
    })
  })

  return Array.from(modelsById.values())
    .sort((firstModel, secondModel) =>
      firstModel.id.localeCompare(secondModel.id, undefined, {
        numeric: true,
        sensitivity: 'base',
      }),
    )
    .slice(0, 1000)
}

async function requestModelList(url, headers) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 15000)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
    const responseText = await response.text()
    let data

    try {
      data = responseText ? JSON.parse(responseText) : {}
    } catch {
      data = { error: { message: responseText } }
    }

    if (!response.ok) {
      throw new Error(
        data?.error?.message ||
        data?.message ||
        `模型列表接口返回 HTTP ${response.status}`,
      )
    }

    return normalizeModelList(data)
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('获取模型列表超时', { cause: error })
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
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

  assertModelListReady() {
    if (!this.config.apiKey) throw new Error('请先在设置中填写 API Key')
    this.assertBaseUrlReady()
  }

  assertImageReady(image) {
    this.assertTextReady()
    this.assertBaseUrlReady()
    if (!this.supportsMultimodal) {
      throw new Error('当前模型未启用或不支持多模态图片翻译')
    }

    return parseImageDataUrl(image)
  }

  requestWithGenerationOptions(endpoint, createRequest) {
    return requestWithAdaptiveGenerationOptions(
      this.config,
      endpoint,
      createRequest,
    )
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

  listModels() {
    throw new Error('AIProvider.listModels is not implemented')
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

    const messages = [
      {
        role: 'system',
        content: options.systemPrompt,
      },
      {
        role: 'user',
        content: text,
      },
    ]
    const response = await this.requestWithGenerationOptions(
      'openai-chat',
      (generationOptions) => this.getClient().chat.completions.create({
        model: this.config.model,
        messages,
        ...generationOptions,
      }),
    )
    const translation = extractOpenAiResponseText(response.choices?.[0]?.message?.content)

    if (!translation) throw new Error('AI provider returned an empty translation.')
    return { translation }
  }

  async listModels() {
    this.assertModelListReady()
    return requestModelList(resolveOpenAiModelsUrl(this.config), {
      'Authorization': `Bearer ${this.config.apiKey}`,
      ...getOpenAiHeaders(this.config),
    })
  }

  async translateImageOCR(image, options = {}) {
    const mode = ['selection', 'text', 'compare'].includes(options.mode) ? options.mode : 'compare'
    return this.translateImageBlocks(image, { ...options, mode })
  }

  async translateImageDiagram(image, options = {}) {
    return this.translateImageBlocks(image, { ...options, mode: 'diagram' })
  }

  async translateImageBlocks(image, options = {}) {
    const parsedImage = this.assertImageReady(image)
    const imageWidth = Number(options.imageWidth) || 0
    const imageHeight = Number(options.imageHeight) || 0
    if (!imageWidth || !imageHeight) throw new Error('image size cannot be empty')

    const messages = [
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
              reviewContext: options.reviewContext,
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
    ]
    const response = await this.requestWithGenerationOptions(
      'openai-chat',
      (generationOptions) => this.getClient().chat.completions.create({
        model: this.config.model,
        messages,
        ...generationOptions,
      }),
    )
    const rawText = extractOpenAiResponseText(response.choices?.[0]?.message?.content)
    const raw = parseMultimodalLayoutJson(rawText)
    const layout = normalizeMultimodalLayout(raw, { width: imageWidth, height: imageHeight }, options)
    const blocks = layout.blocks

    if (!blocks.length) throw new Error('多模态模型未返回可用的文字模块')
    return { blocks, raw, layout: { ...layout, modules: blocks, blocks }, supportsMultimodal: this.supportsMultimodal }
  }
}

export class DeepSeekProvider extends OpenAICompatibleProvider {}

export class ClaudeProvider extends AIProvider {
  async callMessages({ systemPrompt, content }) {
    this.assertTextReady()
    this.assertBaseUrlReady()
    return this.requestWithGenerationOptions(
      'anthropic-messages',
      async (generationOptions) => {
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
            ...generationOptions,
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
      },
    )
  }

  async translateText(input, options = {}) {
    const text = String(input || '').trim()
    if (!text) throw new Error('text cannot be empty')

    const data = await this.callMessages({
      systemPrompt: options.systemPrompt,
      content: text,
    })
    const translation = extractAnthropicResponseText(data.content)

    if (!translation) throw new Error('AI provider returned an empty translation.')
    return { translation }
  }

  async listModels() {
    this.assertModelListReady()
    return requestModelList(resolveAnthropicModelsUrl(this.config.baseUrl), {
      'x-api-key': this.config.apiKey,
      'Authorization': `Bearer ${this.config.apiKey}`,
      'anthropic-version': '2023-06-01',
    })
  }

  async translateImageOCR(image, options = {}) {
    const mode = ['selection', 'text', 'compare'].includes(options.mode) ? options.mode : 'compare'
    return this.translateImageBlocks(image, { ...options, mode })
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
            reviewContext: options.reviewContext,
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
    })
    const rawText = extractAnthropicResponseText(data.content)
    const raw = parseMultimodalLayoutJson(rawText)
    const layout = normalizeMultimodalLayout(raw, { width: imageWidth, height: imageHeight }, options)
    const blocks = layout.blocks

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
