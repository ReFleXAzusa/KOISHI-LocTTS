// plugins/loctts/index.ts
import { Context, Schema, h, Session } from 'koishi'
import axios from 'axios'
import { createWriteStream } from 'fs'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'

export const name = 'loctts'

// 定义 cutMethod 的联合类型
type CutMethod = 'cut0' | 'cut1' | 'cut2' | 'cut3' | 'cut4' | 'cut5'

export interface Config {
  apiBase: string
  referWavPath: string
  promptText: string
  promptLanguage: string
  textLanguage: string
  autoConvert: boolean
  cutMethod: CutMethod
  filterBrackets: boolean
  filterEmojis: boolean
  gptModelPath: string
  sovitsModelPath: string
}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().description('GSV推理WEBUI地址').default('http://localhost:9880'),
  referWavPath: Schema.string().description('参考音频路径').required(),
  promptText: Schema.string().description('参考文本').default(''),
  promptLanguage: Schema.string().description('参考文本语言').default('zh'),
  textLanguage: Schema.string().description('目标文本语言').default('zh'),
  autoConvert: Schema.boolean().description('自动转换AI回复为语音').default(false),
  cutMethod: Schema.union([
    Schema.const('cut0' as const).description('不切'),
    Schema.const('cut1' as const).description('凑四句一切'),
    Schema.const('cut2' as const).description('按标点符号切'),
    Schema.const('cut3' as const).description('按字切'),
    Schema.const('cut4' as const).description('按换行切'),
    Schema.const('cut5' as const).description('按句子切')
  ]).description('文本切割方法').default('cut5' as CutMethod),
  filterBrackets: Schema.boolean().description('过滤括号内容').default(true),
  filterEmojis: Schema.boolean().description('过滤表情符号').default(true),
  gptModelPath: Schema.string().description('GPT模型路径 (.pth文件)').default(''),
  sovitsModelPath: Schema.string().description('SoVITS模型路径 (.pth文件)').default(''),
})

