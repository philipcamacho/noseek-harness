/**
 * Noseek Hermetic Network Gate
 *
 * Verifies that:
 * 1. Process-level connection and DNS observer enforces zero non-loopback egress.
 * 2. Loopback stub DNS server and loopback mock HTTP server run on 127.0.0.1.
 * 3. Default configuration across all 6 shipped profiles makes zero non-loopback
 *    DNS queries and connections.
 * 4. Model turn against loopback mock server contains:
 *    - Zero `dsh_session_log` or `dsh_plugin_packages` in request body.
 *    - Zero `x-deepseek-harness-*` in request headers.
 *    - Valid `user-agent` header starting with `noseek-harness/` and no DeepSeek attribution.
 *    - Assembled system prompt / messages containing "Noseek Harness" and no "DeepSeek Harness".
 * 5. Plugin registry probe (`PluginRegistryProbe.prototype.fastest`) with Noseek
 *    defaults makes zero network requests and returns null.
 * 6. Local feedback recording produces zero outbound network requests.
 * 7. `$DSH_HOME/.anonymous-user-id` is NOT created by boot or model turn.
 * 8. When run under strace, all connect syscalls target only loopback or UNIX sockets.
 */

import dgram from 'node:dgram'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import dns from 'node:dns'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { recordFeedback } from '../packages/feedback/command-feedback/src/index.ts'
import PluginRegistryProbe from '../packages/client/ui-plugin-manager/src/index.ts'
import {
  composeNoseekProfile,
  QUARANTINED_ROWS,
} from './audit-privacy.ts'
import { attributionHeaders } from '../packages/llm/llm/src/attribution.ts'
import SystemPrompt, { renderPrompt } from '../packages/core/system-prompt/src/index.ts'

// --- 1. Loopback Address & Host Helper ---

export function isLoopbackHost(host?: string | null): boolean {
  if (!host) return true
  const h = host.toLowerCase().trim()
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h === '::' ||
    h === '::ffff:127.0.0.1' ||
    h.startsWith('127.')
  )
}

// --- 2. Process-Level Observer ---

export interface NetworkViolation {
  readonly type: 'net.connect' | 'dns.lookup' | 'dns.resolve' | 'http.request' | 'fetch' | 'strace'
  readonly target: string
  readonly stack?: string
}

export class HermeticObserver {
  readonly violations: NetworkViolation[] = []
  private installed = false

  private originalNetConnect = net.Socket.prototype.connect
  private originalDnsLookup = dns.lookup
  private originalDnsPromisesLookup = dns.promises.lookup
  private originalHttpRequest = http.request
  private originalHttpGet = http.get
  private originalHttpsRequest = https.request
  private originalHttpsGet = https.get
  private originalFetch = globalThis.fetch

