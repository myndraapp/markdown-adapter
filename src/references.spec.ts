import { describe, expect, it } from 'vitest'
import { createSessionGraphCollector } from '@myndra/plugin-sdk/helpers'
import { getMyndlinkDefaults, type MyndletAttributes } from '@myndra/plugin-sdk/schemas'
import type { GraphAPI, IndexedFile } from '@myndra/plugin-sdk'
import {
  addReferenceEdge,
  buildMarkdownFileIndexFromFiles,
  ensureWikiLinkNode,
  extractMarkdownReferences,
  resolveWikiLinkTarget,
} from './references'
import {
  MD_EXT_NAMESPACE,
  MD_KINDS,
  MD_WIKILINK_KIND,
  buildMdNodeAttributes,
  getMdExtFromPartial,
} from './kinds'

const basename = (path: string) => path.split('/').pop() ?? path

const markdownFileAttributes = (path: string, stableId: string): MyndletAttributes =>
  buildMdNodeAttributes(
    {
      kind: 'file',
      label: basename(path),
      path,
    },
    { isMarkdownFile: true, stableId },
  )

const indexedFile = (nodeKey: string, path: string): IndexedFile => ({
  nodeKey,
  path,
  attributes: markdownFileAttributes(path, `indexed:${nodeKey}`),
})

const addMarkdownFile = (graph: GraphAPI, path: string, stableId: string) =>
  graph.durable.addNode(markdownFileAttributes(path, stableId))

const addHeading = (graph: GraphAPI, fileKey: string, label: string, stableId: string) => {
  const headingKey = graph.durable.addNode(
    buildMdNodeAttributes(
      {
        kind: MD_KINDS.HEADING,
        label,
      },
      { stableId },
    ),
  )
  graph.durable.addHierarchyLink(fileKey, headingKey, getMyndlinkDefaults('hierarchy'))
  return headingKey
}