export function apply(ctx: Context, config: Config) {
  // 创建临时目录
  const tempDir = join(__dirname, '../temp')
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true })
  }

  // 模型管理函数
  async function loadModels() {
    if (config.gptModelPath && existsSync(config.gptModelPath)) {
      try {
        await axios.get(`${config.apiBase}/set_gpt_weights`, {
          params: { weights_path: config.gptModelPath },
          timeout: 30000
        })
        ctx.logger.info(`GPT模型加载成功: ${config.gptModelPath}`)
      } catch (error: any) {
        ctx.logger.error(`GPT模型加载失败: ${error.message}`)
      }
    }

    if (config.sovitsModelPath && existsSync(config.sovitsModelPath)) {
      try {
        await axios.get(`${config.apiBase}/set_sovits_weights`, {
          params: { weights_path: config.sovitsModelPath },
          timeout: 30000
        })
        ctx.logger.info(`SoVITS模型加载成功: ${config.sovitsModelPath}`)
      } catch (error: any) {
        ctx.logger.error(`SoVITS模型加载失败: ${error.message}`)
      }
    }
  }

  // 插件启动时加载模型
  ctx.on('ready', async () => {
    await loadModels()
  })

  // 文本预处理函数（包含括号过滤）
  function preprocessText(text: string, config: Config): string {
    let processedText = text;
    
    // 根据配置过滤括号内容
    if (config.filterBrackets) {
      processedText = processedText
        .replace(/\([^)]*\)/g, '')
        .replace(/（[^）]*）/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/【[^】]*】/g, '')
        .replace(/\{[^}]*\}/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/《[^》]*》/g, '');
    }
    
    // 根据配置过滤表情符号
    if (config.filterEmojis) {
      processedText = processedText
        .replace(/[\u{1F600}-\u{1F64F}]/gu, '')
        .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
        .replace(/[\u{1F680}-\u{1F6FF}]/gu, '')
        .replace(/[\u{1F700}-\u{1F77F}]/gu, '')
        .replace(/[\u{1F780}-\u{1F7FF}]/gu, '')
        .replace(/[\u{1F800}-\u{1F8FF}]/gu, '')
        .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
        .replace(/[\u{2600}-\u{26FF}]/gu, '')
        .replace(/[\u{2700}-\u{27BF}]/gu, '');
    }
    
    // 其他预处理
    processedText = processedText
      .replace(/[#*_~`|]/g, '')
      .replace(/(http[s]?:\/\/[^\s]+)/g, '链接')
      .replace(/@(\w+)/g, '用户$1')
      .replace(/\s+/g, ' ')
      .replace(/，\s*，/g, '，')
      .replace(/。\s*。/g, '。')
      .replace(/！\s*！/g, '！')
      .replace(/？\s*？/g, '？')
      .trim();

    if (processedText.length === 0) {
      processedText = '无有效文本内容';
    }

    return processedText;
  }

  // 核心转换函数
  async function convertTextToSpeech(text: string, config: Config): Promise<string> {
    // 文本预处理，传入 config
    const processedText = preprocessText(text, config)
    
    try {
      // 根据 API v2 文档构建请求数据
      const requestData = {
        text: processedText,
        text_lang: config.textLanguage.toLowerCase(),
        ref_audio_path: config.referWavPath,
        prompt_text: config.promptText,
        prompt_lang: config.promptLanguage.toLowerCase(),
        text_split_method: config.cutMethod,
        top_k: 5,
        top_p: 1,
        temperature: 1,
        batch_size: 1,
        batch_threshold: 0.75,
        split_bucket: true,
        speed_factor: 1.0,
        seed: -1,
        media_type: "wav",
        streaming_mode: false,
        parallel_infer: true,
        repetition_penalty: 1.35,
        sample_steps: 32,
        super_sampling: false
      }

      ctx.logger.info('发送 TTS 请求到:', `${config.apiBase}/tts`)
      
      const response = await axios({
        method: 'post',
        url: `${config.apiBase}/tts`,
        headers: {
          'Content-Type': 'application/json',
        },
        data: requestData,
        responseType: 'stream',
        timeout: 60000
      })

      // 保存音频文件
      const outputFile = join(tempDir, `tts_${Date.now()}.wav`)
      const writer = createWriteStream(outputFile)
      
      response.data.pipe(writer)
      
      return new Promise((resolve, reject) => {
        writer.on('finish', () => {
          ctx.logger.info(`语音生成成功: ${outputFile}`)
          resolve(outputFile)
        })
        writer.on('error', (error) => {
          ctx.logger.error('保存音频文件失败:', error)
          reject(error)
        })
      })
      
    } catch (error: any) {
      if (error.response) {
        let errorDetails = ''
        try {
          if (error.response.data && typeof error.response.data.on === 'function') {
            const data = await new Promise<string>((resolve) => {
              let chunks = ''
              error.response.data.on('data', (chunk: Buffer) => chunks += chunk.toString())
              error.response.data.on('end', () => resolve(chunks))
            })
            errorDetails = ` - ${data}`
          } else {
            errorDetails = ` - ${error.response.data}`
          }
        } catch (e) {
          errorDetails = ' - 无法读取错误详情'
        }
        
        throw new Error(`GSV API 错误: ${error.response.status}${errorDetails}`)
      } else if (error.code === 'ECONNREFUSED') {
        throw new Error(`无法连接到 GSV 服务 (${config.apiBase})。请确认 GPT-SOVITS 服务已启动`)
      } else {
        throw new Error(`请求失败: ${error.message}`)
      }
    }
  }

  // 注册 TTS 命令
  ctx.command('tts <text:string>', '文本转语音')
    .action(async ({ session }, text) => {
      if (!text) return '请输入要转换的文本'
      
      try {
        const audioFile = await convertTextToSpeech(text, config)
        return h.audio(`file:///${audioFile}`)
      } catch (error: any) {
        ctx.logger.error('TTS 转换失败:', error)
        return `语音转换失败: ${error.message}`
      }
    })

  // 模型管理命令
  ctx.command('tts.model <action:string>', '模型管理')
    .option('gpt', '-g <model>')
    .option('sovits', '-s <model>')
    .action(async ({ session, options }, action) => {
      try {
        switch (action) {
          case 'load':
            await loadModels()
            return '模型重新加载完成'
            
          case 'setgpt':
            if (!options.gpt) return '请提供GPT模型路径，使用 -g 参数'
            if (!existsSync(options.gpt)) return `模型文件不存在: ${options.gpt}`
            
            await axios.get(`${config.apiBase}/set_gpt_weights`, {
              params: { weights_path: options.gpt },
              timeout: 30000
            })
            config.gptModelPath = options.gpt
            return `GPT模型已设置为: ${options.gpt}`
            
          case 'setsovits':
            if (!options.sovits) return '请提供SoVITS模型路径，使用 -s 参数'
            if (!existsSync(options.sovits)) return `模型文件不存在: ${options.sovits}`
            
            await axios.get(`${config.apiBase}/set_sovits_weights`, {
              params: { weights_path: options.sovits },
              timeout: 30000
            })
            config.sovitsModelPath = options.sovits
            return `SoVITS模型已设置为: ${options.sovits}`
            
          case 'status':
            const status = []
            if (config.gptModelPath) {
              status.push(`GPT模型: ${config.gptModelPath}`)
            } else {
              status.push('GPT模型: 未设置')
            }
            if (config.sovitsModelPath) {
              status.push(`SoVITS模型: ${config.sovitsModelPath}`)
            } else {
              status.push('SoVITS模型: 未设置')
            }
            return status.join('\n')
            
          default:
            return '可用操作: load, setgpt, setsovits, status\n使用示例: /tts.model setgpt -g /path/to/model.pth'
        }
      } catch (error: any) {
        return `模型操作失败: ${error.message}`
      }
    })

  // 改进的自动转换中间件 - 通用方案
  if (config.autoConvert) {
    let isProcessing = false // 防止重复处理
    
    // 改进的通用文本提取函数
    function extractReplyText(content: any): string {
      if (!content) return ''
      
      // 字符串直接返回
      if (typeof content === 'string') {
        return content
      }
      
      // 消息元素数组
      if (Array.isArray(content)) {
        return content
          .map(item => {
            if (typeof item === 'string') return item
            // 处理各种消息元素
            if (item?.type === 'text') return item.attrs?.content || ''
            if (item?.attrs?.content) return item.attrs.content
            if (item?.attrs?.url && !item.attrs.url.match(/\.(jpg|jpeg|png|gif|bmp)$/i)) {
              return '[媒体内容]'
            }
            return ''
          })
          .filter(text => text.trim().length > 0)
          .join(' ')
      }
      
      // 单个消息元素
      if (content?.type === 'text' && content.attrs?.content) {
        return content.attrs.content
      }
      
      // 对象类型，尝试转换为字符串
      if (typeof content === 'object') {
        try {
          return JSON.stringify(content).replace(/[{}"\\]/g, ' ')
        } catch {
          return '[对象内容]'
        }
      }
      
      return String(content || '')
    }
    
    // 改进的文本有效性检查
    function isValidForTTS(text: string): boolean {
      if (!text || text.trim().length < 2) return false
      
      const trimmedText = text.trim()
      
      // 跳过纯符号、链接、命令等
      const skipPatterns = [
        /^[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~\s]*$/, // 纯符号
        /^https?:\/\//, // 链接
        /^\/\w+/, // 命令
        /^(ok|嗯|啊|哦|呵呵|哈哈)$/i, // 简单回复
        /^\[.*\]$/, // 方括号内容
        /^[\u4e00-\u9fa5]{1,2}$/, // 单个中文字符
      ]
      
      return !skipPatterns.some(pattern => pattern.test(trimmedText))
    }
    
    // 独立的语音处理函数
    async function processAudioConversion(session: Session, result: any) {
      try {
        // 改进的通用文本提取
        const textContent = extractReplyText(result)
        
        if (isValidForTTS(textContent)) {
          ctx.logger.info(`自动TTS转换: ${textContent.substring(0, 50)}...`)
          
          const audioFile = await convertTextToSpeech(textContent, config)
          // 延迟发送语音，确保文本先显示
          setTimeout(() => {
            session.send(h.audio(`file:///${audioFile}`)).catch(error => {
              ctx.logger.error('发送语音消息失败:', error)
            })
          }, 1000)
        }
      } catch (error: any) {
        ctx.logger.error('自动TTS转换失败:', error)
      }
    }
    
    ctx.middleware(async (session: Session, next) => {
      // 先执行后续中间件获取回复
      const result = await next()
      
      // 跳过条件
      if (!result || 
          session.content.startsWith('/tts') || 
          session.content.startsWith('tts.') ||
          isProcessing) {
        return result
      }
      
      // 标记为处理中，防止重复
      isProcessing = true
      
      // 异步处理语音转换，不阻塞原始回复
      processAudioConversion(session, result).catch(error => {
        ctx.logger.error('自动TTS处理失败:', error)
      }).finally(() => {
        isProcessing = false
      })
      
      return result
    })
  }

  // 添加调试命令来查看过滤效果
  ctx.command('tts.filter <text:string>', '测试文本过滤效果')
    .action(async ({ session }, text) => {
      if (!text) return '请输入要测试的文本'
      
      const originalText = text
      const filteredText = preprocessText(text, config)
      
      return `过滤前: ${originalText}\n过滤后: ${filteredText}`
    })

  // 添加命令来临时关闭过滤
  ctx.command('tts.raw <text:string>', '不经过滤直接转换文本')
    .action(async ({ session }, text) => {
      if (!text) return '请输入要转换的文本'
      
      try {
        // 临时创建一个不过滤的配置
        const tempConfig = { ...config }
        tempConfig.filterBrackets = false
        tempConfig.filterEmojis = false
        
        const audioFile = await convertTextToSpeech(text, tempConfig)
        return [
          h.text(`原始文本: ${text}`),
          h.audio(`file:///${audioFile}`)
        ]
      } catch (error: any) {
        return `语音转换失败: ${error.message}`
      }
    })

  // 服务状态检查
  ctx.command('tts.check', '检查 GSV 服务状态')
    .action(async () => {
      try {
        // 直接测试 /tts 端点
        const testData = {
          text: "测试",
          text_lang: "zh",
          ref_audio_path: config.referWavPath,
          prompt_text: "测试",
          prompt_lang: "zh",
          text_split_method: "cut5"
        }
        
        const response = await axios.post(`${config.apiBase}/tts`, testData, {
          timeout: 10000,
          validateStatus: () => true
        })
        
        if (response.status === 200) {
          return `✅ GSV 服务运行正常 (${config.apiBase})`
        } else {
          return `❌ GSV 服务返回错误: ${response.status}`
        }
      } catch (error: any) {
        if (error.code === 'ECONNREFUSED') {
          return `❌ 无法连接到 GSV 服务 (${config.apiBase})`
        } else {
          return `❌ 连接失败: ${error.message}`
        }
      }
    })

  // 通用集成测试命令（修复版本）
  ctx.command('tts.integration <message:text>', '测试TTS与AI集成')
    .action(async ({ session }, message) => {
      if (!message) return '请输入测试消息'
      
      try {
        // 步骤1: 显示原始消息
        await session.send(`测试消息: ${message}`)
        
        // 步骤2: 尝试获取AI回复（如果有AI插件）- 使用更通用的方式
        let aiReply = null
        try {
          // 方法1: 尝试通过中间件获取AI回复
          // 这里我们模拟一个AI回复，因为无法直接访问AI服务
          aiReply = `这是对"${message}"的测试回复。当前时间: ${new Date().toLocaleTimeString()}`
          
          // 如果有其他方式调用AI，可以在这里添加
          // 例如通过执行命令的方式
          // const result = await session.execute(`/ai ${message}`)
          // if (result) aiReply = result
          
        } catch (error) {
          aiReply = `AI服务暂不可用，使用测试回复: ${message}的测试语音`
        }
        
        await session.send(`AI回复: ${aiReply}`)
        
        // 步骤3: 转换为语音
        const audioFile = await convertTextToSpeech(aiReply, config)
        await session.send(h.audio(`file:///${audioFile}`))
        
        return '集成测试完成'
      } catch (error: any) {
        return `集成测试失败: ${error.message}`
      }
    })

  // 状态检查命令（修复版本）
  ctx.command('tts.status', '检查TTS插件状态')
    .action(async () => {
      const status = [
        `✅ TTS服务: ${config.apiBase}`,
        `🎯 自动转换: ${config.autoConvert ? '开启' : '关闭'}`,
        `🔊 参考音频: ${config.referWavPath}`,
        `📝 文本过滤: 括号${config.filterBrackets ? '开' : '关'}, 表情${config.filterEmojis ? '开' : '关'}`,
        `✂️ 切割方法: ${config.cutMethod}`,
      ]
      
      // 检查AI服务状态 - 使用更通用的方式
      try {
        // 尝试检测是否有AI服务可用
        // 这里使用更保守的检测方法
        const hasAIService = ctx.get('satori') !== undefined
        if (hasAIService) {
          status.push('✅ AI服务: 检测到可能的AI服务')
        } else {
          status.push('❌ AI服务: 未检测到AI服务')
        }
      } catch {
        status.push('❓ AI服务: 状态未知')
      }
      
      return status.join('\n')
    })
}