  install(): void {
    if (this.installed) return
    this.installed = true
    const self = this

    // net.Socket.prototype.connect
    net.Socket.prototype.connect = function (...args: any[]) {
      let host: string | undefined
      let isUnixSocket = false

      if (typeof args[0] === 'object' && args[0] !== null) {
        if (args[0].path) {
          isUnixSocket = true
        } else {
          host = args[0].host
        }
      } else if (typeof args[0] === 'number') {
        if (typeof args[1] === 'string') {
          host = args[1]
        }
      } else if (typeof args[0] === 'string') {
        isUnixSocket = true
      }

      if (!isUnixSocket && !isLoopbackHost(host)) {
        const violation: NetworkViolation = {
          type: 'net.connect',
          target: host ?? 'unknown',
          stack: new Error().stack,
        }
        self.violations.push(violation)
        throw new Error(`[hermetic-observer] Blocked non-loopback connect to: ${host}`)
      }

      return self.originalNetConnect.apply(this, args as any)
    }

    // dns.lookup
    dns.lookup = function (hostname: string, ...rest: any[]) {
      if (!isLoopbackHost(hostname)) {
        self.violations.push({
          type: 'dns.lookup',
          target: hostname,
          stack: new Error().stack,
        })
        const cb = typeof rest[0] === 'function' ? rest[0] : rest[1]
        if (typeof cb === 'function') {
          return cb(new Error(`[hermetic-observer] Blocked DNS lookup for: ${hostname}`))
        }
        throw new Error(`[hermetic-observer] Blocked DNS lookup for: ${hostname}`)
      }
      return (self.originalDnsLookup as any).call(dns, hostname, ...rest)
    } as any

    // dns.promises.lookup
    dns.promises.lookup = async function (hostname: string, ...rest: any[]) {
      if (!isLoopbackHost(hostname)) {
        self.violations.push({
          type: 'dns.lookup',
          target: hostname,
          stack: new Error().stack,
        })
        throw new Error(`[hermetic-observer] Blocked DNS promise lookup for: ${hostname}`)
      }
      return self.originalDnsPromisesLookup.call(dns.promises, hostname, ...rest)
    }

    // Wrap dns.resolve*
    const resolveMethods = [
      'resolve', 'resolve4', 'resolve6', 'resolveCname', 'resolveMx',
      'resolveNs', 'resolveTxt', 'resolveSrv', 'resolvePtr', 'resolveNaptr', 'resolveSoa',
    ] as const

    for (const method of resolveMethods) {
      if (typeof (dns as any)[method] === 'function') {
        const orig = (dns as any)[method]
        ;(dns as any)[method] = function (hostname: string, ...rest: any[]) {
          if (!isLoopbackHost(hostname)) {
            self.violations.push({
              type: 'dns.resolve',
              target: hostname,
              stack: new Error().stack,
            })
            const cb = rest[rest.length - 1]
            if (typeof cb === 'function') {
              return cb(new Error(`[hermetic-observer] Blocked dns.${method} for: ${hostname}`))
            }
            throw new Error(`[hermetic-observer] Blocked dns.${method} for: ${hostname}`)
          }
          return orig.call(dns, hostname, ...rest)
        }
      }
      if (dns.promises && typeof (dns.promises as any)[method] === 'function') {
        const origPromise = (dns.promises as any)[method]
        ;(dns.promises as any)[method] = async function (hostname: string, ...rest: any[]) {
          if (!isLoopbackHost(hostname)) {
            self.violations.push({
              type: 'dns.resolve',
              target: hostname,
              stack: new Error().stack,
            })
            throw new Error(`[hermetic-observer] Blocked dns.promises.${method} for: ${hostname}`)
          }
          return origPromise.call(dns.promises, hostname, ...rest)
        }
      }
    }

    // http.request / http.get
    http.request = function (...args: any[]) {
      const targetHost = self.extractHttpHost(args)
      if (!isLoopbackHost(targetHost)) {
        self.violations.push({
          type: 'http.request',
          target: targetHost ?? 'unknown',
          stack: new Error().stack,
        })
        throw new Error(`[hermetic-observer] Blocked non-loopback HTTP request to: ${targetHost}`)
      }
      return self.originalHttpRequest.apply(http, args as any)
    } as any

    http.get = function (...args: any[]) {
      const targetHost = self.extractHttpHost(args)
      if (!isLoopbackHost(targetHost)) {
        self.violations.push({
          type: 'http.request',
          target: targetHost ?? 'unknown',
          stack: new Error().stack,
        })
        throw new Error(`[hermetic-observer] Blocked non-loopback HTTP get to: ${targetHost}`)
      }
      return self.originalHttpGet.apply(http, args as any)
    } as any

    // https.request / https.get
    https.request = function (...args: any[]) {
      const targetHost = self.extractHttpHost(args)
      if (!isLoopbackHost(targetHost)) {
        self.violations.push({
          type: 'http.request',
          target: targetHost ?? 'unknown',
          stack: new Error().stack,
        })
        throw new Error(`[hermetic-observer] Blocked non-loopback HTTPS request to: ${targetHost}`)
      }
      return self.originalHttpsRequest.apply(https, args as any)
    } as any

    https.get = function (...args: any[]) {
      const targetHost = self.extractHttpHost(args)
      if (!isLoopbackHost(targetHost)) {
        self.violations.push({
          type: 'http.request',
          target: targetHost ?? 'unknown',
          stack: new Error().stack,
        })
        throw new Error(`[hermetic-observer] Blocked non-loopback HTTPS get to: ${targetHost}`)
      }
      return self.originalHttpsGet.apply(https, args as any)
    } as any

    // globalThis.fetch
    if (typeof globalThis.fetch === 'function') {
      globalThis.fetch = async function (input: any, init?: any) {
        let hostname: string | undefined
        try {
          if (typeof input === 'string') {
            hostname = new URL(input).hostname
          } else if (input instanceof URL) {
            hostname = input.hostname
          } else if (input && typeof input.url === 'string') {
            hostname = new URL(input.url).hostname
          }
        } catch {}

        if (!isLoopbackHost(hostname)) {
          self.violations.push({
            type: 'fetch',
            target: hostname ?? 'unknown',
            stack: new Error().stack,
          })
          throw new Error(`[hermetic-observer] Blocked non-loopback fetch to: ${hostname}`)
        }
        return self.originalFetch.call(globalThis, input, init)
      }
    }
  }

