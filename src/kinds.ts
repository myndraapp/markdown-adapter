import {
  getMyndletDefaults,
  getMyndlinkDefaults,
  MyndletAttributesSchema,
  type MyndletAttributes,
  type FilePosition,
} from '@myndra/plugin-sdk/schemas'
import type { GraphAPI } from '@myndra/plugin-sdk'

export const MD_KINDS = {
  HEADING: 'md:heading',
  PARAGRAPH: 'md:paragraph',
  LIST: 'md:list',
  LIST_ITEM: 'md:list-item',
  CODE_BLOCK: 'md:code-block',
  BLOCKQUOTE: 'md:blockquote',
  HR: 'md:hr',
  TABLE: 'md:table',
  HTML: 'md:html',
  SPACE: 'md:space',
} as const

export type MdKind = (typeof MD_KINDS)[keyof typeof MD_KINDS]

export const ALL_MD_KINDS: readonly string[] = Object.values(MD_KINDS)
export const MD_TAG_KIND = 'md:tag'
export const MD_EXT_NAMESPACE = 'markdown-adapter'
export const MD_NODE_COLOR = '#7E57C2'
export const MD_TAG_COLOR = '#9C27B0'

export const MARKDOWN_ADAPTER_ID = 'markdown-adapter'

export type MdExt = {
  isMarkdownFile?: boolean
  headingDepth?: number
  rawContent?: string
  lang?: string
  stableId?: string
  tagName?: string
  wikiTarget?: string
}

export const hierarchyEdgeDefaults = getMyndlinkDefaults('hierarchy')
export const referenceEdgeDefaults = getMyndlinkDefaults('reference')

export function getMdExtFromPartial(attrs: Partial<MyndletAttributes> | null | undefined): MdExt {
  const ext = attrs?.ext?.[MD_EXT_NAMESPACE]
  if (!ext || typeof ext !== 'object' || Array.isArray(ext)) return {}
  const record = ext as Record<string, unknown>
  return {
    isMarkdownFile: record.isMarkdownFile === true,
    headingDepth: typeof record.headingDepth === 'number' ? record.headingDepth : undefined,
    rawContent: typeof record.rawContent === 'string' ? record.rawContent : undefined,
    lang: typeof record.lang === 'string' ? record.lang : undefined,
    stableId: typeof record.stableId === 'string' ? record.stableId : undefined,
    tagName: typeof record.tagName === 'string' ? record.tagName : undefined,
    wikiTarget: typeof record.wikiTarget === 'string' ? record.wikiTarget : undefined,
  }
}

export const isMarkdownFileNode = (attrs: MyndletAttributes | Partial<MyndletAttributes>) => {
  const { isMarkdownFile } = getMdExtFromPartial(attrs)
  return Boolean(isMarkdownFile || attrs.path?.endsWith('.md') || attrs.path?.endsWith('.markdown'))
}

export const withMdExt = (
  attrs: Partial<MyndletAttributes>,
  payload: MdExt,
): Partial<MyndletAttributes> => {
  const baseExt = { ...(attrs.ext ?? {}) }
  const mdExt = { ...(baseExt[MD_EXT_NAMESPACE] ?? {}) }

  if (payload.isMarkdownFile !== undefined) mdExt.isMarkdownFile = payload.isMarkdownFile
  if (payload.headingDepth !== undefined) mdExt.headingDepth = payload.headingDepth
  if (payload.rawContent !== undefined) mdExt.rawContent = payload.rawContent
  if (payload.lang !== undefined) mdExt.lang = payload.lang
  if (payload.stableId !== undefined) mdExt.stableId = payload.stableId
  if (payload.tagName !== undefined) mdExt.tagName = payload.tagName
  if (payload.wikiTarget !== undefined) mdExt.wikiTarget = payload.wikiTarget

  return {
    ...attrs,
    ext: {
      ...baseExt,
      [MD_EXT_NAMESPACE]: mdExt,
    },
  }
}

export const buildMdNodeAttributes = (
  attrs: Partial<MyndletAttributes>,
  payload: MdExt,
): MyndletAttributes =>
  MyndletAttributesSchema.parse(
    withMdExt(
      {
        ...getMyndletDefaults(attrs.kind ?? null),
        ...attrs,
        adapterId: MARKDOWN_ADAPTER_ID,
        color: attrs.color ?? (attrs.kind === MD_TAG_KIND ? MD_TAG_COLOR : MD_NODE_COLOR),
      },
      payload,
    ),
  )

export const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

export const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}...` : value

export const stripListMarker = (value: string) => value.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')

export const isOrderedList = (value: string) => /^\s*\d+[.)]\s+/.test(value)

export const getMarkdownExtension = (path: string) =>
  path.toLowerCase().endsWith('.markdown') ? '.markdown' : '.md'

export const collectSubtreeKeys = (graph: GraphAPI, rootKey: string): string[] => {
  const keys: string[] = []
  const visited = new Set<string>()
  const stack = [rootKey]

  while (stack.length > 0) {
    const key = stack.pop()
    if (!key || visited.has(key)) continue
    visited.add(key)
    keys.push(key)
    const children = graph.getChildren(key)
    for (const child of children) {
      stack.push(child)
    }
  }

  return keys
}

export const clearMarkdownSubtree = (graph: GraphAPI, rootKey: string) => {
  const keys = collectSubtreeKeys(graph, rootKey)
  for (const key of keys) {
    if (key === rootKey) continue
    graph.durable.removeNode(key)
  }
}

export const buildLineStarts = (content: string): number[] => {
  const starts = [0]
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') {
      starts.push(i + 1)
    }
  }
  return starts
}

export const indexToPoint = (lineStarts: number[], index: number) => {
  let low = 0
  let high = lineStarts.length - 1
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (lineStarts[mid] <= index) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  const row = Math.max(0, low - 1)
  const column = index - lineStarts[row]
  return { row, column }
}

export const createFilePosition = (
  lineStarts: number[],
  startIndex: number,
  endIndex: number,
): FilePosition => ({
  start: indexToPoint(lineStarts, startIndex),
  end: indexToPoint(lineStarts, endIndex),
  startIndex,
  endIndex,
})
