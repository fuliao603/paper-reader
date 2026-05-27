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

export function createServer() {
  const app = express()

  app.use(cors())
  app.use(express.json())

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
