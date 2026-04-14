import type { MyndraPluginModule, Tree, AdapterMutationResult } from '@myndra/plugin-sdk'
import { markdown } from '@codemirror/lang-markdown'
import {
  MD_KINDS,
  MD_TAG_KIND,
  getTagGlyph,
  initializeGlyphs,
  isMarkdownFileNode,
  buildMarkdownFileIndex,
  resolveWikiLinkTarget,
  ensureTagNode,
  addReferenceEdge,
  extractMarkdownReferences,
  parseMarkdownContent,
  buildMarkdownGraphFromTree,
  createMarkdownAdapter,
  type MarkdownReferenceData,
  MARKDOWN_ADAPTER_ID,
} from './markdownAdapter'
import {
  createSessionGraphCollector,
  type SessionGraphPayload,
} from '@myndra/plugin-sdk/helpers'

const normalizePath = (input: string) => input.replace(/\\/g, '/')

let unregisterPreview: (() => void) | null = null

const MARKDOWN_EXTENSIONS = ['.md', '.markdown']

const plugin: MyndraPluginModule = {
  extensions: () => MARKDOWN_EXTENSIONS,
  async activate(ctx) {
    MARKDOWN_EXTENSIONS.forEach((extension) =>
      ctx.editor.registerExtensions(extension, [markdown()]),
    )

    ctx.filePreview.registerAdapter({
      extensions: MARKDOWN_EXTENSIONS,
      buildDraftPayload: async ({ nodeKey, filePath, content }) => {
        const extension = filePath.toLowerCase().endsWith('.markdown') ? '.markdown' : '.md'
        const tree = await ctx.treeSitter.parse(content, extension)
        const references = extractMarkdownReferences(content)
        const collector = createSessionGraphCollector()
        const fileScope = normalizePath(filePath)

        if (tree) {
          buildMarkdownGraphFromTree(collector.graph, nodeKey, tree, fileScope)
        }

        const fileIndex = buildMarkdownFileIndex(ctx)
        for (const tag of references.tags) {
          const tagKey = ensureTagNode(collector.graph, tag)
          addReferenceEdge(collector.graph, nodeKey, tagKey)
        }

        for (const target of references.wikiTargets) {
          const resolved = resolveWikiLinkTarget(collector.graph, fileIndex, nodeKey, target)
          if (!resolved || resolved === nodeKey) continue
          addReferenceEdge(collector.graph, nodeKey, resolved)
        }

        return collector.getPayload()
      },
    })
    unregisterPreview = () => ctx.filePreview.unregisterAdapter()

    // Initialize glyph paths relative to the plugin's asset base URL.
    initializeGlyphs((name) => ctx.resolveAsset(name))

    ctx.glyphs.register(MD_KINDS.HEADING, ctx.resolveAsset('title.png'))
    ctx.glyphs.register(MD_KINDS.PARAGRAPH, ctx.resolveAsset('notes.png'))
    ctx.glyphs.register(MD_KINDS.LIST, ctx.resolveAsset('format_list_bulleted.svg'))
    ctx.glyphs.register(MD_KINDS.LIST_ITEM, ctx.resolveAsset('chevron_right.png'))
    ctx.glyphs.register(MD_KINDS.CODE_BLOCK, ctx.resolveAsset('code.png'))
    ctx.glyphs.register(MD_KINDS.BLOCKQUOTE, ctx.resolveAsset('format_quote.png'))
    ctx.glyphs.register(MD_KINDS.HR, ctx.resolveAsset('horizontal_rule.png'))
    ctx.glyphs.register(MD_KINDS.TABLE, ctx.resolveAsset('table.png'))
    ctx.glyphs.register(MD_KINDS.HTML, ctx.resolveAsset('code.png'))
    ctx.glyphs.register(MD_TAG_KIND, getTagGlyph())
    const mdStructureAdapter = createMarkdownAdapter(ctx)

    const allMdKinds = Object.values(MD_KINDS)

    ctx.hierarchy.registerAdapter({
      id: MARKDOWN_ADAPTER_ID,
      name: 'Markdown Structure Adapter',
      supportedChildKinds: allMdKinds,
      supportedParentKinds: [...allMdKinds, 'file'],

      handlers: {
        async onMove(moveCtx): Promise<AdapterMutationResult> {
          const node = ctx.graph.getNode(moveCtx.nodeKey)
          const newParent = ctx.graph.getNode(moveCtx.newParentKey)
          if (!node || !newParent) {
            return { success: false, error: 'Node or parent not found' }
          }

          const validation = mdStructureAdapter.validateMove({
            nodeKey: moveCtx.nodeKey,
            nodeAttributes: node.attributes,
            currentParentKey: moveCtx.currentParentKey,
            newParentKey: moveCtx.newParentKey,
            newParentAttributes: newParent.attributes,
          })

          if (!validation.valid) {
            return { success: false, error: validation.reason }
          }

          const result = await mdStructureAdapter.applyMove({
            nodeKey: moveCtx.nodeKey,
            nodeAttributes: node.attributes,
            currentParentKey: moveCtx.currentParentKey,
            newParentKey: moveCtx.newParentKey,
            newParentAttributes: newParent.attributes,
          })

          // File watcher will trigger re-render after file is written
          return {
            success: result.success,
            error: result.error,
          }
        },

        async onDelete(deleteCtx): Promise<AdapterMutationResult> {
          const node = ctx.graph.getNode(deleteCtx.nodeKey)
          if (!node) {
            return { success: false, error: 'Node not found' }
          }

          const parentKey = ctx.graph.getParent(deleteCtx.nodeKey)
          const validation = mdStructureAdapter.validateDelete({
            nodeKey: deleteCtx.nodeKey,
            nodeAttributes: node.attributes,
            parentKey,
          })

          if (!validation.valid) {
            return { success: false, error: validation.reason }
          }

          const result = await mdStructureAdapter.applyDelete({
            nodeKey: deleteCtx.nodeKey,
            nodeAttributes: node.attributes,
            parentKey,
          })

          // File watcher will trigger re-render after file is written
          return {
            success: result.success,
            error: result.error,
          }
        },

        async onRename(renameCtx): Promise<AdapterMutationResult> {
          const node = ctx.graph.getNode(renameCtx.nodeKey)
          if (!node) {
            return { success: false, error: 'Node not found' }
          }

          const validation = mdStructureAdapter.validateRename({
            nodeKey: renameCtx.nodeKey,
            nodeAttributes: node.attributes,
            currentName: renameCtx.currentLabel,
            newName: renameCtx.newLabel,
          })

          if (!validation.valid) {
            return { success: false, error: validation.reason }
          }

          const result = await mdStructureAdapter.applyRename({
            nodeKey: renameCtx.nodeKey,
            nodeAttributes: node.attributes,
            currentName: renameCtx.currentLabel,
            newName: renameCtx.newLabel,
          })

          // File watcher will trigger re-render after file is written
          return {
            success: result.success,
            error: result.error,
          }
        },
      },
    })

    const openFilesBySession = new Map<string, string>()
    const renderPayloadsByFile = new Map<string, SessionGraphPayload>()
    let scopeRequestId = 0

    type ParsedMarkdownEntry = {
      nodeKey: string
      tree: Tree | null
      fileScope: string
      references: MarkdownReferenceData
    }

    const addReferenceEdges = (
      graph: ReturnType<typeof createSessionGraphCollector>['graph'],
      nodeKey: string,
      references: MarkdownReferenceData,
      fileIndex: ReturnType<typeof buildMarkdownFileIndex>,
    ) => {
      for (const tag of references.tags) {
        const tagKey = ensureTagNode(graph, tag)
        addReferenceEdge(graph, nodeKey, tagKey)
      }

      for (const target of references.wikiTargets) {
        const resolvedKey = resolveWikiLinkTarget(graph, fileIndex, nodeKey, target)
        if (!resolvedKey || resolvedKey === nodeKey) continue
        addReferenceEdge(graph, nodeKey, resolvedKey)
      }
    }

    const buildRenderPayload = (parsed: ParsedMarkdownEntry) => {
      const collector = createSessionGraphCollector()
      if (parsed.tree) {
        buildMarkdownGraphFromTree(collector.graph, parsed.nodeKey, parsed.tree, parsed.fileScope)
      }
      const fileIndex = buildMarkdownFileIndex(ctx)
      addReferenceEdges(collector.graph, parsed.nodeKey, parsed.references, fileIndex)
      return collector.getPayload()
    }

    const injectSessionPayload = (sessionId: string | undefined, nodeKey: string) => {
      const payload = renderPayloadsByFile.get(nodeKey)
      if (!payload) {
        if (sessionId) ctx.graph.session.clear(sessionId)
        else ctx.graph.session.clear()
        return
      }
      ctx.graph.session.inject({
        sessionId,
        nodes: payload.nodes,
        edges: payload.edges,
      })
    }

    const parseMarkdownEntries = async (
      entries: Array<{ nodeKey: string; path: string; force: boolean }>,
      requestId?: number,
    ): Promise<ParsedMarkdownEntry[]> => {
      if (!entries.length) return []
      const readResults = await ctx.files.readFiles(entries.map((entry) => entry.path))
      const parsedEntries: ParsedMarkdownEntry[] = []

      for (let index = 0; index < entries.length; index += 1) {
        if (requestId !== undefined && requestId !== scopeRequestId) {
          return []
        }
        const entry = entries[index]
        const readResult = readResults[index]
        if (!readResult || readResult.content === null) {
          console.error('[MarkdownAdapter] Failed to read Markdown', {
            path: entry.path,
            error: readResult?.error,
          })
          renderPayloadsByFile.delete(entry.nodeKey)
          continue
        }

        try {
          const result = await parseMarkdownContent(
            ctx,
            entry.nodeKey,
            entry.path,
            readResult.content,
            { force: entry.force },
          )
          parsedEntries.push({
            nodeKey: entry.nodeKey,
            tree: result.tree,
            fileScope: result.fileScope,
            references: result.references,
          })
        } catch (error) {
          console.error('[MarkdownAdapter] Failed to parse Markdown', {
            path: entry.path,
            nodeKey: entry.nodeKey,
            error,
          })
          renderPayloadsByFile.delete(entry.nodeKey)
        }
      }

      return parsedEntries
    }

    const setSessionOpenFile = (sessionId: string | undefined, nodeKey: string | null) => {
      if (!sessionId) return
      const previous = openFilesBySession.get(sessionId)
      if (previous && previous !== nodeKey) {
        ctx.graph.session.clear(sessionId)
      }
      if (nodeKey) {
        openFilesBySession.set(sessionId, nodeKey)
      } else {
        openFilesBySession.delete(sessionId)
      }
    }

    const enableFullScope = async () => {
      const requestId = ++scopeRequestId

      const entries = ctx.graph
        .findNodes(({ attributes }) => isMarkdownFileNode(attributes))
        .map((node) => ({
          nodeKey: node.key,
          path: node.attributes.path,
        }))
        .filter((entry): entry is { nodeKey: string; path: string } => Boolean(entry.path))
        .map((entry) => ({ nodeKey: entry.nodeKey, path: entry.path, force: true }))

      const parsedEntries = await parseMarkdownEntries(entries, requestId)
      if (requestId !== scopeRequestId) return

      const collector = createSessionGraphCollector()
      for (const parsed of parsedEntries) {
        if (parsed.tree) {
          buildMarkdownGraphFromTree(collector.graph, parsed.nodeKey, parsed.tree, parsed.fileScope)
        }
      }

      const fileIndex = buildMarkdownFileIndex(ctx)
      for (const parsed of parsedEntries) {
        addReferenceEdges(collector.graph, parsed.nodeKey, parsed.references, fileIndex)
      }

      const payload = collector.getPayload()
      ctx.graph.session.inject({ nodes: payload.nodes, edges: payload.edges })
    }

    const disableFullScope = () => {
      scopeRequestId += 1
      ctx.graph.session.clear()
    }

    ctx.events.on('graph:plugin-scope', async ({ pluginId, scope }) => {
      if (pluginId !== ctx.manifest.name) return
      if (scope === 'full') {
        await enableFullScope()
      } else {
        disableFullScope()
      }
    })

    ctx.events.on('file:opened', async ({ nodeKey, path, sessionId }) => {
      setSessionOpenFile(sessionId, nodeKey)
      const parsedEntries = await parseMarkdownEntries([{ nodeKey, path, force: true }])
      const parsed = parsedEntries[0]
      if (!parsed) {
        injectSessionPayload(sessionId, nodeKey)
        return
      }
      const payload = buildRenderPayload(parsed)
      renderPayloadsByFile.set(nodeKey, payload)
      injectSessionPayload(sessionId, nodeKey)
    })

    ctx.events.on('file:closed', ({ nodeKey, sessionId }) => {
      if (!sessionId) {
        ctx.graph.session.clear()
        return
      }
      const previous = openFilesBySession.get(sessionId)
      if (previous !== nodeKey) return
      ctx.graph.session.clear(sessionId)
      openFilesBySession.delete(sessionId)
    })

    ctx.events.on('file:changed', async ({ nodeKey, path }) => {
      const parsedEntries = await parseMarkdownEntries([{ nodeKey, path, force: true }])
      const parsed = parsedEntries[0]
      if (parsed) {
        const payload = buildRenderPayload(parsed)
        renderPayloadsByFile.set(nodeKey, payload)
      }

      for (const [sessionId, openNodeKey] of openFilesBySession.entries()) {
        if (openNodeKey === nodeKey) {
          injectSessionPayload(sessionId, nodeKey)
        }
      }
    })
  },

  deactivate() {
    if (!unregisterPreview) return
    unregisterPreview()
    unregisterPreview = null
  },
}

export default plugin
