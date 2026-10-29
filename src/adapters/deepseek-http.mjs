import http from 'node:http';
import https from 'node:https';

function endpoint(baseUrl, route) {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('DeepSeek base URL must use HTTP or HTTPS');
  return new URL(route, url);
}

function requestError(message,url,status){
  const error=new Error(message);
  error.requestOutcome=url.pathname.endsWith('/chat/completions')&&(status===undefined||status>=500)?'unknown':'not_dispatched';
  if(status!==undefined)error.httpStatus=status;
  return error;
}

function requestWithoutHeaderDeadline(url, options, signal) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      signal,
    }, response => {
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
        ok: response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode,
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

export class DeepSeekHttpAdapter {
  constructor({ baseUrl, model, timeoutMs = 600_000, fetchImpl = requestWithoutHeaderDeadline } = {}) {
    if (!baseUrl) throw new Error('DEEPSEEK_BASE_URL is required (include /v1)');
    this.modelsUrl = endpoint(baseUrl, 'models');
    this.chatUrl = endpoint(baseUrl, 'chat/completions');
    this.model = model || null;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.identity = model ? `deepseek-http/${model}` : 'deepseek-http/unresolved';
  }

  async request(url, options, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetchImpl(url, { ...options, signal: combined }, combined);
    } catch (error) {
      if (signal?.aborted) throw requestError('DeepSeek call interrupted',url);
      if (timeout.aborted) throw requestError(`DeepSeek call timed out after ${this.timeoutMs} ms`,url);
      const detail = error.cause?.code ?? error.message;
      throw requestError(`DeepSeek connection failed: ${detail}`,url);
    }
    if (!response.ok) throw requestError(`DeepSeek ${url.pathname} returned HTTP ${response.status}`,url,response.status);
    try {
      return await response.json();
    } catch {
      if (signal?.aborted) throw requestError('DeepSeek call interrupted',url);
      if (timeout.aborted) throw requestError(`DeepSeek call timed out after ${this.timeoutMs} ms`,url);
      throw requestError(`DeepSeek ${url.pathname} returned invalid JSON`,url);
    }
  }

  async resolveModel(signal) {
    if (this.resolvedModel) return this.resolvedModel;
    const body = await this.request(this.modelsUrl, { method: 'GET' }, signal);
    if (!Array.isArray(body?.data)) throw new Error('DeepSeek /models returned no model list');
    const ids = body.data.map((item) => item?.id).filter((id) => typeof id === 'string' && id.trim());
    if (ids.length === 0) throw new Error('DeepSeek /models returned no model IDs');
    if (this.model && !ids.includes(this.model)) throw new Error(`Configured DeepSeek model ${this.model} is not advertised by /models`);
    if (!this.model && ids.length !== 1) throw new Error('DeepSeek /models advertised multiple models; set DEEPSEEK_MODEL_ID');
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
          { role: 'user', content: JSON.stringify(assignment) },
        ],
      }),
    }, signal);
    const choice = body?.choices?.[0];
    const answer = choice?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('DeepSeek returned an empty or unsupported answer');
    const result = {
      status: choice.finish_reason === 'length' ? 'failed' : 'completed',
      answer,
      model: body.model ?? model,
      finishReason: choice.finish_reason ?? null,
      ...(body.usage ? { usage: body.usage } : {}),
    };
    if (result.status === 'failed') result.summary = 'DeepSeek answer was truncated';
    return result;
  }
}