describe('markdown references', () => {
  it('extracts tags and wikilinks while ignoring markdown code', () => {
    const references = extractMarkdownReferences(`
Body #Project/Alpha and [[Note|Alias]] plus [[Folder/Other.md#Details]].
\`#ignored [[InlineIgnored]]\`

\`\`\`
#also-ignored [[CodeIgnored]]
\`\`\`

Duplicate #project/alpha and [[Note|Alias]].
`)

    expect(references.tags).toEqual(['project/alpha'])
    expect(references.wikiTargets).toEqual(['Note', 'Folder/Other.md#Details'])
  })

  it('resolves basename wikilinks relative to the source directory before workspace fallback', () => {
    const { graph } = createSessionGraphCollector()
    const index = buildMarkdownFileIndexFromFiles([
      indexedFile('source', 'notes/current.md'),
      indexedFile('same-dir', 'notes/note.md'),
      indexedFile('other-dir', 'archive/note.md'),
    ])

    expect(resolveWikiLinkTarget(graph, index, 'source', 'Note')).toBe('same-dir')
  })

  it('treats ambiguous basename wikilinks as unresolved', () => {
    const { graph } = createSessionGraphCollector()
    const index = buildMarkdownFileIndexFromFiles([
      indexedFile('source', 'notes/current.md'),
      indexedFile('first', 'a/note.md'),
      indexedFile('second', 'b/note.md'),
    ])

    expect(resolveWikiLinkTarget(graph, index, 'source', 'Note')).toBeNull()
  })

  it('resolves path-like wikilinks with and without markdown extensions', () => {
    const { graph } = createSessionGraphCollector()
    const index = buildMarkdownFileIndexFromFiles([
      indexedFile('source', 'notes/current.md'),
      indexedFile('relative', 'notes/folder/note.md'),
      indexedFile('root', 'folder/note.md'),
    ])

    expect(resolveWikiLinkTarget(graph, index, 'source', 'folder/Note')).toBe('relative')
    expect(resolveWikiLinkTarget(graph, index, 'source', 'folder/Note.md')).toBe('relative')
  })

  it('resolves raw aliased wikilinks to the non-aliased target', () => {
    const { graph } = createSessionGraphCollector()
    const index = buildMarkdownFileIndexFromFiles([
      indexedFile('source', 'notes/current.md'),
      indexedFile('target', 'notes/note.md'),
    ])

    expect(resolveWikiLinkTarget(graph, index, 'source', 'Note|Readable Alias')).toBe('target')
  })

  it('resolves heading wikilinks to parsed heading nodes when available', () => {
    const { graph } = createSessionGraphCollector()
    const source = addMarkdownFile(graph, 'notes/current.md', 'source-file')
    const target = addMarkdownFile(graph, 'notes/target.md', 'target-file')
    const sourceHeading = addHeading(graph, source, '## Local Details', 'source-heading')
    const targetHeading = addHeading(graph, target, '### Details', 'target-heading')
    const index = buildMarkdownFileIndexFromFiles([
      indexedFile(source, 'notes/current.md'),
      indexedFile(target, 'notes/target.md'),
    ])

    expect(resolveWikiLinkTarget(graph, index, source, '#Local Details')).toBe(sourceHeading)
    expect(resolveWikiLinkTarget(graph, index, source, 'Target#Details')).toBe(targetHeading)
  })

  it('treats missing heading targets as unresolved', () => {
    const { graph } = createSessionGraphCollector()
    const source = addMarkdownFile(graph, 'notes/current.md', 'source-file')
    const target = addMarkdownFile(graph, 'notes/target.md', 'target-file')
    addHeading(graph, target, '## Existing', 'target-heading')
    const index = buildMarkdownFileIndexFromFiles([
      indexedFile(source, 'notes/current.md'),
      indexedFile(target, 'notes/target.md'),
    ])

    expect(resolveWikiLinkTarget(graph, index, source, 'Target#Missing')).toBeNull()
  })

  it('creates a placeholder wikilink node and outgoing reference edge for unresolved targets', () => {
    const collector = createSessionGraphCollector()
    const source = addMarkdownFile(collector.graph, 'notes/current.md', 'source-file')
    const index = buildMarkdownFileIndexFromFiles([indexedFile(source, 'notes/current.md')])
    const resolved = resolveWikiLinkTarget(collector.graph, index, source, 'Missing Note')
    const target = resolved ?? ensureWikiLinkNode(collector.graph, 'Missing Note')

    addReferenceEdge(collector.graph, source, target)

    const payload = collector.getPayload()
    const placeholder = payload.nodes.find((node) => node.key === target)
    const edge = payload.edges.find((candidate) => candidate.source === source)

    expect(placeholder?.attributes.kind).toBe(MD_WIKILINK_KIND)
    expect(placeholder?.attributes.label).toBe('[[Missing Note]]')
    expect(getMdExtFromPartial(placeholder?.attributes).wikiTarget).toBe('Missing Note')
    expect(placeholder?.attributes.ext?.[MD_EXT_NAMESPACE]).toBeDefined()
    expect(edge?.target).toBe(target)
    expect(edge?.attributes).toMatchObject({ kind: 'reference', direction: 'outgoing' })
  })

  it('uses existing file targets in payloads when wikilinks resolve uniquely', () => {
    const collector = createSessionGraphCollector()
    const source = addMarkdownFile(collector.graph, 'notes/current.md', 'source-file')
    const target = addMarkdownFile(collector.graph, 'notes/target.md', 'target-file')
    const index = buildMarkdownFileIndexFromFiles([
      indexedFile(source, 'notes/current.md'),
      indexedFile(target, 'notes/target.md'),
    ])
    const resolved = resolveWikiLinkTarget(collector.graph, index, source, 'Target')

    expect(resolved).toBe(target)
    if (!resolved) throw new Error('Expected Target wikilink to resolve')
    addReferenceEdge(collector.graph, source, resolved)

    const payload = collector.getPayload()
    expect(payload.nodes.some((node) => node.attributes.kind === MD_WIKILINK_KIND)).toBe(false)
    expect(payload.edges.some((edge) => edge.source === source && edge.target === target)).toBe(
      true,
    )
  })

  it('falls back to placeholders for ambiguous existing-file matches', () => {
    const collector = createSessionGraphCollector()
    const source = addMarkdownFile(collector.graph, 'notes/current.md', 'source-file')
    const index = buildMarkdownFileIndexFromFiles([
      indexedFile(source, 'notes/current.md'),
      indexedFile('first', 'a/note.md'),
      indexedFile('second', 'b/note.md'),
    ])
    const resolved = resolveWikiLinkTarget(collector.graph, index, source, 'Note')
    const target = resolved ?? ensureWikiLinkNode(collector.graph, 'Note')

    addReferenceEdge(collector.graph, source, target)

    const payload = collector.getPayload()
    expect(resolved).toBeNull()
    expect(payload.nodes.find((node) => node.key === target)?.attributes.kind).toBe(
      MD_WIKILINK_KIND,
    )
    expect(payload.edges.some((edge) => edge.source === source && edge.target === target)).toBe(
      true,
    )
  })
})
