import http from 'node:http';
import https from 'node:https';

function endpoint(baseUrl, openAICompatible) {
  const message = openAICompatible
    ? 'Use an HTTP or HTTPS API base URL without credentials, query parameters or fragment'
    : 'DeepSeek base URL must use HTTP or HTTPS';
  let url;
  try {
    url = new URL(baseUrl.endsWith('/') ? baseUrl : baseUrl + '/');
  } catch {
    throw requestError(message);
  }
  if (!['http:', 'https:'].includes(url.protocol) ||
      openAICompatible && (url.username || url.password || url.search || url.hash)) {
    throw requestError(message);
  }
  return url;
}

function requestError(message,url,status){
  const error=new Error(message);
  error.requestOutcome=url?.pathname.endsWith('/chat/completions')&&(status===undefined||status>=500)?'unknown':'not_dispatched';
  if(status!==undefined)error.httpStatus=status;
  return error;
}

export function validModelId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\x00-\x1f\x7f-\x9f]/u.test(value);
}

function decodeUrlBytes(url) {
  return url.replace(/%([a-f0-9]{2})/gi, (_encoded, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function requestWithoutHeaderDeadline(url, options, signal) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      signal,
    }, response => {
      response.on('error', reject);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        resolve({ ok: false, status: response.statusCode });
        response.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 32 * 1024 * 1024) {
          request.destroy(new Error('DeepSeek response exceeded 32 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        ok: true,
        status: response.statusCode,
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
      response.on('aborted', () => reject(new Error('Provider response disconnected')));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

export class DeepSeekHttpAdapter {
  #jsonApiKey;

  constructor({ baseUrl, model, timeoutMs = 600_000, apiKey, openAICompatible = false, fetchImpl = requestWithoutHeaderDeadline } = {}) {
    if (!baseUrl) throw requestError(openAICompatible?'Configure an API worker base URL':'DEEPSEEK_BASE_URL is required (include /v1)');
    this.label=openAICompatible?'API worker':'DeepSeek';
    this.openAICompatible=openAICompatible;
    if(apiKey!==undefined&&(typeof apiKey!=='string'||!apiKey||apiKey.length>2048||/[^\x21-\x7e]/.test(apiKey)))throw requestError('Invalid API worker bearer key');
    this.apiKey = apiKey;
    this.#jsonApiKey = apiKey ? JSON.stringify(apiKey).slice(1, -1) : undefined;
    const base = endpoint(baseUrl, openAICompatible);
    if (apiKey && (typeof model === 'string' && this.containsCredential(model) ||
        this.containsCredential(baseUrl) || this.containsCredential(decodeUrlBytes(baseUrl)) ||
        this.containsCredential(decodeUrlBytes(base.href)))) {
      throw requestError('The bearer key must appear only in the credential field');
    }
    this.authHeaders=apiKey?{authorization:'Bearer '+apiKey}:{};
    this.modelsUrl = new URL('models', base);
    this.chatUrl = new URL('chat/completions', base);
    this.model = model || null;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.identity = model ? `deepseek-http/${model}` : 'deepseek-http/unresolved';
  }

  containsCredential(text) {
    return Boolean(this.apiKey && (text.includes(this.apiKey) || text.includes(this.#jsonApiKey)));
  }

  redact(text) {
    if (!this.apiKey) return text;
    // The coordinator also embeds JSON inside message strings.
    if (this.#jsonApiKey !== this.apiKey) text = text.replaceAll(this.#jsonApiKey, '[redacted]');
    return text.replaceAll(this.apiKey, '[redacted]');
  }

  redactData(value) {
    if (!this.apiKey || value === null) return value;
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.redactData(item));
    if (typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), this.redactData(item)]));
    }
    return value;
  }

  async request(url, options, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetchImpl(url, { ...options, headers:{...options.headers,...this.authHeaders}, signal: combined }, combined);
    } catch (error) {
      if (signal?.aborted) throw requestError(this.label+' call interrupted',url);
      if (timeout.aborted) throw requestError(`${this.label} call timed out after ${this.timeoutMs} ms`,url);
      const detail = this.apiKey?'connection error':(error.cause?.code ?? error.message);
      throw requestError(`${this.label} connection failed: ${detail}`,url);
    }
    if (!response.ok) throw requestError(`${this.label} ${this.redact(url.pathname)} returned HTTP ${response.status}`,url,response.status);
    try {
      return await response.json();
    } catch {
      if (signal?.aborted) throw requestError(this.label+' call interrupted',url);
      if (timeout.aborted) throw requestError(`${this.label} call timed out after ${this.timeoutMs} ms`,url);
      throw requestError(`${this.label} ${this.redact(url.pathname)} returned invalid JSON`,url);
    }
  }

  async listModels(signal, { strict = false } = {}) {
    const body = await this.request(this.modelsUrl, { method: 'GET' }, signal);
    if (!Array.isArray(body?.data)) throw requestError(this.label+' /models returned no model list');
    const listed = body.data.map(item => item?.id);
    if (strict && !listed.every(validModelId)) throw requestError(this.label+' /models returned invalid model IDs');
    const ids = listed.filter(id =>
      (this.openAICompatible || strict ? validModelId(id) : typeof id === 'string' && id.trim()) &&
      !this.containsCredential(id));
    if (ids.length === 0) throw requestError(this.label+' /models returned no model IDs');
    return this.openAICompatible?[...new Set(ids)]:ids;
  }

  async resolveModel(signal) {
    if (this.resolvedModel) return this.resolvedModel;
    if(this.openAICompatible&&this.model)return this.resolvedModel=this.model;
    const ids=await this.listModels(signal);
    if (this.model && !ids.includes(this.model)) throw new Error(`Configured DeepSeek model ${this.model} is not advertised by /models`);
    if (!this.model && ids.length !== 1) throw new Error(this.openAICompatible?'Select a model advertised by /models':'DeepSeek /models advertised multiple models; set DEEPSEEK_MODEL_ID');
    this.resolvedModel = this.model ?? ids[0];
    this.identity = `deepseek-http/${this.resolvedModel}`;
    return this.resolvedModel;
  }

  async execute({ step, attempt, feedback, priorResult, signal }) {
    const model = await this.resolveModel(signal);
    const assignment = {
      objective: step.objective,
      context: step.context,
      expectedResult: step.expectedResult,
      attempt,
      ...(attempt > 1 ? { previousAnswer: priorResult?.answer, revisionFeedback: feedback } : {}),
    };
    const body = await this.request(this.chatUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: 'Complete the project-design assignment as text. Do not request or claim tool use, file edits, or shell execution. Address revision feedback directly if provided.' },
          { role: 'user', content: JSON.stringify(this.redactData(assignment)) },
        ],
      }),
    }, signal);
    const choice = body?.choices?.[0];
    const answer = choice?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('DeepSeek returned an empty or unsupported answer');
    const result = {
      status: choice.finish_reason === 'length' ? 'failed' : 'completed',
      answer: this.redact(answer),
      model: this.redactData(body.model ?? model),
      finishReason: this.redactData(choice.finish_reason ?? null),
      ...(body.usage ? { usage: this.redactData(body.usage) } : {}),
    };
    if (result.status === 'failed') result.summary = 'DeepSeek answer was truncated';
    return result;
  }
}