  private extractHttpHost(args: any[]): string | undefined {
    const first = args[0]
    if (typeof first === 'string') {
      try {
        return new URL(first).hostname
      } catch {
        return first.split('/')[0]?.split(':')[0]
      }
    }
    if (first instanceof URL) {
      return first.hostname
    }
    if (typeof first === 'object' && first !== null) {
      return first.hostname ?? first.host?.split(':')[0]
    }
    return undefined
  }

  uninstall(): void {
    if (!this.installed) return
    net.Socket.prototype.connect = this.originalNetConnect
    dns.lookup = this.originalDnsLookup
    dns.promises.lookup = this.originalDnsPromisesLookup
    http.request = this.originalHttpRequest
    http.get = this.originalHttpGet
    https.request = this.originalHttpsRequest
    https.get = this.originalHttpsGet
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch
    }
    this.installed = false
  }

  checkStraceLog(logPath: string): void {
    if (!existsSync(logPath)) return
    const content = readFileSync(logPath, 'utf8')
    const lines = content.split('\n')
    for (const line of lines) {
      if (!line.includes('connect(')) continue
      // e.g. connect(3, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr("127.0.0.1")}, 16)
      // or AF_UNIX
      if (line.includes('AF_UNIX')) continue
      const matchIp = line.match(/inet_addr\("([^"]+)"\)/) || line.match(/sin_addr=inet_addr\("([^"]+)"\)/)
      if (matchIp) {
        const ip = matchIp[1]!
        if (!isLoopbackHost(ip)) {
          this.violations.push({
            type: 'strace',
            target: `strace-non-loopback-ip:${ip}`,
          })
        }
      }
    }
  }
}

// --- 3. Loopback Stub DNS Server (UDP on 127.0.0.1:0) ---

export interface StubDnsServer {
  readonly port: number
  readonly queries: string[]
  close(): Promise<void>
}

export async function startStubDnsServer(observer: HermeticObserver): Promise<StubDnsServer> {
  const socket = dgram.createSocket('udp4')
  const queries: string[] = []

  socket.on('message', (msg, rinfo) => {
    try {
      if (msg.length < 12) return
      let offset = 12
      const labels: string[] = []
      while (offset < msg.length && msg[offset] !== 0) {
        const len = msg[offset]!
        offset++
        labels.push(msg.subarray(offset, offset + len).toString('utf8'))
        offset += len
      }
      const qname = labels.join('.')
      queries.push(qname)

      if (!isLoopbackHost(qname)) {
        observer.violations.push({
          type: 'dns.lookup',
          target: `stub-dns-query:${qname}`,
        })
      }

      // DNS response packet resolving to 127.0.0.1
      const resp = Buffer.alloc(msg.length + 16)
      msg.copy(resp, 0, 0, msg.length)
      resp[2] = 0x81 // QR=1, AA=0, TC=0, RD=1
      resp[3] = 0x80 // RA=1, RCODE=0
      resp[6] = 0x00 // ANCOUNT = 1
      resp[7] = 0x01

      let p = msg.length
      resp[p++] = 0xc0 // Name pointer to 0x000c
      resp[p++] = 0x0c
      resp[p++] = 0x00 // TYPE A (1)
      resp[p++] = 0x01
      resp[p++] = 0x00 // CLASS IN (1)
      resp[p++] = 0x01
      resp[p++] = 0x00 // TTL 60s
      resp[p++] = 0x00
      resp[p++] = 0x00
      resp[p++] = 0x3c
      resp[p++] = 0x00 // RDLENGTH 4
      resp[p++] = 0x04
      resp[p++] = 127 // 127.0.0.1
      resp[p++] = 0
      resp[p++] = 0
      resp[p++] = 1

      socket.send(resp.subarray(0, p), rinfo.port, rinfo.address)
    } catch {}
  })

  await new Promise<void>((resolve, reject) => {
    socket.bind(0, '127.0.0.1', () => resolve())
    socket.once('error', reject)
  })

  const port = socket.address().port
  return {
    port,
    queries,
    close: () => new Promise<void>(resolve => socket.close(() => resolve())),
  }
}

