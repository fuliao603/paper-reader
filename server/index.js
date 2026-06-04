/* global process */

import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import OpenAI from 'openai'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const envPath = process.env.PAPER_READER_ENV_PATH || path.resolve(process.cwd(), '.env')
const defaultTranslationPrompt =
  '你是通用学术翻译助手。请把用户提供的英文学术文本翻译成准确、自然、符合中文学术表达习惯的中文。保留必要的专业术语、英文缩写、公式、指数、上下标、单位、变量名和专有名词。遇到 10^16、10^{-6}、H_2O、CO_2 等表达时，不要改写成普通数字。不要扩写，不要总结，不要添加解释，只输出译文。'
const maxGlossaryEntries = 200
const maxGlossaryPromptLength = 8000
const providerDefaults = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openrouter/auto',
  },
  custom: {
    baseUrl: '',
    model: '',
  },
}

dotenv.config({ path: envPath })

function readElectronConfig() {
  if (!process.env.PAPER_READER_CONFIG_PATH) {
    return { config: null, error: null }
  }

  try {
    if (!fs.existsSync(process.env.PAPER_READER_CONFIG_PATH)) {
      return { config: null, error: null }
    }

    const rawConfig = fs.readFileSync(process.env.PAPER_READER_CONFIG_PATH, 'utf8')
    return { config: JSON.parse(rawConfig), error: null }
  } catch (error) {
    return { config: null, error: `读取 AI 模型配置失败：${error.message}` }
  }
}

function readGlossary() {
  if (!process.env.PAPER_READER_GLOSSARY_PATH) return []

  try {
    if (!fs.existsSync(process.env.PAPER_READER_GLOSSARY_PATH)) return []

    const rawGlossary = fs.readFileSync(process.env.PAPER_READER_GLOSSARY_PATH, 'utf8')
    const glossary = JSON.parse(rawGlossary)

    if (!Array.isArray(glossary)) return []

    return glossary
      .map((entry) => ({
        source: String(entry.source || '').trim(),
        target: String(entry.target || '').trim(),
      }))
      .filter((entry) => entry.source && entry.target)
  } catch (error) {
    console.error(`读取术语库失败：${error.message}`)
    return []
  }
}

function normalizeProvider(provider) {
  return ['deepseek', 'openrouter', 'custom'].includes(provider) ? provider : 'deepseek'
}

function normalizeConfig(config = {}) {
  const provider = normalizeProvider(config.provider || process.env.AI_PROVIDER)
  const defaults = providerDefaults[provider]

  return {
    provider,
    apiKey:
      config.apiKey ||
      config.deepseekApiKey ||
      process.env.AI_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      '',
    baseUrl:
      config.baseUrl ||
      config.deepseekBaseUrl ||
      process.env.AI_BASE_URL ||
      process.env.DEEPSEEK_BASE_URL ||
      defaults.baseUrl,
    model:
      config.model ||
      config.deepseekModel ||
      process.env.AI_MODEL ||
      process.env.DEEPSEEK_MODEL ||
      defaults.model,
    prompt: String(config.prompt || process.env.AI_TRANSLATION_PROMPT || '').trim(),
    enableMultimodalTranslation: config.enableMultimodalTranslation === true,
  }
}

function getProviderHeaders(provider) {
  if (provider !== 'openrouter') return undefined

  return {
    'HTTP-Referer': 'https://paper-reader.local',
    'X-Title': 'Paper Reader',
  }
}

function getAiConfig() {
  const { config, error } = readElectronConfig()

  return { ...normalizeConfig(config || {}), error }
}

function buildGlossaryPrompt(glossary) {
  if (!glossary.length) return ''

  const lines = [
    '',
    '以下是用户术语库。翻译时请优先使用这些固定译法：',
  ]
  let currentLength = lines.join('\n').length

  glossary.slice(0, maxGlossaryEntries).some((entry) => {
    const line = `- ${entry.source} => ${entry.target}`
    const nextLength = currentLength + line.length + 1

    if (nextLength > maxGlossaryPromptLength) return true

    lines.push(line)
    currentLength = nextLength
    return false
  })

  lines.push('如果术语库与上下文冲突，请优先保证译文准确，但尽量遵循术语库。')

  return lines.join('\n')
}

function buildSystemPrompt(config) {
  const basePrompt = config.prompt || defaultTranslationPrompt
  const glossaryPrompt = buildGlossaryPrompt(readGlossary())

  return `${basePrompt}${glossaryPrompt}`
}

function extractResponseText(messageContent) {
  if (typeof messageContent === 'string') return messageContent
  if (!Array.isArray(messageContent)) return ''

  return messageContent
    .map((item) => (typeof item?.text === 'string' ? item.text : ''))
    .join('\n')
    .trim()
}

