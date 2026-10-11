import { useEffect, useMemo, useRef } from 'react'
import { renderMarkdown } from '@/lib/markdown'

interface MarkdownProps {
  text: string
  /** 是否允许渲染 mermaid (流结束后再画图, 避免半截语法) */
  mermaidEnabled?: boolean
}

let mermaidInstance: typeof import('mermaid').default | null = null

async function loadMermaid() {
  if (!mermaidInstance) {
    const mod = await import('mermaid')
    mermaidInstance = mod.default
    mermaidInstance.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'dark',
      fontFamily: 'inherit',
    })
  }
  return mermaidInstance
}

export function Markdown({ text, mermaidEnabled = true }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // 1. 为所有代码块 (<pre>) 挂载复制按钮
    const preNodes = ref.current?.querySelectorAll<HTMLElement>(
      'pre:not([data-copy-enabled])',
    )
    if (preNodes) {
      for (const pre of preNodes) {
        pre.setAttribute('data-copy-enabled', 'true')
        const codeElem = pre.querySelector('code')
        const rawCode = codeElem?.textContent || pre.textContent || ''
        if (rawCode.trim()) {
          addCopyButton(pre, rawCode.trim(), '复制代码')
        }
      }
    }

    // 2. 为所有 Mermaid 图表进行渲染并挂载复制按钮
    if (!mermaidEnabled) return
    const nodes = ref.current?.querySelectorAll<HTMLElement>(
      '.mermaid:not([data-processed])',
    )
    if (!nodes || nodes.length === 0) return

    let cancelled = false
    void (async () => {
      try {
        const mermaid = await loadMermaid()
        if (cancelled) return

        for (const node of nodes) {
          if (cancelled) return
          const rawCode = node.textContent?.trim() || ''
          // 注意: 绝不能在 run 前手动设置 data-processed="true"，否则 mermaid 会跳过该节点
          try {
            await mermaid.run({ nodes: [node] })
          } catch (err) {
            console.warn('mermaid.run error:', err)
            node.dataset.processed = 'error'
            node.classList.add('mermaid-error')
          }
          if (rawCode) {
            addCopyButton(node, rawCode, '复制流程图源码')
          }
        }
      } catch (err) {
        console.error('Failed to load mermaid:', err)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [html, mermaidEnabled])

  return (
    <div
      ref={ref}
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function addCopyButton(node: HTMLElement, code: string, label: string = '复制') {
  if (!code || node.querySelector('.code-copy-btn, .mermaid-copy-btn')) return
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'code-copy-btn'
  btn.title = label
  btn.setAttribute('aria-label', label)
  btn.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </svg>
  `
  btn.onclick = async (e) => {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(code)
      btn.classList.add('copied')
      btn.title = '已复制！'
      btn.innerHTML = `
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 6 9 17l-5-5"/>
        </svg>
      `
      setTimeout(() => {
        btn.classList.remove('copied')
        btn.title = label
        btn.innerHTML = `
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
          </svg>
        `
      }, 1500)
    } catch {
      /* ignore */
    }
  }
  node.appendChild(btn)
}

