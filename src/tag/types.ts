/** Tag 本地/远端同步态 */
export type TagSyncStatus = 'local' | 'remote' | 'both' | 'diverged'

export type TagInfo = {
  name: string
  /** 指向的 commit（短） */
  commit: string
  /** 完整 object（若能解析） */
  object?: string
  annotation?: string
  tagger?: string
  when?: string
  sync: TagSyncStatus
  /** 远端指向的 commit（与本地不一致时） */
  remoteCommit?: string
}

export type CreateTagOptions = {
  name: string
  message?: string
  /** lightweight | annotated */
  kind: 'lightweight' | 'annotated'
  /** 可选：指向的 ref/commit，默认 HEAD */
  ref?: string
}
