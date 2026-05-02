import { MyndlinkAttributesSchema } from '@myndra/plugin-sdk/schemas'
import type { PluginContext, Node, Tree, GraphAPI } from '@myndra/plugin-sdk'
import {
  MD_KINDS,
  type MdKind,
  type MdExt,
  hierarchyEdgeDefaults,
  buildMdNodeAttributes,
  normalizeWhitespace,
  truncate,
  stripListMarker,
  isOrderedList,
  clearMarkdownSubtree,
  getMarkdownExtension,
  isMarkdownFileNode,
} from './kinds'
import {
  getHeadingGlyph,
  getListGlyph,
  getTaskListGlyph,
  getCodeGlyph,
  getBlockquoteGlyph,
} from './glyphs'
import type { MarkdownReferenceData } from './references'
import { extractMarkdownReferences } from './references'

let warnedMissingMarkdownGrammar = false

export const treeSitterTypeToMdKind = (type: string): MdKind | null => {
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

export const getHeadingDepth = (node: Node): number | undefined => {
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

export const collectBlockNodes = (node: Node): Node[] => {
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

export type HeadingRange = {
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

export const buildHeadingRanges = (root: Node, content: string): HeadingRange[] => {
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

export const clampHeadingLevel = (level: number) => Math.max(1, Math.min(6, level))

export type HeadingRewrite = {
  text: string
  newLength: number
  headingText: string
  mapRelative: (relativeIndex: number, isEnd: boolean) => number
}

export const rewriteHeadingSection = (
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

export const buildMarkdownGraphFromTree = (
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

export const parseMarkdownContent = async (
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

export const findMarkdownFileRoot = (ctx: PluginContext, nodeKey: string) => {
  let currentKey: string | null = nodeKey
  while (currentKey) {
    const node = ctx.graph.getNode(currentKey)
    if (!node) return null
    if (isMarkdownFileNode(node.attributes)) return node
    currentKey = ctx.graph.getParent(currentKey)
  }
  return null
}