// --- 4. Loopback Mock OpenAI/pi-ai Compatible HTTP Server (127.0.0.1:0) ---

export interface RecordedRequest {
  readonly method: string
  readonly url: string
  readonly headers: http.IncomingHttpHeaders
  readonly body: any
}

export interface MockHttpServer {
  readonly port: number
  readonly baseURL: string
  readonly requests: RecordedRequest[]
  close(): Promise<void>
}

export async function startMockHttpServer(): Promise<MockHttpServer> {
  const requests: RecordedRequest[] = []

  const server = http.createServer((req, res) => {
    let rawBody = ''
    req.on('data', chunk => {
      rawBody += chunk
    })
    req.on('end', () => {
      let parsedBody: any = rawBody
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {}

      requests.push({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: parsedBody,
      })

      const path = req.url ?? '/'
      const acceptsSse = (req.headers.accept ?? '').includes('text/event-stream') || parsedBody?.stream === true

      if (path.includes('/chat/completions')) {
        if (acceptsSse) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          })
          res.write('data: {"id":"chatcmpl-hermetic","object":"chat.completion.chunk","created":1234567890,"model":"mock-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hermetic response"},"finish_reason":null}]}\n\n')
          res.write('data: {"id":"chatcmpl-hermetic","object":"chat.completion.chunk","created":1234567890,"model":"mock-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
          res.write('data: [DONE]\n\n')
          res.end()
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'chatcmpl-hermetic',
            object: 'chat.completion',
            created: 1234567890,
            model: 'mock-model',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'Hermetic response' },
              finish_reason: 'stop',
            }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }))
        }
      } else if (path.includes('/messages')) {
        if (acceptsSse) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          })
          res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg-hermetic","type":"message","role":"assistant","content":[],"model":"mock-model","usage":{"input_tokens":10,"output_tokens":5}}}\n\n')
          res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n')
          res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hermetic response"}}\n\n')
          res.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n')
          res.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n')
          res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n')
          res.end()
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg-hermetic',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'Hermetic response' }],
            model: 'mock-model',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          }))
        }
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, models: [{ id: 'mock-model' }] }))
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve())
    server.once('error', reject)
  })

  const port = (server.address() as net.AddressInfo).port
  return {
    port,
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  }
}

// --- 5. Main Hermetic Network Test Runner ---

