import { useEffect, useMemo, useRef } from 'react'
import { renderMarkdown } from '@/lib/markdown'

interface MarkdownProps {
  text: string
  /** 是否允许渲染 mermaid (流结束后再画图, 避免半截语法) */
  mermaidEnabled?: boolean
}

export function Markdown({ text, mermaidEnabled = true }: MarkdownProps) {
  const html = useMemo(() => renderMarkdown(text), [text])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mermaidEnabled) return
    const nodes = ref.current?.querySelectorAll<HTMLElement>(
      '.mermaid:not([data-processed])',
    )
    if (!nodes || nodes.length === 0) return

    let cancelled = false
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'dark',
          fontFamily: 'inherit',
        })
        if (cancelled) return
        for (const node of nodes) {
          if (cancelled) return
          node.dataset.processed = 'true'
          try {
            await mermaid.run({ nodes: [node] })
          } catch {
            // 语法错误: 保留源码展示
            node.classList.add('mermaid-error')
          }
        }
      } catch {
        /* mermaid 加载失败: 忽略, 保持源码展示 */
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
