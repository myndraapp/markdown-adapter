import { MyndlinkAttributesSchema } from '@myndra/plugin-sdk/schemas'
import type { PluginContext, GraphAPI } from '@myndra/plugin-sdk'
import {
  MD_KINDS,
  MD_TAG_KIND,
  referenceEdgeDefaults,
  isMarkdownFileNode,
  buildMdNodeAttributes,
  normalizeWhitespace,
} from './kinds'
import { getTagGlyph } from './glyphs'

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

export type MarkdownFileIndexEntry = {
  key: string
  path: string
  pathLower: string
  pathNoExtLower: string
  stemLower: string
}

export const buildMarkdownFileIndex = (ctx: PluginContext): MarkdownFileIndexEntry[] =>
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

export const resolveWikiLinkTarget = (
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

export const extractMarkdownReferences = (content: string) => {
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

export type MarkdownReferenceData = {
  tags: string[]
  wikiTargets: string[]
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

export const addReferenceEdge = (
  graph: GraphAPI,
  sourceKey: string,
  targetKey: string,
): string | null => {
  if (hasReferenceEdge(graph, sourceKey, targetKey)) return null
  return graph.durable.addReferenceLink(
    sourceKey,
    targetKey,
    MyndlinkAttributesSchema.parse({ ...referenceEdgeDefaults, direction: 'outgoing' }),
  )
}

export const ensureTagNode = (graph: GraphAPI, tagName: string): string =>
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