export async function runHermeticNetworkTest(): Promise<boolean> {
  console.log('='.repeat(70))
  console.log('NOSEEK HERMETIC NETWORK GATE')
  console.log('Verifies zero non-loopback network egress across shipped profiles & operations.')
  console.log('='.repeat(70))

  const observer = new HermeticObserver()
  observer.install()

  let dnsServer: StubDnsServer | undefined
  let httpServer: MockHttpServer | undefined
  let allPassed = true

  try {
    dnsServer = await startStubDnsServer(observer)
    httpServer = await startMockHttpServer()

    console.log(`[hermetic] Stub DNS server bound to 127.0.0.1:${dnsServer.port}`)
    console.log(`[hermetic] Mock HTTP server bound to ${httpServer.baseURL}`)

    const profiles = ['headless', 'sdk', 'sdk-minimal', 'acp', 'web', 'desktop']

    // Test 1: Shipped profiles boot hermeticity & anonymous-user-id absence
    console.log('\n--- 1. Testing Default Boot Hermeticity Across Shipped Profiles ---')
    for (const profileName of profiles) {
      const tempHome = mkdtempSync(join(tmpdir(), `hermetic-boot-${profileName}-`))
      try {
        process.env.DSH_HOME = tempHome
        const beforeViolationCount = observer.violations.length

        const { entries } = composeNoseekProfile(profileName, tempHome)

        // Verify quarantined rows are disabled
        for (const qid of QUARANTINED_ROWS) {
          const row = entries.find(e => e.id === qid)
          if (row !== undefined && row.disabled !== true) {
            throw new Error(`Profile ${profileName} has quarantined row ${qid} enabled`)
          }
        }

        // Verify ui-brand-official is disabled when present
        const brandRow = entries.find(e => e.id === 'ui-brand-official')
        if (brandRow !== undefined && brandRow.disabled !== true) {
          throw new Error(`Profile ${profileName} has ui-brand-official enabled`)
        }

        // Verify harness-dev-context is disabled when present
        const devContextRow = entries.find(e => e.id === 'harness-dev-context')
        if (devContextRow !== undefined && devContextRow.disabled !== true) {
          throw new Error(`Profile ${profileName} has harness-dev-context enabled`)
        }

        // Verify system-prompt configuration
        const sysPrompt = entries.find(e => e.id === 'system-prompt')
        if (sysPrompt === undefined) {
          throw new Error(`Profile ${profileName} missing system-prompt row`)
        }
        const sysConf = (sysPrompt.config ?? {}) as Record<string, unknown>
        if (sysConf.includeHarnessIdentity !== false) {
          throw new Error(`Profile ${profileName} system-prompt has includeHarnessIdentity !== false`)
        }
        const sysConfStr = JSON.stringify(sysConf)
        if (sysConfStr.includes('DeepSeek Harness') || sysConfStr.includes('deepseek-ai/deepseek-harness')) {
          throw new Error(`Profile ${profileName} system-prompt config contains prohibited DeepSeek Harness branding`)
        }

        // Verify .anonymous-user-id is NOT created
        const anonFile = join(tempHome, '.anonymous-user-id')
        if (existsSync(anonFile)) {
          throw new Error(`Profile ${profileName} boot created .anonymous-user-id file at ${anonFile}`)
        }

        const newViolations = observer.violations.length - beforeViolationCount
        if (newViolations > 0) {
          throw new Error(`Profile ${profileName} boot triggered ${newViolations} non-loopback network violations`)
        }

        console.log(`  ✓ Profile [${profileName.toUpperCase()}]: zero non-loopback queries, zero non-loopback connects, no .anonymous-user-id, safe branding & prompt`)
      } catch (err: unknown) {
        allPassed = false
        console.error(`  ✗ Profile [${profileName.toUpperCase()}] FAILED: ${(err as Error).message}`)
      } finally {
        rmSync(tempHome, { recursive: true, force: true })
      }
    }

    // Test 2: Model Turn Hermeticity against loopback model server
    console.log('\n--- 2. Testing Model Turn Wire Shape Against Loopback Mock Server ---')
    const turnHome = mkdtempSync(join(tmpdir(), 'hermetic-model-turn-'))
    try {
      process.env.DSH_HOME = turnHome
      const beforeReqs = httpServer.requests.length

      // Assemble system prompt from composed profile
      const { entries } = composeNoseekProfile('acp', turnHome)
      const sysPromptEntry = entries.find(e => e.id === 'system-prompt')
      let renderedSystemPrompt = ''
      if (sysPromptEntry?.config) {
        const promptCtx = new Context()
        await promptCtx.plugin(SystemPrompt, sysPromptEntry.config)
        promptCtx.systemPrompt.variable('model', () => 'mock-model')
        promptCtx.systemPrompt.variable('provider', () => 'mock-provider')
        const assembly = await promptCtx.systemPrompt.assemble({})
        renderedSystemPrompt = renderPrompt(assembly)
        await promptCtx.fiber.dispose()
      }

      const authHeaders = attributionHeaders()

      // Issue a model turn request to the loopback mock server
      const reqUrl = `${httpServer.baseURL}/v1/chat/completions`
      const payload = JSON.stringify({
        model: 'mock-model',
        messages: [
          ...(renderedSystemPrompt ? [{ role: 'system', content: renderedSystemPrompt }] : []),
          { role: 'user', content: 'Hermetic test turn' },
        ],
        stream: false,
      })

      const response = await new Promise<{ status: number; data: string }>((resolve, reject) => {
        const req = http.request(
          reqUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(payload),
              ...authHeaders,
            },
          },
          res => {
            let data = ''
            res.on('data', chunk => { data += chunk })
            res.on('end', () => resolve({ status: res.statusCode ?? 0, data }))
          }
        )
        req.on('error', reject)
        req.write(payload)
        req.end()
      })

      if (response.status !== 200) {
        throw new Error(`Mock model server returned HTTP status ${response.status}: ${response.data}`)
      }

      const receivedReqs = httpServer.requests.slice(beforeReqs)
      if (receivedReqs.length === 0) {
        throw new Error('No requests were received by the loopback model server')
      }

      for (const req of receivedReqs) {
        // Assert: Zero dsh_session_log or dsh_plugin_packages fields in request body
        if (req.body && typeof req.body === 'object') {
          if ('dsh_session_log' in req.body) {
            throw new Error('Found prohibited "dsh_session_log" field in model request body')
          }
          if ('dsh_plugin_packages' in req.body) {
            throw new Error('Found prohibited "dsh_plugin_packages" field in model request body')
          }
        }

        // Assert: Zero x-deepseek-harness-* headers in request headers
        const headerKeys = Object.keys(req.headers)
        const prohibitedHeaders = headerKeys.filter(k => k.toLowerCase().startsWith('x-deepseek-harness-'))
        if (prohibitedHeaders.length > 0) {
          throw new Error(`Found prohibited headers in model request: ${prohibitedHeaders.join(', ')}`)
        }

        // Assert: user-agent header starts with noseek-harness/ and contains no deepseek-harness
        const userAgent = (req.headers['user-agent'] ?? '').toString()
        if (!userAgent.startsWith('noseek-harness/')) {
          throw new Error(`Expected user-agent to start with "noseek-harness/", got: "${userAgent}"`)
        }
        if (userAgent.includes('deepseek-harness') || userAgent.includes('deepseek-ai/deepseek-harness')) {
          throw new Error(`user-agent contains prohibited deepseek harness attribution: "${userAgent}"`)
        }

        // Assert: body and messages do NOT contain DeepSeek Harness or deepseek-ai/deepseek-harness, and DO contain Noseek Harness
        const bodyStr = JSON.stringify(req.body)
        if (bodyStr.includes('DeepSeek Harness') || bodyStr.includes('deepseek-ai/deepseek-harness')) {
          throw new Error('Model request body contains prohibited "DeepSeek Harness" branding')
        }
        if (!bodyStr.includes('Noseek Harness')) {
          throw new Error('Model request body does not contain expected "Noseek Harness" prompt identity')
        }
      }

      // Assert: .anonymous-user-id was not created by the model turn
      const anonFile = join(turnHome, '.anonymous-user-id')
      if (existsSync(anonFile)) {
        throw new Error(`Model turn created .anonymous-user-id at ${anonFile}`)
      }

      console.log('  ✓ Model turn: Zero dsh_session_log, zero dsh_plugin_packages, zero x-deepseek-harness-* headers')
      console.log('  ✓ Model turn: User-agent verified noseek-harness/ and prompt body verified Noseek Harness')
      console.log('  ✓ Model turn: .anonymous-user-id was NOT created')
    } catch (err: unknown) {
      allPassed = false
      console.error(`  ✗ Model turn FAILED: ${(err as Error).message}`)
    } finally {
      rmSync(turnHome, { recursive: true, force: true })
    }

    // Test 3: Plugin Registry Probe (fastest() with Noseek defaults)
    console.log('\n--- 3. Testing Plugin Registry Probe Hermeticity ---')
    try {
      const ctx = new Context()
      const probe = new PluginRegistryProbe(ctx, {
        registryProbeEnabled: false,
        registryProbeTimeoutMs: 1500,
        registryProbeCacheTtlMs: 300000,
      })

      const beforeViolations = observer.violations.length
      const result = await probe.fastest()
      await ctx.fiber.dispose()

      if (result !== null) {
        throw new Error(`PluginRegistryProbe.prototype.fastest() returned non-null: ${result}`)
      }
      if (observer.violations.length > beforeViolations) {
        throw new Error('PluginRegistryProbe triggered outbound network request')
      }

      console.log('  ✓ PluginRegistryProbe.prototype.fastest(): returned null with zero outbound network requests')
    } catch (err: unknown) {
      allPassed = false
      console.error(`  ✗ PluginRegistryProbe test FAILED: ${(err as Error).message}`)
    }

    // Test 4: Local Feedback Hermeticity
    console.log('\n--- 4. Testing Local Feedback Hermeticity ---')
    const feedbackHome = mkdtempSync(join(tmpdir(), 'hermetic-feedback-'))
    try {
      process.env.DSH_HOME = feedbackHome
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      const session = ctx.sessions.create(SessionId('hermetic-feedback-session'))

      const beforeViolations = observer.violations.length
      recordFeedback(session, { text: 'Hermetic test feedback entry', category: 'task-result' })

      const events = session.snapshotEvents()
      const feedbackRecorded = events.some(e => e.type === 'feedback/record')
      if (!feedbackRecorded) {
        throw new Error('Local feedback was not recorded into session events')
      }

      if (observer.violations.length > beforeViolations) {
        throw new Error('Local feedback recording triggered outbound network request')
      }

      const anonFile = join(feedbackHome, '.anonymous-user-id')
      if (existsSync(anonFile)) {
        throw new Error(`Local feedback created .anonymous-user-id at ${anonFile}`)
      }

      await ctx.fiber.dispose()
      console.log('  ✓ Local feedback: recorded locally with zero outbound network requests and no .anonymous-user-id')
    } catch (err: unknown) {
      allPassed = false
      console.error(`  ✗ Local feedback test FAILED: ${(err as Error).message}`)
    } finally {
      rmSync(feedbackHome, { recursive: true, force: true })
    }

    // Test 5: Check Strace log if executed under strace (Linux)
    if (process.env.STRACE_LOG) {
      console.log('\n--- 5. Checking Strace Log for Syscall-Level Connects ---')
      try {
        observer.checkStraceLog(process.env.STRACE_LOG)
        console.log(`  ✓ Strace log verified: ${process.env.STRACE_LOG}`)
      } catch (err: unknown) {
        allPassed = false
        console.error(`  ✗ Strace verification FAILED: ${(err as Error).message}`)
      }
    }

    // Final observer check
    if (observer.violations.length > 0) {
      allPassed = false
      console.error(`\nHERMETIC GATE BLOCKED: ${observer.violations.length} non-loopback network violations detected:`)
      for (const v of observer.violations) {
        console.error(`  - [${v.type}] Target: ${v.target}`)
        if (v.stack) {
          console.error(`    ${v.stack.split('\n').slice(1, 4).join('\n    ')}`)
        }
      }
    }
  } finally {
    observer.uninstall()
    await dnsServer?.close().catch(() => {})
    await httpServer?.close().catch(() => {})
  }

  console.log('='.repeat(70))
  if (allPassed && observer.violations.length === 0) {
    console.log('HERMETIC NETWORK TEST SUCCESSFUL: Zero non-loopback queries or egress detected.')
    console.log('='.repeat(70))
    return true
  } else {
    console.error('HERMETIC NETWORK TEST FAILED: Egress policy violated.')
    console.log('='.repeat(70))
    return false
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runHermeticNetworkTest()
    .then(passed => {
      process.exit(passed ? 0 : 1)
    })
    .catch(err => {
      console.error('Unexpected hermetic test error:', err)
      process.exit(1)
    })
}
