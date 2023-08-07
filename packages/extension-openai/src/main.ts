import { App, createApp } from 'vue'
import { Ctx, ctx, registerPlugin } from '@yank-note/runtime-api'
import Monaco from '@yank-note/runtime-api/types/types/third-party/monaco-editor'
import { actionName, i18n, loading, requestApi, setting, settingKeyToken } from './openai'
import AIPanel from './AIPanel.vue'

const { getLogger } = ctx.utils

const extensionId = __EXTENSION_ID__

class CompletionProvider implements Monaco.languages.InlineCompletionsProvider {
  private readonly monaco: typeof Monaco
  private readonly ctx: Ctx
  private logger = getLogger(extensionId)

  constructor (monaco: typeof Monaco, ctx: Ctx) {
    this.monaco = monaco
    this.ctx = ctx
  }

  freeInlineCompletions (): void {
    loading.value = false
  }

  handleItemDidShow (): void {
    loading.value = false
  }

  public async provideInlineCompletions (
    _model: Monaco.editor.IModel,
    position: Monaco.Position,
    context: Monaco.languages.InlineCompletionContext,
    token: Monaco.CancellationToken
  ): Promise<Monaco.languages.InlineCompletions> {
    if (!setting.enable) {
      return { items: [] }
    }

    if (context.triggerKind !== this.monaco.languages.InlineCompletionTriggerKind.Explicit) {
      return { items: [] }
    }

    return {
      items: await this.provideSuggestions(position, token)
    }
  }

  private async provideSuggestions (position: Monaco.Position, token: Monaco.CancellationToken): Promise<Monaco.languages.InlineCompletion[]> {
    if (token.isCancellationRequested) {
      return []
    }

    token.onCancellationRequested(() => {
      loading.value = false
      this.ctx.ui.useToast().show('warning', 'Canceled', 2000)
    })

    const range = new this.monaco.Range(
      position.lineNumber,
      position.column,
      position.lineNumber,
      position.column,
    )

    let stop = setting.stopSequences

    try {
      stop = JSON.parse(stop)
    } catch {
      // ignore
    }

    let url: string
    let body: any

    if (setting.type === 'chat') {
      const content = setting.input
      const system = setting.chatSystem.trim()
      if (!content) {
        return []
      }

      const messages = [{ role: 'user', content }]
      if (system.trim()) {
        messages.unshift({ role: 'system', content: system })
      }

      url = 'https://api.openai.com/v1/chat/completions'

      body = {
        model: setting.chatModel,
        messages,
        temperature: setting.temperature,
        n: 1,
        top_p: setting.topP,
        frequency_penalty: setting.frequencyPenalty,
        presence_penalty: setting.presencePenalty,
        max_tokens: setting.maxTokens,
        stop: stop || undefined,
      }

      setting.chatSystemHistory.unshift(setting.chatSystem.trim())
      setting.chatSystemHistory = [...new Set(setting.chatSystemHistory.slice(0, 20))]
    } else {
      url = setting.type === 'completion'
        ? `https://api.openai.com/v1/engines/${setting.model}/completions`
        : `https://api.openai.com/v1/engines/${setting.editModel}/edits`

      body = setting.type === 'completion'
        ? {
            temperature: setting.temperature,
            n: 1,
            top_p: setting.topP,
            frequency_penalty: setting.frequencyPenalty,
            presence_penalty: setting.presencePenalty,
            prompt: setting.prefix,
            max_tokens: setting.maxTokens,
            suffix: setting.suffix || undefined,
            stop: stop || undefined,
          }
        : {
            input: setting.input,
            instruction: setting.instruction,
            n: 1,
            temperature: setting.temperature,
            top_p: setting.topP,
          }

      if (setting.type === 'edit') {
        setting.instructionHistory.unshift(setting.instruction.trim())
        setting.instructionHistory = [...new Set(setting.instructionHistory.slice(0, 20))]
      }
    }

    this.logger.debug('provideSuggestions', 'request', setting.model, body)

    try {
      const res = await requestApi(url, body)

      this.logger.debug('provideSuggestions', 'result', res)

      if (!res.choices) {
        this.ctx.ui.useToast().show('warning', JSON.stringify(res), 5000)
        return []
      }

      return (res.choices).map((x: any) => {
        const text = x.message ? x.message.content : x.text

        return {
          text: text,
          insertText: { snippet: text },
          range,
        }
      })
    } catch (error: any) {
      this.ctx.ui.useToast().show('warning', error.message || `${error}`, 5000)
      this.logger.error('provideSuggestions', 'error', error)
      throw error
    }
  }
}

registerPlugin({
  name: extensionId,
  register (ctx) {
    ctx.editor.whenEditorReady().then(({ monaco }) => {
      monaco.languages.registerInlineCompletionsProvider(
        'markdown',
        new CompletionProvider(monaco, ctx)
      )
    })

    ctx.setting.changeSchema((schema) => {
      if (!schema.groups.some((x: any) => x.value === 'plugin')) {
        schema.groups.push({ value: 'plugin', label: 'Plugin' } as any)
      }

      schema.properties[settingKeyToken] = {
        title: i18n.$$t('api-token'),
        description: i18n.$$t('api-token-desc'),
        type: 'string',
        defaultValue: '',
        group: 'plugin' as any,
        options: {
          inputAttributes: { placeholder: 'sk-' + 'x'.repeat(10) }
        },
      }
    })

    ctx.action.registerAction({
      name: actionName,
      keys: [ctx.keybinding.CtrlCmd, ctx.keybinding.Alt, 'Period'],
      description: i18n.t('openai-complete'),
      forUser: true,
      handler: () => {
        ctx.editor.getEditor().getAction('editor.action.inlineSuggest.trigger')?.run()
        ctx.editor.getEditor().focus()
      },
      when: () => ctx.store.state.showEditor && !ctx.store.state.presentation,
    })

    ctx.statusBar.tapMenus((menus) => {
      if (!ctx.store.state.showEditor || ctx.store.state.presentation) {
        return
      }

      menus['status-bar-tool']?.list?.push(
        {
          id: actionName,
          type: 'normal',
          title: i18n.t('openai-complete'),
          checked: setting.enable,
          onClick: () => {
            setting.enable = !setting.enable
          },
        },
      )
    })

    const div = document.createElement('div')
    div.className = 'openai-panel-container'
    div.style.position = 'absolute'
    div.style.right = '3%'
    div.style.bottom = '20px'
    div.style.zIndex = '2048'
    div.style.maxWidth = '85%'
    document.querySelector('.editor-container')!.appendChild(div)

    let panel: App | null = null

    ctx.lib.vue.watch(() => setting.enable, (val) => {
      ctx.statusBar.refreshMenu()

      if (val) {
        div.style.display = 'block'
        panel = createApp(AIPanel)
        panel.mount(div)
      } else {
        div.style.display = 'none'
        panel?.unmount()
        panel = null
      }
    }, { immediate: true })
  }
})
