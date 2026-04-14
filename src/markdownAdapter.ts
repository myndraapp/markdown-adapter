import {
  getMyndletDefaults,
  getMyndlinkDefaults,
  MyndletAttributesSchema,
  MyndlinkAttributesSchema,
  type MyndletAttributes,
  type FilePosition,
} from '@myndra/plugin-sdk/schemas'
import type { PluginContext, Node, Tree, GraphAPI } from '@myndra/plugin-sdk'
const MD_KINDS = {
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

type MdKind = (typeof MD_KINDS)[keyof typeof MD_KINDS]

const ALL_MD_KINDS: readonly string[] = Object.values(MD_KINDS)
const MD_TAG_KIND = 'md:tag'
const MD_EXT_NAMESPACE = 'markdown-adapter'
const MD_NODE_COLOR = '#7E57C2'
const MD_TAG_COLOR = '#9C27B0'

export const MARKDOWN_ADAPTER_ID = 'markdown-adapter'

type AssetResolver = (name: string) => string

let resolve: AssetResolver = (name) => `/plugins/markdown-adapter/${name}`

function buildHeadingGlyphs(r: AssetResolver) {
  return new Map<number, string>([
    [1, r('format_h1.svg')],
    [2, r('format_h2.svg')],
    [3, r('format_h3.svg')],
    [4, r('format_h4.svg')],
    [5, r('format_h5.svg')],
    [6, r('format_h6.svg')],
  ])
}

function buildCodeGlyphs(r: AssetResolver) {
  const js = r('javascript.svg')
  const html = r('html.svg')
  const css = r('css.svg')
  const data = r('data_object.svg')
  const term = r('terminal.svg')
  return new Map<string, string>([
    ['javascript', js],
    ['js', js],
    ['jsx', js],
    ['mjs', js],
    ['cjs', js],
    ['typescript', js],
    ['ts', js],
    ['tsx', js],
    ['node', js],
    ['html', html],
    ['html5', html],
    ['css', css],
    ['scss', css],
    ['sass', css],
    ['less', css],
    ['json', data],
    ['jsonc', data],
    ['json5', data],
    ['yaml', data],
    ['yml', data],
    ['bash', term],
    ['sh', term],
    ['shell', term],
    ['zsh', term],
    ['fish', term],
    ['powershell', term],
    ['ps1', term],
  ])
}

function buildCalloutGlyphs(r: AssetResolver) {
  return new Map<string, string>([
    ['NOTE', r('info.svg')],
    ['INFO', r('info.svg')],
    ['TIP', r('lightbulb.svg')],
    ['IMPORTANT', r('priority_high.svg')],
    ['WARNING', r('warning.svg')],
    ['CAUTION', r('report.svg')],
    ['DANGER', r('error.svg')],
  ])
}

// Glyph caches — lazily built on first access, invalidated when resolver changes.
let _headingGlyphs: Map<number, string> | null = null
let _codeGlyphs: Map<string, string> | null = null
let _calloutGlyphs: Map<string, string> | null = null

function getHeadingGlyphsMap() {
  return (_headingGlyphs ??= buildHeadingGlyphs(resolve))
}
function getCodeGlyphsMap() {
  return (_codeGlyphs ??= buildCodeGlyphs(resolve))
}
function getCalloutGlyphsMap() {
  return (_calloutGlyphs ??= buildCalloutGlyphs(resolve))
}

function initializeGlyphs(assetResolver: AssetResolver) {
  resolve = assetResolver
  _headingGlyphs = null
  _codeGlyphs = null
  _calloutGlyphs = null
}

let warnedMissingMarkdownGrammar = false

type MdExt = {
  isMarkdownFile?: boolean
  headingDepth?: number
  rawContent?: string
  lang?: string
  stableId?: string
  tagName?: string
  wikiTarget?: string
}

const hierarchyEdgeDefaults = getMyndlinkDefaults('hierarchy')
const referenceEdgeDefaults = getMyndlinkDefaults('reference')

const isMarkdownFileNode = (attrs: MyndletAttributes | Partial<MyndletAttributes>) => {
  const { isMarkdownFile } = getMdExtFromPartial(attrs)
  return Boolean(isMarkdownFile || attrs.path?.endsWith('.md') || attrs.path?.endsWith('.markdown'))
}

function getMdExtFromPartial(attrs: Partial<MyndletAttributes> | null | undefined): MdExt {
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

const withMdExt = (
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

const buildMdNodeAttributes = (
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

const normalizeWhitespace = (value: string) => value.replace(/\s+/g, ' ').trim()

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}...` : value

const getHeadingGlyph = (depth: number) => getHeadingGlyphsMap().get(depth) ?? resolve('title.png')

const getListGlyph = (node: Node) =>
  isOrderedList(node.text ?? '')
    ? resolve('format_list_numbered.svg')
    : resolve('format_list_bulleted.svg')

const getTaskListGlyph = (node: Node): string | null => {
  const firstLine = (node.text ?? '').split('\n')[0] ?? ''
  const match = firstLine.match(/^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s*/)
  if (!match) return null
  return match[1].toLowerCase() === 'x'
    ? resolve('check_box.svg')
    : resolve('check_box_outline_blank.svg')
}

const normalizeCodeLang = (lang: string | undefined) => {
  if (!lang) return null
  const cleaned = lang
    .trim()
    .toLowerCase()
    .replace(/^[{.]+/, '')
    .replace(/[}]+$/, '')
  const withoutPrefix = cleaned.startsWith('language-')
    ? cleaned.slice('language-'.length)
    : cleaned
  return withoutPrefix || null
}

const getCodeGlyph = (lang: string | undefined): string | null => {
  const normalized = normalizeCodeLang(lang)
  if (!normalized) return null
  return getCodeGlyphsMap().get(normalized) ?? null
}

const getBlockquoteGlyph = (node: Node): string | null => {
  const text = node.text ?? ''
  const firstLine = text.split('\n')[0] ?? ''
  const cleaned = firstLine.replace(/^\s*>+\s?/, '')
  const match = cleaned.match(/\[\!([A-Za-z]+)\]/)
  if (!match) return null
  const callout = match[1].toUpperCase()
  return getCalloutGlyphsMap().get(callout) ?? null
}

const stripListMarker = (value: string) => value.replace(/^\s*(?:[-+*]|\d+[.)])\s+/, '')

const isOrderedList = (value: string) => /^\s*\d+[.)]\s+/.test(value)

const TAG_PATTERN = /#[0-9]*[A-Za-z_/-][A-Za-z0-9_/-]*/g
const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

const stripInlineCode = (value: string) => value.replace(/`[^`]*`/g, ' ')
const stripFencedCode = (value: string) =>
  value.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ')
const stripMarkdownCode = (value: string) => stripInlineCode(stripFencedCode(value))

const normalizeTag = (value: string) => value.slice(1).trim().toLowerCase()

const normalizeWikiTarget = (value: string) => normalizeWhitespace(value).replace(/\\/g, '/')

const stripMarkdownExtension = (value: string) => value.replace(/\.(markdown|md)$/i, '')

const splitWikiTarget = (value: string) => {
  const normalized = normalizeWikiTarget(value)
  const [pathPart, headingPart] = normalized.split('#', 2)
  return {
    path: pathPart.trim(),
    heading: headingPart ? normalizeWhitespace(headingPart) : null,
  }
}

const normalizeHeadingLabel = (value: string) =>
  normalizeWhitespace(value.replace(/^\s*#+\s*/, '').replace(/\s*#+\s*$/, '')).toLowerCase()

type MarkdownFileIndexEntry = {
  key: string
  path: string
  pathLower: string
  pathNoExtLower: string
  stemLower: string
}

const buildMarkdownFileIndex = (ctx: PluginContext): MarkdownFileIndexEntry[] =>
  ctx.graph
    .findNodes(({ attributes }) => Boolean(attributes.path) && isMarkdownFileNode(attributes))
    .map((node) => {
      const path = node.attributes.path ?? ''
      const normalizedPath = normalizeWikiTarget(path)
      const pathLower = normalizedPath.toLowerCase()
      const pathNoExtLower = stripMarkdownExtension(pathLower)
      const stemLower = pathNoExtLower.split('/').pop() ?? pathNoExtLower
      return { key: node.key, path: normalizedPath, pathLower, pathNoExtLower, stemLower }
    })

const findHeadingNode = (graph: GraphAPI, fileKey: string, heading: string): string | null => {
  const target = normalizeHeadingLabel(heading)
  if (!target) return null
  const stack = [...graph.getChildren(fileKey)]
  const visited = new Set<string>()
  while (stack.length > 0) {
    const key = stack.pop()
    if (!key || visited.has(key)) continue
    visited.add(key)
    const node = graph.getNode(key)
    if (!node) continue
    if (node.attributes.kind === MD_KINDS.HEADING) {
      const label = typeof node.attributes.label === 'string' ? node.attributes.label : ''
      if (normalizeHeadingLabel(label) === target) return key
    }
    stack.push(...graph.getChildren(key))
  }
  return null
}

const resolveWikiLinkTarget = (
  graph: GraphAPI,
  fileIndex: MarkdownFileIndexEntry[],
  sourceFileKey: string,
  rawTarget: string,
): string | null => {
  const { path, heading } = splitWikiTarget(rawTarget)
  let resolvedKey: string | null = null

  if (!path) {
    resolvedKey = sourceFileKey
  } else {
    const targetLower = normalizeWikiTarget(path).toLowerCase()
    const targetNoExtLower = stripMarkdownExtension(targetLower)
    const isPathLike = targetLower.includes('/')

    const match = fileIndex.find((entry) => {
      if (isPathLike) {
        return (
          entry.pathNoExtLower === targetNoExtLower ||
          entry.pathLower === targetLower ||
          entry.pathLower.endsWith(`/${targetNoExtLower}`)
        )
      }
      return (
        entry.stemLower === targetNoExtLower ||
        entry.pathNoExtLower.endsWith(`/${targetNoExtLower}`)
      )
    })
    resolvedKey = match?.key ?? null
  }

  if (!resolvedKey) return null
  if (!heading) return resolvedKey
  return findHeadingNode(graph, resolvedKey, heading) ?? resolvedKey
}

const extractMarkdownReferences = (content: string) => {
  const sanitized = stripMarkdownCode(content)
  const wikiTargets = Array.from(
    sanitized.matchAll(new RegExp(WIKI_LINK_PATTERN.source, WIKI_LINK_PATTERN.flags)),
  )
    .map((match) => match[1])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizeWikiTarget(value))
    .filter((value) => value.length > 0)

  const sanitizedWithoutWiki = sanitized.replace(WIKI_LINK_PATTERN, ' ')
  const tags = Array.from(
    sanitizedWithoutWiki.matchAll(new RegExp(TAG_PATTERN.source, TAG_PATTERN.flags)),
  )
    .map((match) => match[0])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => normalizeTag(value))
    .filter((value) => value.length > 0)

  return {
    tags: Array.from(new Set(tags)),
    wikiTargets: Array.from(new Set(wikiTargets)),
  }
}

const hasReferenceEdge = (graph: GraphAPI, sourceKey: string, targetKey: string) =>
  graph
    .getNodeEdges(sourceKey)
    .some(
      (edge) =>
        edge.attributes.kind === 'reference' &&
        ((edge.source === sourceKey && edge.target === targetKey) ||
          (edge.source === targetKey && edge.target === sourceKey)),
    )

const addReferenceEdge = (graph: GraphAPI, sourceKey: string, targetKey: string): string | null => {
  if (hasReferenceEdge(graph, sourceKey, targetKey)) return null
  return graph.durable.addReferenceLink(
    sourceKey,
    targetKey,
    MyndlinkAttributesSchema.parse({ ...referenceEdgeDefaults }),
  )
}

const getTagGlyph = () => resolve('segment.png')

const ensureTagNode = (graph: GraphAPI, tagName: string): string =>
  graph.durable.addNode(
    buildMdNodeAttributes(
      {
        kind: MD_TAG_KIND,
        label: `#${tagName}`,
        image: getTagGlyph(),
      },
      { stableId: `md:tag:${tagName}`, tagName },
    ),
  )

type MarkdownReferenceData = {
  tags: string[]
  wikiTargets: string[]
}

const treeSitterTypeToMdKind = (type: string): MdKind | null => {
  switch (type) {
    case 'atx_heading':
    case 'setext_heading':
    case 'heading':
      return MD_KINDS.HEADING
    case 'paragraph':
      return MD_KINDS.PARAGRAPH
    case 'list':
      return MD_KINDS.LIST
    case 'list_item':
      return MD_KINDS.LIST_ITEM
    case 'fenced_code_block':
    case 'indented_code_block':
    case 'code_fence':
    case 'code_block':
      return MD_KINDS.CODE_BLOCK
    case 'block_quote':
    case 'blockquote':
      return MD_KINDS.BLOCKQUOTE
    case 'thematic_break':
      return MD_KINDS.HR
    case 'pipe_table':
    case 'table':
      return MD_KINDS.TABLE
    case 'html_block':
    case 'html':
      return MD_KINDS.HTML
    default:
      return null
  }
}

const getHeadingDepth = (node: Node): number | undefined => {
  const text = node.text ?? ''
  if (node.type === 'setext_heading') {
    const lines = text.trimEnd().split('\n')
    const underline = lines[lines.length - 1]?.trim() ?? ''
    if (/^=+/.test(underline)) return 1
    if (/^-+/.test(underline)) return 2
    return undefined
  }

  const match = text.match(/^\s*(#+)\s+/)
  return match ? match[1].length : undefined
}

const getHeadingText = (node: Node): string => {
  const text = node.text ?? ''
  if (node.type === 'setext_heading') {
    const firstLine = text.split('\n')[0] ?? ''
    return normalizeWhitespace(firstLine)
  }
  const stripped = text.replace(/^\s*#+\s*/, '').replace(/\s*#+\s*$/, '')
  return normalizeWhitespace(stripped)
}

const getCodeInfo = (node: Node): { lang?: string; rawContent?: string } => {
  const text = node.text ?? ''
  const lines = text.split('\n')
  const firstLine = lines[0] ?? ''
  const fenceMatch = firstLine.match(/^\s*[`~]{3,}\s*([^`~\s]+)?/)
  if (fenceMatch) {
    const lang = fenceMatch[1]?.trim() || undefined
    const body = lines.slice(1, lines.length > 1 ? -1 : 1).join('\n')
    return { lang, rawContent: body }
  }

  return { rawContent: text.replace(/^\s{4}/gm, '').trimEnd() }
}

const getMarkdownLabel = (node: Node, kind: MdKind): string => {
  const text = node.text ?? ''

  switch (kind) {
    case MD_KINDS.HEADING: {
      const depth = getHeadingDepth(node) ?? 1
      const headingText = getHeadingText(node)
      const prefix = '#'.repeat(depth)
      return headingText ? `${prefix} ${headingText}` : prefix
    }
    case MD_KINDS.PARAGRAPH:
      return truncate(normalizeWhitespace(text), 50)
    case MD_KINDS.LIST: {
      const itemCount = node.namedChildren.filter((child) => child.type === 'list_item').length
      return isOrderedList(text) ? `Ordered list (${itemCount})` : `List (${itemCount})`
    }
    case MD_KINDS.LIST_ITEM: {
      const firstLine = text.split('\n')[0] ?? ''
      const label = normalizeWhitespace(stripListMarker(firstLine))
      return truncate(label, 40) || 'List item'
    }
    case MD_KINDS.CODE_BLOCK: {
      const { lang } = getCodeInfo(node)
      return lang ? `Code (${lang})` : 'Code block'
    }
    case MD_KINDS.BLOCKQUOTE: {
      const cleaned = normalizeWhitespace(text.replace(/^\s*>?\s?/gm, ''))
      const snippet = truncate(cleaned, 40)
      return snippet ? `> ${snippet}` : '>'
    }
    case MD_KINDS.HR:
      return '---'
    case MD_KINDS.TABLE:
      return 'Table'
    case MD_KINDS.HTML: {
      const snippet = truncate(normalizeWhitespace(text), 30)
      return snippet ? `HTML: ${snippet}` : 'HTML'
    }
    default:
      return truncate(normalizeWhitespace(text), 40) || kind
  }
}

type HeadingSection = { level: number; key: string }

const collectBlockNodes = (node: Node): Node[] => {
  const nodes: Node[] = []
  for (const child of node.namedChildren) {
    if (child.type === 'inline' || child.type === 'list_item') {
      continue
    }
    const kind = treeSitterTypeToMdKind(child.type)
    if (kind) {
      nodes.push(child)
      continue
    }
    if (child.namedChildCount > 0) {
      nodes.push(...collectBlockNodes(child))
    }
  }
  return nodes
}

const buildMarkdownStableId = (fileScope: string, node: Node, kind: MdKind) =>
  `md:${fileScope}:${kind}:${node.startIndex}:${node.endIndex}`

const addMarkdownNode = (
  graph: GraphAPI,
  parentKey: string,
  node: Node,
  kind: MdKind,
  fileScope: string,
): string => {
  const ext: MdExt = { stableId: buildMarkdownStableId(fileScope, node, kind) }
  let image: string | null = null
  let headingDepth: number | undefined
  if (kind === MD_KINDS.HEADING) {
    headingDepth = getHeadingDepth(node)
    if (headingDepth !== undefined) {
      ext.headingDepth = headingDepth
    }
    image = getHeadingGlyph(headingDepth ?? 1)
  } else if (kind === MD_KINDS.CODE_BLOCK) {
    const { lang, rawContent } = getCodeInfo(node)
    ext.lang = lang
    ext.rawContent = rawContent
    image = getCodeGlyph(lang)
  } else if (kind === MD_KINDS.LIST) {
    image = getListGlyph(node)
  } else if (kind === MD_KINDS.LIST_ITEM) {
    image = getTaskListGlyph(node)
  } else if (kind === MD_KINDS.BLOCKQUOTE) {
    image = getBlockquoteGlyph(node)
  }

  const label = getMarkdownLabel(node, kind)
  const nodeKey = graph.derived.addTreeSitterNode(
    node,
    buildMdNodeAttributes(
      {
        kind,
        label,
        ...(image ? { image } : {}),
      },
      ext,
    ),
  )

  graph.durable.addHierarchyLink(
    parentKey,
    nodeKey,
    MyndlinkAttributesSchema.parse({ ...hierarchyEdgeDefaults }),
  )

  return nodeKey
}

const buildSectionHierarchy = (
  graph: GraphAPI,
  parentKey: string,
  nodes: Node[],
  fileScope: string,
): void => {
  const headingStack: HeadingSection[] = []

  const getSectionParent = () =>
    headingStack.length > 0 ? headingStack[headingStack.length - 1].key : parentKey

  const getHeadingParent = (level: number) => {
    while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
      headingStack.pop()
    }
    return getSectionParent()
  }

  for (const node of nodes) {
    const kind = treeSitterTypeToMdKind(node.type)
    if (!kind) continue

    if (kind === MD_KINDS.HEADING) {
      const level = getHeadingDepth(node) ?? 1
      const headingKey = addMarkdownNode(graph, getHeadingParent(level), node, kind, fileScope)
      headingStack.push({ level, key: headingKey })
      continue
    }

    const sectionParent = getSectionParent()

    if (kind === MD_KINDS.LIST) {
      const listKey = addMarkdownNode(graph, sectionParent, node, kind, fileScope)
      const items = node.namedChildren.filter((child) => child.type === 'list_item')
      for (const item of items) {
        addMarkdownNode(graph, listKey, item, MD_KINDS.LIST_ITEM, fileScope)
      }
      continue
    }

    if (kind === MD_KINDS.BLOCKQUOTE) {
      const blockKey = addMarkdownNode(graph, sectionParent, node, kind, fileScope)
      const blockNodes = collectBlockNodes(node)
      buildSectionHierarchy(graph, blockKey, blockNodes, fileScope)
      continue
    }

    addMarkdownNode(graph, sectionParent, node, kind, fileScope)
  }
}

type HeadingRange = {
  startIndex: number
  endIndex: number
  level: number
}

const collectHeadingNodes = (node: Node): Node[] => {
  const nodes: Node[] = []
  for (const child of node.namedChildren) {
    if (child.type === 'inline') {
      continue
    }
    const kind = treeSitterTypeToMdKind(child.type)
    if (kind === MD_KINDS.HEADING) {
      nodes.push(child)
      continue
    }
    if (child.namedChildCount > 0) {
      nodes.push(...collectHeadingNodes(child))
    }
  }
  return nodes
}

const buildHeadingRanges = (root: Node, content: string): HeadingRange[] => {
  const headings = collectHeadingNodes(root)
    .map((node) => ({
      level: getHeadingDepth(node) ?? 1,
      startIndex: node.startIndex,
    }))
    .sort((a, b) => a.startIndex - b.startIndex)

  return headings.map((heading, index) => {
    let endIndex = content.length
    for (let i = index + 1; i < headings.length; i += 1) {
      if (headings[i].level <= heading.level) {
        endIndex = headings[i].startIndex
        break
      }
    }
    return { startIndex: heading.startIndex, endIndex, level: heading.level }
  })
}

const clampHeadingLevel = (level: number) => Math.max(1, Math.min(6, level))

type HeadingRewrite = {
  text: string
  newLength: number
  headingText: string
  mapRelative: (relativeIndex: number, isEnd: boolean) => number
}

const rewriteHeadingSection = (
  sectionText: string,
  newLevel: number,
  headingNodeEnd: number,
): HeadingRewrite => {
  const firstBreak = sectionText.indexOf('\n')
  const firstLine = firstBreak === -1 ? sectionText : sectionText.slice(0, firstBreak)
  const secondStart = firstBreak === -1 ? sectionText.length : firstBreak + 1
  const secondBreak = firstBreak === -1 ? -1 : sectionText.indexOf('\n', secondStart)
  const secondLine =
    firstBreak === -1
      ? ''
      : sectionText.slice(secondStart, secondBreak === -1 ? sectionText.length : secondBreak)
  const isSetext = secondLine.length > 0 && /^\s*(=+|-+)\s*$/.test(secondLine)

  const oldPrefixEnd = isSetext
    ? secondBreak === -1
      ? sectionText.length
      : secondBreak + 1
    : firstBreak === -1
      ? sectionText.length
      : firstBreak + 1

  const hasBody = oldPrefixEnd < sectionText.length
  const headingText = isSetext
    ? firstLine.trim()
    : firstLine
        .replace(/^\s*#+\s*/, '')
        .replace(/\s*#+\s*$/, '')
        .trim()

  const level = clampHeadingLevel(newLevel)
  const hashes = '#'.repeat(level)
  const newHeadingLine = headingText ? `${hashes} ${headingText}` : hashes
  const newPrefix = newHeadingLine + (hasBody ? '\n' : '')
  const newText = newPrefix + sectionText.slice(oldPrefixEnd)

  const newHeadingLineLength = newHeadingLine.length
  const newPrefixLength = newPrefix.length
  const oldHeadingEnd = Math.min(Math.max(0, headingNodeEnd), oldPrefixEnd)

  const mapRelative = (relativeIndex: number, isEnd: boolean) => {
    if (relativeIndex < oldPrefixEnd) {
      if (isEnd && relativeIndex >= oldHeadingEnd) {
        return newHeadingLineLength
      }
      return Math.min(relativeIndex, newHeadingLineLength)
    }
    return newPrefixLength + (relativeIndex - oldPrefixEnd)
  }

  return { text: newText, newLength: newText.length, headingText, mapRelative }
}

const buildLineStarts = (content: string): number[] => {
  const starts = [0]
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') {
      starts.push(i + 1)
    }
  }
  return starts
}

const indexToPoint = (lineStarts: number[], index: number) => {
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

const createFilePosition = (
  lineStarts: number[],
  startIndex: number,
  endIndex: number,
): FilePosition => ({
  start: indexToPoint(lineStarts, startIndex),
  end: indexToPoint(lineStarts, endIndex),
  startIndex,
  endIndex,
})

const collectSubtreeKeys = (graph: GraphAPI, rootKey: string): string[] => {
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

const clearMarkdownSubtree = (graph: GraphAPI, rootKey: string) => {
  const keys = collectSubtreeKeys(graph, rootKey)
  for (const key of keys) {
    if (key === rootKey) continue
    graph.durable.removeNode(key)
  }
}

const findMarkdownFileRoot = (ctx: PluginContext, nodeKey: string) => {
  let currentKey: string | null = nodeKey
  while (currentKey) {
    const node = ctx.graph.getNode(currentKey)
    if (!node) return null
    if (isMarkdownFileNode(node.attributes)) return node
    currentKey = ctx.graph.getParent(currentKey)
  }
  return null
}

const getMarkdownExtension = (path: string) =>
  path.toLowerCase().endsWith('.markdown') ? '.markdown' : '.md'

const parseMarkdownTree = async (
  ctx: PluginContext,
  content: string,
  extension: string,
): Promise<Tree | null> => {
  if (!ctx.treeSitter.hasGrammar(extension)) {
    if (!warnedMissingMarkdownGrammar) {
      warnedMissingMarkdownGrammar = true
      ctx.ui.notify(`Markdown grammar not loaded for ${extension}`, 'error')
    }
    return null
  }
  const tree = await ctx.treeSitter.parse(content, extension)
  if (!tree) {
    if (!warnedMissingMarkdownGrammar) {
      warnedMissingMarkdownGrammar = true
      ctx.ui.notify('Failed to parse Markdown: grammar unavailable', 'error')
    }
    return null
  }
  return tree
}

const buildMarkdownGraphFromTree = (
  graph: GraphAPI,
  fileNodeKey: string,
  tree: Tree,
  fileScope: string,
) => {
  if (!tree.rootNode) {
    console.error('[MarkdownAdapter] Missing markdown tree root node', {
      path: fileScope,
      nodeKey: fileNodeKey,
    })
    return
  }
  clearMarkdownSubtree(graph, fileNodeKey)
  const blockNodes = collectBlockNodes(tree.rootNode)
  buildSectionHierarchy(graph, fileNodeKey, blockNodes, fileScope)
}

const parseMarkdownContent = async (
  ctx: PluginContext,
  nodeKey: string,
  path: string,
  content: string,
  options: { force?: boolean } = {},
): Promise<{
  references: MarkdownReferenceData
  tree: Tree | null
  fileScope: string
}> => {
  if (!path.endsWith('.md') && !path.endsWith('.markdown')) {
    return { references: { tags: [], wikiTargets: [] }, tree: null, fileScope: path }
  }

  const references = extractMarkdownReferences(content)
  const fileScope = path.replace(/\\/g, '/')
  const shouldParse = options.force || ctx.graph.getChildren(nodeKey).length === 0

  if (!shouldParse) {
    return { references, tree: null, fileScope }
  }

  const extension = getMarkdownExtension(path)
  const tree = await parseMarkdownTree(ctx, content, extension)
  return { references, tree, fileScope }
}

/**
 * Read-only structure adapter for Markdown files.
 * Uses tree-sitter to parse markdown structure.
 */
const MD_SUPPORTED_PARENT_KINDS = [...ALL_MD_KINDS, 'file'] as const

type StructureMoveContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  currentParentKey: string | null
  newParentKey: string
  newParentAttributes: MyndletAttributes
}

type StructureDeleteContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  parentKey: string | null
}

type StructureRenameContext = {
  nodeKey: string
  nodeAttributes: MyndletAttributes
  currentName: string
  newName: string
}

const createMarkdownAdapter = (ctx: PluginContext) => ({
  id: 'markdown-adapter',
  name: 'Markdown File Adapter',
  supportedChildKinds: ALL_MD_KINDS,
  supportedParentKinds: MD_SUPPORTED_PARENT_KINDS,

  matches(childKind: string | undefined, parentKind: string | undefined) {
    const childMatch = !childKind || ALL_MD_KINDS.includes(childKind)
    const parentMatch = !parentKind || MD_SUPPORTED_PARENT_KINDS.includes(parentKind)
    return childMatch && parentMatch
  },

  validateMove({ nodeAttributes, newParentAttributes }: StructureMoveContext) {
    if (!ALL_MD_KINDS.includes(nodeAttributes.kind)) {
      return { valid: false, reason: 'Not a markdown node' }
    }
    if (nodeAttributes.kind === MD_KINDS.HEADING) {
      if (newParentAttributes.kind === 'file') {
        return isMarkdownFileNode(newParentAttributes)
          ? { valid: true }
          : { valid: false, reason: 'Target file is not markdown' }
      }
      if (newParentAttributes.kind !== MD_KINDS.HEADING) {
        return { valid: false, reason: 'Sections can only be nested under headings' }
      }
      return { valid: true }
    }
    if (newParentAttributes.kind === 'file') {
      return isMarkdownFileNode(newParentAttributes)
        ? { valid: true }
        : { valid: false, reason: 'Target file is not markdown' }
    }
    return ALL_MD_KINDS.includes(newParentAttributes.kind)
      ? { valid: true }
      : { valid: false, reason: 'Invalid markdown parent' }
  },

  async applyMove({ nodeKey, newParentKey, currentParentKey }: StructureMoveContext) {
    const node = ctx.graph.getNode(nodeKey)
    const newParent = ctx.graph.getNode(newParentKey)
    if (!node || !newParent) {
      return { success: false, error: 'Node not found for move' }
    }
    if (!ALL_MD_KINDS.includes(node.attributes.kind)) {
      return { success: false, error: 'Not a markdown node' }
    }
    if (newParent.attributes.kind === 'file') {
      if (!isMarkdownFileNode(newParent.attributes)) {
        return { success: false, error: 'Target file is not markdown' }
      }
    } else if (!ALL_MD_KINDS.includes(newParent.attributes.kind)) {
      return { success: false, error: 'Invalid markdown parent for move' }
    }

    if (
      node.attributes.kind === MD_KINDS.HEADING &&
      newParent.attributes.kind !== MD_KINDS.HEADING &&
      newParent.attributes.kind !== 'file'
    ) {
      return { success: false, error: 'Sections can only be nested under headings' }
    }
    const currentParent = currentParentKey != null ? ctx.graph.getNode(currentParentKey) : null
    if (
      node.attributes.kind === MD_KINDS.HEADING &&
      currentParent &&
      currentParent.attributes.kind !== MD_KINDS.HEADING &&
      currentParent.attributes.kind !== 'file'
    ) {
      return { success: false, error: 'Sections inside lists or blockquotes cannot be moved yet' }
    }

    const rootFile = findMarkdownFileRoot(ctx, nodeKey)
    if (!rootFile?.attributes.path) {
      return { success: false, error: 'Could not find markdown file root' }
    }
    const targetRoot = findMarkdownFileRoot(ctx, newParentKey)
    if (!targetRoot || targetRoot.key !== rootFile.key) {
      return { success: false, error: 'Sections can only be moved within the same file' }
    }

    const subtreeKeys = new Set(collectSubtreeKeys(ctx.graph, nodeKey))
    if (subtreeKeys.has(newParentKey)) {
      return { success: false, error: 'Cannot move a section into its own subtree' }
    }

    try {
      const content = await ctx.files.readFile(rootFile.attributes.path)
      const filePosition = node.attributes.filePosition
      if (!filePosition) {
        return { success: false, error: 'Node is missing a file position' }
      }

      const needsHeadingRanges =
        node.attributes.kind === MD_KINDS.HEADING || newParent.attributes.kind === MD_KINDS.HEADING

      let headingRanges: HeadingRange[] | null = null

      if (needsHeadingRanges) {
        const extension = getMarkdownExtension(rootFile.attributes.path)
        if (!ctx.treeSitter.hasGrammar(extension)) {
          return { success: false, error: `Markdown grammar not loaded for ${extension}` }
        }
        const tree = await ctx.treeSitter.parse(content, extension)
        if (!tree) {
          return { success: false, error: 'Failed to parse Markdown' }
        }
        headingRanges = buildHeadingRanges(tree.rootNode, content)
      }

      const moveRange =
        node.attributes.kind === MD_KINDS.HEADING
          ? headingRanges?.find((range) => range.startIndex === filePosition.startIndex)
          : { startIndex: filePosition.startIndex, endIndex: filePosition.endIndex, level: 0 }

      if (!moveRange) {
        return { success: false, error: 'Could not locate section in file' }
      }

      const parentPosition = newParent.attributes.filePosition
      const parentRange =
        newParent.attributes.kind === MD_KINDS.HEADING
          ? headingRanges?.find((range) => range.startIndex === parentPosition?.startIndex)
          : null

      if (newParent.attributes.kind === MD_KINDS.HEADING && !parentRange) {
        return { success: false, error: 'Could not locate target section in file' }
      }

      const moveStart = moveRange.startIndex
      const moveEnd = moveRange.endIndex
      if (moveEnd <= moveStart) {
        return { success: false, error: 'Invalid markdown range' }
      }

      const originalSectionText = content.slice(moveStart, moveEnd)
      let sectionText = originalSectionText
      let sectionMap = (relativeIndex: number, _isEnd: boolean) => relativeIndex
      let newSectionLength = sectionText.length
      let updatedAttributes: Partial<MyndletAttributes> | undefined

      if (
        node.attributes.kind === MD_KINDS.HEADING &&
        newParent.attributes.kind === MD_KINDS.HEADING
      ) {
        const newLevel = clampHeadingLevel(parentRange!.level + 1)
        if (newLevel !== moveRange.level) {
          const rewrite = rewriteHeadingSection(
            originalSectionText,
            newLevel,
            filePosition.endIndex - moveStart,
          )
          sectionText = rewrite.text
          newSectionLength = rewrite.newLength
          sectionMap = rewrite.mapRelative

          const label = rewrite.headingText
            ? `${'#'.repeat(newLevel)} ${rewrite.headingText}`
            : '#'.repeat(newLevel)
          const headingGlyph = getHeadingGlyph(newLevel)
          updatedAttributes = withMdExt(
            { label, ext: node.attributes.ext, image: headingGlyph },
            { headingDepth: newLevel },
          )
        }
      }

      const targetIndex =
        newParent.attributes.kind === 'file'
          ? content.length
          : newParent.attributes.kind === MD_KINDS.HEADING
            ? parentRange!.endIndex
            : parentPosition?.endIndex

      if (targetIndex == null) {
        return { success: false, error: 'Target is missing a file position' }
      }

      if (targetIndex > moveStart && targetIndex < moveEnd) {
        return { success: false, error: 'Cannot move content inside itself' }
      }

      const oldSectionLength = moveEnd - moveStart
      const insertionIndex = targetIndex <= moveStart ? targetIndex : targetIndex - oldSectionLength

      if (
        insertionIndex === moveStart &&
        (targetIndex === moveStart || targetIndex === moveEnd) &&
        sectionText === originalSectionText
      ) {
        return updatedAttributes ? { success: true, updatedAttributes } : { success: true }
      }

      const withoutSection = content.slice(0, moveStart) + content.slice(moveEnd)
      const nextContent =
        withoutSection.slice(0, insertionIndex) + sectionText + withoutSection.slice(insertionIndex)

      await ctx.files.writeFile(rootFile.attributes.path, nextContent)

      const lineStarts = buildLineStarts(nextContent)
      const insertBefore = targetIndex <= moveStart
      const insertAfter = targetIndex >= moveEnd
      const deltaLength = newSectionLength - oldSectionLength

      const mapIndex = (index: number, isEnd: boolean) => {
        const inSection = isEnd
          ? index > moveStart && index <= moveEnd
          : index >= moveStart && index < moveEnd
        if (inSection) {
          const relativeIndex = index - moveStart
          return insertionIndex + sectionMap(relativeIndex, isEnd)
        }

        if (insertBefore) {
          if (index >= targetIndex && index < moveStart) {
            return index + newSectionLength
          }
          if (index >= moveEnd) {
            return index + deltaLength
          }
          return index
        }

        if (insertAfter) {
          if (index >= moveEnd && index < targetIndex) {
            return index - oldSectionLength
          }
          if (index >= targetIndex) {
            return index + deltaLength
          }
          return index
        }

        return index
      }

      const positionMap = new Map<string, FilePosition>()
      const keys = collectSubtreeKeys(ctx.graph, rootFile.key)
      for (const key of keys) {
        const entry = ctx.graph.getNode(key)
        const entryPosition = entry?.attributes.filePosition
        if (!entryPosition) continue
        const startIndex = mapIndex(entryPosition.startIndex, false)
        const endIndex = mapIndex(entryPosition.endIndex, true)
        positionMap.set(key, createFilePosition(lineStarts, startIndex, endIndex))
      }

      ctx.graph.batch(() => ctx.graph.derived.syncFilePositions(positionMap))

      return updatedAttributes ? { success: true, updatedAttributes } : { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to move markdown section',
      }
    }
  },

  validateCreate() {
    return { valid: false, reason: 'Create nodes by editing the markdown source' }
  },

  async applyCreate() {
    return { success: false, error: 'Markdown structure is read-only for creation' }
  },

  validateDelete({ nodeAttributes }: StructureDeleteContext) {
    if (!ALL_MD_KINDS.includes(nodeAttributes.kind)) {
      return { valid: false, reason: 'Not a markdown node' }
    }
    // Headings and other block elements can be deleted
    return { valid: true }
  },

  async applyDelete({ nodeKey, nodeAttributes }: StructureDeleteContext) {
    if (!ALL_MD_KINDS.includes(nodeAttributes.kind)) {
      return { success: false, error: 'Not a markdown node' }
    }

    const rootFile = findMarkdownFileRoot(ctx, nodeKey)
    if (!rootFile?.attributes.path) {
      return { success: false, error: 'Could not find markdown file root' }
    }

    const filePosition = nodeAttributes.filePosition
    if (!filePosition) {
      return { success: false, error: 'Node is missing a file position' }
    }

    try {
      const content = await ctx.files.readFile(rootFile.attributes.path)

      // For headings, we need to delete the entire section (heading + content until next same/higher level heading)
      const deleteStart = filePosition.startIndex
      let deleteEnd = filePosition.endIndex

      if (nodeAttributes.kind === MD_KINDS.HEADING) {
        const extension = getMarkdownExtension(rootFile.attributes.path)
        if (ctx.treeSitter.hasGrammar(extension)) {
          const tree = await ctx.treeSitter.parse(content, extension)
          if (tree) {
            const headingRanges = buildHeadingRanges(tree.rootNode, content)
            const sectionRange = headingRanges.find((r) => r.startIndex === filePosition.startIndex)
            if (sectionRange) {
              deleteEnd = sectionRange.endIndex
            }
          }
        }
      }

      // Remove the content
      const newContent = content.slice(0, deleteStart) + content.slice(deleteEnd)

      await ctx.files.writeFile(rootFile.attributes.path, newContent)

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to delete markdown content',
      }
    }
  },

  validateRename({ nodeAttributes }: StructureRenameContext) {
    if (!ALL_MD_KINDS.includes(nodeAttributes.kind)) {
      return { valid: false, reason: 'Not a markdown node' }
    }
    // Only headings can be meaningfully renamed
    if (nodeAttributes.kind !== MD_KINDS.HEADING) {
      return { valid: false, reason: 'Only headings can be renamed' }
    }
    return { valid: true }
  },

  async applyRename({ nodeKey, nodeAttributes, newName }: StructureRenameContext) {
    if (nodeAttributes.kind !== MD_KINDS.HEADING) {
      return { success: false, error: 'Only headings can be renamed' }
    }

    const rootFile = findMarkdownFileRoot(ctx, nodeKey)
    if (!rootFile?.attributes.path) {
      return { success: false, error: 'Could not find markdown file root' }
    }

    const filePosition = nodeAttributes.filePosition
    if (!filePosition) {
      return { success: false, error: 'Node is missing a file position' }
    }

    try {
      const content = await ctx.files.readFile(rootFile.attributes.path)
      const headingLine = content.slice(filePosition.startIndex, filePosition.endIndex)

      // Parse the heading to get the level (number of #)
      const match = headingLine.match(/^(#{1,6})\s*/)
      if (!match) {
        return { success: false, error: 'Could not parse heading format' }
      }

      const prefix = match[1] // The # characters
      const newHeadingLine = `${prefix} ${newName.trim()}`

      // Find the end of the heading line (before newline)
      let lineEnd = filePosition.startIndex
      while (lineEnd < content.length && content[lineEnd] !== '\n') {
        lineEnd++
      }

      const newContent =
        content.slice(0, filePosition.startIndex) + newHeadingLine + content.slice(lineEnd)

      await ctx.files.writeFile(rootFile.attributes.path, newContent)

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to rename heading',
      }
    }
  },
})

export {
  MD_KINDS,
  MD_TAG_KIND,
  getTagGlyph,
  initializeGlyphs,
  createMarkdownAdapter,
  isMarkdownFileNode,
  extractMarkdownReferences,
  buildMarkdownFileIndex,
  resolveWikiLinkTarget,
  ensureTagNode,
  addReferenceEdge,
  parseMarkdownContent,
  buildMarkdownGraphFromTree,
  clearMarkdownSubtree,
}

export type { MarkdownReferenceData }