function parseJsonResponse(rawText) {
  const text = String(rawText || '').trim()
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const jsonText = fencedMatch ? fencedMatch[1].trim() : text

  try {
    return JSON.parse(jsonText)
  } catch {
    const objectMatch = jsonText.match(/\{[\s\S]*\}/)
    if (objectMatch) return JSON.parse(objectMatch[0])
    throw new Error('多模态模型没有返回有效 JSON')
  }
}

function normalizeRectValue(value, total) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  if (number >= 0 && number <= 1 && total > 1) return number * total
  return number
}

function normalizeMultimodalRect(item = {}, imageWidth = 0, imageHeight = 0) {
  const rawX = item.x ?? item.left ?? item.x0
  const rawY = item.y ?? item.top ?? item.y0
  const rawWidth = item.width ?? (Number.isFinite(Number(item.x1)) && Number.isFinite(Number(rawX)) ? Number(item.x1) - Number(rawX) : undefined)
  const rawHeight = item.height ?? (Number.isFinite(Number(item.y1)) && Number.isFinite(Number(rawY)) ? Number(item.y1) - Number(rawY) : undefined)
  const x = normalizeRectValue(rawX, imageWidth)
  const y = normalizeRectValue(rawY, imageHeight)
  const width = normalizeRectValue(rawWidth, imageWidth)
  const height = normalizeRectValue(rawHeight, imageHeight)

  if (![x, y, width, height].every(Number.isFinite) || width <= 1 || height <= 1) return null

  return {
    x: Math.max(0, Math.min(x, Math.max(imageWidth - 1, 0))),
    y: Math.max(0, Math.min(y, Math.max(imageHeight - 1, 0))),
    width: Math.max(1, Math.min(width, Math.max(imageWidth - Math.max(0, x), 1))),
    height: Math.max(1, Math.min(height, Math.max(imageHeight - Math.max(0, y), 1))),
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

function normalizeMultimodalBlocks(rawValue = {}, imageSize = {}) {
  const imageWidth = Number(imageSize.width) || 0
  const imageHeight = Number(imageSize.height) || 0
  const rawBlocks = Array.isArray(rawValue.blocks)
    ? rawValue.blocks
    : Array.isArray(rawValue.modules)
      ? rawValue.modules
      : Array.isArray(rawValue.items)
        ? rawValue.items
        : []

  return rawBlocks
    .map((block, index) => {
      const rawLines = Array.isArray(block?.lines) ? block.lines : []
      const sourceBlocks = rawLines
        .map((line, lineIndex) => {
          const rect = normalizeMultimodalRect(line, imageWidth, imageHeight)
          const text = getTextValue(line, ['text', 'sourceText', 'originalText', 'lineText'])
          if (!rect || !text) return null

          return {
            index: lineIndex,
            text,
            translation: getTextValue(line, ['translation', 'translatedText', 'targetText', 'result']),
            ...rect,
          }
        })
        .filter(Boolean)

      const ownRect = normalizeMultimodalRect(block, imageWidth, imageHeight)
      const unionRect = getUnionRect(sourceBlocks)
      const rect = ownRect || unionRect
      const text = getTextValue(block, ['text', 'sourceText', 'originalText', 'moduleText']) ||
        sourceBlocks.map((line) => line.text).join(' ').trim()
      const translation = getTextValue(block, ['translation', 'translatedText', 'targetText', 'result'])

      if (!rect || !text || !translation) return null

      return {
        index,
        text,
        sourceText: text,
        translation,
        ...rect,
        confidence: Number(block.confidence) || 100,
        sourceBlocks: sourceBlocks.length
          ? sourceBlocks.map((line) => ({
              ...line,
              width: Math.max(1, line.width),
              height: Math.max(1, line.height),
            }))
          : [{ index: 0, text, ...rect, confidence: Number(block.confidence) || 100 }],
      }
    })
    .filter(Boolean)
    .slice(0, 120)
}

async function translateImageWithMultimodalModel({ image, mode, imageWidth, imageHeight }) {
  const aiConfig = getAiConfig()

  if (aiConfig.error) throw new Error(aiConfig.error)
  if (!aiConfig.enableMultimodalTranslation) throw new Error('多模态翻译未启用')
  if (!aiConfig.apiKey) throw new Error('请先在设置中填写 API Key')
  if (!aiConfig.model) throw new Error('请先在设置中填写模型名')
  if (!/^data:image\/(?:png|jpe?g|webp);base64,/i.test(image)) {
    throw new Error('多模态翻译需要有效的图片数据')
  }

  const client = new OpenAI({
    baseURL: aiConfig.baseUrl,
    apiKey: aiConfig.apiKey,
    defaultHeaders: getProviderHeaders(aiConfig.provider),
  })
  const response = await client.chat.completions.create({
    model: aiConfig.model,
    messages: [
      {
        role: 'system',
        content: `${buildSystemPrompt(aiConfig)}

你还需要作为图片文字识别与版面翻译助手工作。只返回严格 JSON，不要使用 Markdown。`,
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `请识别这张图片中的英文文字模块并翻译成中文。图片尺寸为 ${imageWidth} x ${imageHeight} 像素，坐标必须使用这个像素坐标系。

返回 JSON 格式：
{
  "blocks": [
    {
      "text": "模块原文，可由多行组成",
      "translation": "模块中文译文",
      "x": 10,
      "y": 20,
      "width": 120,
      "height": 48,
      "lines": [
        { "text": "单行原文", "translation": "单行中文", "x": 10, "y": 20, "width": 120, "height": 16 }
      ]
    }
  ]
}

要求：
1. 只包含需要翻译的英文文字，忽略纯数字、公式、坐标轴刻度、噪声和已经是中文的内容。
2. 每个模块必须有 text、translation、x、y、width、height。
3. 每一行文字尽量放入 lines 并给出自己的坐标。
4. ${mode === 'compare' ? '对照模式需要坐标准确覆盖原文。' : '图解模式需要坐标准确定位原文字块，以便后续自动寻找空白区域放置译文。'}
5. 不要添加解释，不要返回 Markdown。`,
          },
          {
            type: 'image_url',
            image_url: {
              url: image,
            },
          },
        ],
      },
    ],
    temperature: 0.1,
  })
  const rawText = extractResponseText(response.choices?.[0]?.message?.content)
  const parsed = parseJsonResponse(rawText)
  const blocks = normalizeMultimodalBlocks(parsed, { width: imageWidth, height: imageHeight })

  if (!blocks.length) throw new Error('多模态模型未返回可用的文字模块')

  return { blocks, raw: parsed }
}

