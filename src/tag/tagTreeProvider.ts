import {
  Event,
  EventEmitter,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState
} from 'vscode'
import type { TagInfo, TagSyncStatus } from './types'
import { TagService } from './tagService'

const syncIcon = (sync: TagSyncStatus): ThemeIcon => {
  switch (sync) {
    case 'both':
      return new ThemeIcon('cloud')
    case 'local':
      return new ThemeIcon('home')
    case 'remote':
      return new ThemeIcon('cloud-download')
    case 'diverged':
      return new ThemeIcon('warning')
  }
}

const syncLabel = (sync: TagSyncStatus): string => {
  switch (sync) {
    case 'both':
      return '本地+远端'
    case 'local':
      return '仅本地'
    case 'remote':
      return '仅远端'
    case 'diverged':
      return '本地/远端不一致'
  }
}

export class TagTreeItem extends TreeItem {
  constructor(public readonly tag: TagInfo) {
    super(tag.name, TreeItemCollapsibleState.None)
    this.description = `${tag.commit} · ${syncLabel(tag.sync)}`
    this.tooltip = [
      tag.name,
      `commit: ${tag.commit}`,
      tag.remoteCommit ? `remote: ${tag.remoteCommit}` : undefined,
      tag.annotation ? `msg: ${tag.annotation}` : undefined,
      tag.tagger ? `tagger: ${tag.tagger}` : undefined,
      tag.when ? `when: ${tag.when}` : undefined,
      `sync: ${syncLabel(tag.sync)}`
    ]
      .filter(Boolean)
      .join('\n')
    this.iconPath = syncIcon(tag.sync)
    this.contextValue = `simpleLogsTag.${tag.sync}`
    this.command = {
      command: 'simple-logs.tags.showDetails',
      title: 'Show Tag Details',
      arguments: [this]
    }
  }
}

export class TagTreeProvider implements TreeDataProvider<TagTreeItem> {
  private readonly _onDidChangeTreeData = new EventEmitter<TagTreeItem | undefined | void>()
  readonly onDidChangeTreeData: Event<TagTreeItem | undefined | void> = this._onDidChangeTreeData.event

  private tags: TagInfo[] = []
  private remote?: string
  private repoRoot?: string

  constructor(private readonly service: TagService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  getRemote(): string | undefined {
    return this.remote
  }

  getRepoRoot(): string | undefined {
    return this.repoRoot
  }

  getChildren(): Thenable<TagTreeItem[]> {
    return this.service.listTags().then(result => {
      if (!result) {
        this.tags = []
        this.remote = undefined
        this.repoRoot = undefined
        return []
      }
      this.tags = result.tags
      this.remote = result.remote
      this.repoRoot = result.repoRoot
      return result.tags.map(t => new TagTreeItem(t))
    })
  }

  getTreeItem(element: TagTreeItem): TreeItem {
    return element
  }
}
