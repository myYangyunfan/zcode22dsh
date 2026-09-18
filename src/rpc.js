/**
 * 宿主侧 HTTP 面：设置页（客户端半）唯一的数据入口。
 *
 * 客户端半不复制任何迁移逻辑 —— 三个动作直接转调 `core/` 里的
 * inspect / migrate / verifyArtifact，配置以插件 config 为底、请求体只覆盖允许的字段。
 *
 * 安全：内核的 /api browser-trust 栅栏不覆盖自定义前缀路由，所以这里自己校验 Host
 * （只信 localhost / 127.0.0.1，与 synapse 同口径）—— 这条路由能往 `~/.dsh/sessions`
 * 写文件，不能让它被 DNS rebinding 打进来。
 */
import { existsSync } from 'node:fs'
import { inspect, migrate, readArtifact } from '../core/migrate.js'

/** 客户端半与宿主半共用的路由前缀（改这里要同步改 lib/client.js）。 */
export const API_PREFIX = '/zcode-migrate/api'

const TRUSTED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/** 只接受已知字段，避免请求体把 dbPath/dshRoot 这类落点改掉。 */
function pickInspect(body) {
  return {
    cwd: typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : undefined,
    ids: Array.isArray(body.ids) && body.ids.length > 0 ? body.ids.map(String) : undefined,
    limit: Number.isFinite(body.limit) ? body.limit : undefined,
    since: Number.isFinite(body.since) ? body.since : undefined,
    until: Number.isFinite(body.until) ? body.until : undefined,
    includeSubagents: body.includeSubagents === true,
  }
}

function pickMigrate(body) {
  return {
    ...pickInspect(body),
    dryRun: body.dryRun === true,
    verify: body.verify !== false,
    includeReasoning: body.includeReasoning !== false,
    emitTitle: body.emitTitle !== false,
    agentPreset: typeof body.agentPreset === 'string' && body.agentPreset !== '' ? body.agentPreset : undefined,
  }
}

/** 目录 → 工作区标题：取末级目录名（与 dsh 自己给工作区命名的方式一致）。 */
function workspaceTitle(dir) {
  const parts = String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.length === 0 ? String(dir) : parts[parts.length - 1]
}

/**
 * 把「迁移过来的目录」登记成 dsh 工作区。
 *
 * 为什么需要：会话归组靠工作区注册表（`ctx.workspaceRegistry`）里的记录去匹配会话头的
 * `cwd`——迁移只写会话日志、不登记工作区，于是所有迁来的会话都掉进「未分组」（用户实报）。
 * `registry.create(path, title)` 要求 path 是**存在的目录**并自动去重，所以这里逐个试、
 * 逐个报结果（目录不存在/服务缺席都如实返回，不假装成功）。
 * @param {object} registry - `ctx.workspaceRegistry`（缺席时返回 ok:false）。
 * @param {string[]} dirs - 目录列表。
 */
async function ensureWorkspaces(registry, dirs) {
  const out = []
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir === '') continue
    // 目录已不存在：**不是失败**，是「没什么可登记的」——登记进工作区也没意义（注册表要求
    // 目录真实存在），而这些会话会继续留在「未分组」。按 skipped 报，页面用灰字列出，
    // 不再每次登记都刷一堆 ENOENT 红字。
    if (!existsSync(dir)) {
      out.push({ directory: dir, ok: false, skipped: true, reason: '目录已不存在（会话将留在「未分组」）' })
      continue
    }
    if (registry === undefined || typeof registry.create !== 'function') {
      out.push({ directory: dir, ok: false, error: '工作区服务不可用（ctx.workspaceRegistry）' })
      continue
    }
    try {
      const workspace = await registry.create(dir, workspaceTitle(dir))
      out.push({ directory: dir, ok: true, id: workspace?.id ?? null, title: workspace?.title ?? workspaceTitle(dir) })
    } catch (err) {
      out.push({ directory: dir, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}

/**
 * Build the route handler for `ctx.webServer.register({ kind: 'prefix', … })`.
 * @param {object} resolved - the plugin's normalized config (dbPath/dshRoot/…).
 * @param {object} [deps] - `{ workspaceRegistry }`（可选；缺席时 workspaces 动作如实报错）。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApiHandler(resolved, deps = {}) {
  return async (req, res) => {
    const hostname = (typeof req.headers?.host === 'string' ? req.headers.host : '')
      .replace(/:\d+$/, '')
      .toLowerCase()
    if (!TRUSTED_HOSTS.has(hostname)) return sendJson(res, 403, { ok: false, error: '不被信任的 Host' })

    const path = new URL(req.url ?? '/', 'http://dsh.local').pathname
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只接受 POST' })

    try {
      if (path === `${API_PREFIX}/inspect`) {
        return sendJson(res, 200, await inspect({ ...resolved, ...pickInspect(await readJson(req)) }))
      }
      if (path === `${API_PREFIX}/migrate`) {
        return sendJson(res, 200, await migrate({ ...resolved, ...pickMigrate(await readJson(req)) }))
      }
      if (path === `${API_PREFIX}/workspaces`) {
        const body = await readJson(req)
        const dirs = Array.isArray(body.directories) ? body.directories.map(String).filter(Boolean) : []
        if (dirs.length === 0) return sendJson(res, 400, { ok: false, error: 'workspaces 需要 directories' })
        const results = await ensureWorkspaces(deps.workspaceRegistry, dirs)
        // 请求本身成功即 ok:true；每个目录的成败在 results[] 里如实给出
        // （客户端把顶层 ok:false 当硬错误会吞掉逐条结果，页面就没法显示「哪些失败」）。
        return sendJson(res, 200, { ok: true, results })
      }
      if (path === `${API_PREFIX}/verify`) {
        const body = await readJson(req)
        if (typeof body.path !== 'string' || body.path === '') {
          return sendJson(res, 400, { ok: false, error: 'verify 需要 path' })
        }
        // 用 readArtifact（纯回读）而不是 verifyArtifact：后者要「期望值」参数（CLI 逐条
        // 核对用），在设置页这种「这个产物还能不能读」的场景下会直接抛。
        // 文件缺失/损坏是**结果**不是服务端错误 —— 一律 200 + ok:false，页面照实显示。
        try {
          const artifact = readArtifact(body.path)
          return sendJson(res, 200, {
            ok: artifact.ok === true && artifact.tornStart === null,
            path: artifact.path,
            header: artifact.header ?? null,
            eventCount: artifact.eventCount,
            frameCount: artifact.frameCount,
            bytes: artifact.bytes,
            tornStart: artifact.tornStart ?? null,
          })
        } catch (err) {
          return sendJson(res, 200, { ok: false, path: body.path, error: err instanceof Error ? err.message : String(err) })
        }
      }
      return sendJson(res, 404, { ok: false, error: `未知接口：${path}` })
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

/**
 * Mount the API on the DSH web server (same lifetime as the plugin fiber).
 * @param {object} ctx - cordis context carrying `webServer` + `effect`.
 * @param {object} resolved - normalized plugin config.
 * @param {object} [deps] - `{ workspaceRegistry }`。
 * @returns {boolean} whether the route was mounted.
 */
export function registerApi(ctx, resolved, deps = {}) {
  const webServer = ctx?.webServer
  if (typeof webServer?.register !== 'function') return false
  const handler = createApiHandler(resolved, deps)
  const mount = () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
  if (typeof ctx.effect === 'function') ctx.effect(mount, 'zcode-migrate: api')
  else mount()
  return true
}
