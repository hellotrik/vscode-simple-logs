import type { TagInfo } from './types'

export type TagSortOrder =
  | 'commitDesc'
  | 'commitAsc'
  | 'versionDesc'
  | 'versionAsc'
  | 'nameAsc'
  | 'dateDesc'

/** 从 tag 名解析 leading semver（可选 v 前缀）；非版本返回 null */
export const parseLeadingSemver = (name: string): [number, number, number, string] | null => {
  const m = name.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?([-+].*)?$/i)
  if (!m) {
    return null
  }
  return [
    parseInt(m[1], 10) || 0,
    parseInt(m[2] ?? '0', 10) || 0,
    parseInt(m[3] ?? '0', 10) || 0,
    m[4] ?? ''
  ]
}

const compareSemverTuple = (
  a: [number, number, number, string],
  b: [number, number, number, string]
): number => {
  if (a[0] !== b[0]) {
    return a[0] - b[0]
  }
  if (a[1] !== b[1]) {
    return a[1] - b[1]
  }
  if (a[2] !== b[2]) {
    return a[2] - b[2]
  }
  if (a[3] === b[3]) {
    return 0
  }
  if (!a[3]) {
    return 1
  }
  if (!b[3]) {
    return -1
  }
  return a[3].localeCompare(b[3])
}

const compareByVersion = (a: TagInfo, b: TagInfo): number => {
  const sa = parseLeadingSemver(a.name)
  const sb = parseLeadingSemver(b.name)
  if (sa && sb) {
    return compareSemverTuple(sa, sb)
  }
  if (sa && !sb) {
    return -1
  }
  if (!sa && sb) {
    return 1
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

const parseTime = (iso?: string): number => {
  if (!iso) {
    return NaN
  }
  return Date.parse(iso)
}

/** 按指向的 commit 时间（树节点）；无则退回 tagger 时间 / 名字 */
const compareByCommitTime = (a: TagInfo, b: TagInfo): number => {
  const ta = parseTime(a.commitWhen)
  const tb = parseTime(b.commitWhen)
  const aOk = !Number.isNaN(ta)
  const bOk = !Number.isNaN(tb)
  if (aOk && bOk && ta !== tb) {
    return ta - tb
  }
  if (aOk && !bOk) {
    return 1
  }
  if (!aOk && bOk) {
    return -1
  }
  const wa = parseTime(a.when)
  const wb = parseTime(b.when)
  if (!Number.isNaN(wa) && !Number.isNaN(wb) && wa !== wb) {
    return wa - wb
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

const compareByTaggerDate = (a: TagInfo, b: TagInfo): number => {
  const ta = parseTime(a.when)
  const tb = parseTime(b.when)
  const aOk = !Number.isNaN(ta)
  const bOk = !Number.isNaN(tb)
  if (aOk && bOk && ta !== tb) {
    return ta - tb
  }
  if (aOk && !bOk) {
    return 1
  }
  if (!aOk && bOk) {
    return -1
  }
  return compareByCommitTime(a, b)
}

export const sortTags = (tags: TagInfo[], order: TagSortOrder): TagInfo[] => {
  const copy = [...tags]
  switch (order) {
    case 'commitAsc':
      return copy.sort(compareByCommitTime)
    case 'versionAsc':
      return copy.sort(compareByVersion)
    case 'versionDesc':
      return copy.sort((a, b) => -compareByVersion(a, b))
    case 'nameAsc':
      return copy.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      )
    case 'dateDesc':
      return copy.sort((a, b) => -compareByTaggerDate(a, b))
    case 'commitDesc':
    default:
      // 默认：指向的 commit 越新越靠上（与 git log 一致）
      return copy.sort((a, b) => -compareByCommitTime(a, b))
  }
}
