import { isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import CopyButton from './CopyButton'
import InlineVisualization from './InlineVisualization'

/**
 * 助手消息 Markdown 渲染:GFM(表格/删除线/任务列表)+ 代码高亮。
 * react-markdown 默认不渲染原始 HTML,天然规避注入;链接统一新窗口打开。
 */
function MarkdownImpl({ text, sessionId, messageId }: { text: string; sessionId?: string; messageId?: string }): React.JSX.Element {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          pre: ({ children }) => {
            const code = nodeText(children).replace(/\n$/, '')
            const node = Array.isArray(children) ? children[0] : children
            if (isValidElement<{ className?: string }>(node) && node.props.className?.split(/\s+/).includes('language-caogen-viz')) {
              return <InlineVisualization source={code} sessionId={sessionId} messageId={messageId} />
            }
            return <pre><CopyButton text={code} kind="code" className="markdown-copy-code" />{children}</pre>
          }
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children)
  return ''
}

export default memo(MarkdownImpl)