export function createServer() {
  const app = express()

  app.use(cors())
  app.use(express.json({ limit: '20mb' }))

  app.post('/translate', async (req, res) => {
    const text = req.body?.text?.trim()

    if (!text) {
      return res.status(400).json({ error: 'text cannot be empty' })
    }

    const aiConfig = getAiConfig()

    if (aiConfig.error) {
      return res.status(500).json({ error: aiConfig.error })
    }

    if (!aiConfig.apiKey) {
      return res.status(500).json({
        error: '请先在设置中填写 API Key',
      })
    }

    if (!aiConfig.model) {
      return res.status(500).json({
        error: '请先在设置中填写模型名',
      })
    }

    try {
      const client = new OpenAI({
        baseURL: aiConfig.baseUrl,
        apiKey: aiConfig.apiKey,
        defaultHeaders: getProviderHeaders(aiConfig.provider),
      })
      const response = await client.chat.completions.create({
        model: aiConfig.model,
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt(aiConfig),
          },
          {
            role: 'user',
            content: text,
          },
        ],
        temperature: 0.2,
      })

      const translation = response.choices?.[0]?.message?.content?.trim()

      if (!translation) {
        return res.status(500).json({ error: 'AI provider returned an empty translation.' })
      }

      return res.json({ translation })
    } catch (error) {
      console.error(error)
      return res.status(500).json({
        error:
          error?.response?.data?.error?.message ||
          error?.error?.message ||
          error?.message ||
          'Translation failed. Check API Key, Base URL, model ID, account balance, and provider permissions.',
      })
    }
  })

  app.post('/multimodal-translate-image', async (req, res) => {
    const image = String(req.body?.image || '').trim()
    const mode = req.body?.mode === 'compare' ? 'compare' : 'diagram'
    const imageWidth = Number(req.body?.imageWidth) || 0
    const imageHeight = Number(req.body?.imageHeight) || 0

    if (!image) {
      return res.status(400).json({ error: 'image cannot be empty' })
    }

    if (!imageWidth || !imageHeight) {
      return res.status(400).json({ error: 'image size cannot be empty' })
    }

    try {
      return res.json(await translateImageWithMultimodalModel({ image, mode, imageWidth, imageHeight }))
    } catch (error) {
      console.error('Multimodal translation failed:', error)
      return res.status(500).json({
        error:
          error?.response?.data?.error?.message ||
          error?.error?.message ||
          error?.message ||
          '多模态翻译失败，已回退到原 OCR 流程。',
      })
    }
  })

  return app
}

export function startServer(options = {}) {
  const port = options.port || process.env.PORT || 3001
  const app = createServer()

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      console.log(`Translate server is running at http://localhost:${port}`)
      resolve(server)
    })

    server.on('error', reject)
  })
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false

if (isDirectRun) {
  startServer().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
