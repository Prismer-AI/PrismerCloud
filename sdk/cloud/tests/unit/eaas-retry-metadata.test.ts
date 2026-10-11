import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismerClient } from '../../src/index';

const body = { success: false, error: { code: 'quota_exceeded', message: 'full', details: { active: 10 } }, requestId: 'req-delay' };
function clientFor(header: string | undefined, status = 429, json = true) {
  const fetch = vi.fn(async () => new Response(json ? JSON.stringify(body) : 'unavailable', {
    status, headers: { ...(header === undefined ? {} : { 'Retry-After': header }), 'x-request-id': 'req-header' },
  }));
  return { client: new PrismerClient({ apiKey: 'sk-eaas-test', baseUrl: 'https://eaas.invalid', fetch }), fetch };
}
afterEach(() => vi.useRealTimers());
describe('public EaaS retry metadata', () => {
  it.each([402, 429, 503])('preserves error and exposes header for HTTP %i without retrying a write', async status => {
    const {client, fetch} = clientFor('60', status);
    const result = await client.environments.create({ ttlSeconds: 600 });
    expect(result).toMatchObject({ ...body, error: { ...body.error, retryAfterMs: 60000 } });
    expect(JSON.parse(JSON.stringify(result)).error.retryAfterMs).toBe(60000);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([[undefined, undefined], ['', undefined], ['0', 0], [' 2 ', 2000], ['-1', undefined], ['1.5', undefined], ['Infinity', undefined], ['9007199254740991', undefined], ['nonsense', undefined]])('parses %s as %s', async (header, delay) => {
    const {client} = clientFor(header as string | undefined);
    const result = await client.eaas.context();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.retryAfterMs).toBe(delay);
      if (delay === undefined) expect(result.error).not.toHaveProperty('retryAfterMs');
    }
  });
  it.each([['Wed, 21 Oct 2026 07:28:10 GMT', 10000], ['Wed, 21 Oct 2026 07:27:00 GMT', 0]])('handles HTTP-date %s', async (header, delay) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-21T07:28:00Z'));
    const {client} = clientFor(header as string);
    const result = await client.eaas.context();
    expect(result).toMatchObject({error: {retryAfterMs: delay}});
  });
  it.each(['getFile', 'putFile', 'getArtifact', 'uploadAsset'] as const)('preserves header on %s raw errors', async method => {
    const {client} = clientFor('3', 503);
    const result = method === 'getFile' ? await client.environments.getFile('env','file.txt')
      : method === 'putFile' ? await client.environments.putFile('env','file.txt',new Uint8Array())
      : method === 'getArtifact' ? await client.environments.getArtifact('env','artifact')
      : await client.environments.uploadAsset('env',new Uint8Array(),'image/png');
    expect(result).toMatchObject({ ...body, error: {...body.error, retryAfterMs:3000} });
  });
  it.each(['json','raw'])('keeps header and requestId for non-JSON %s failure', async kind => {
    const {client} = clientFor('4', 503, false);
    const result = kind === 'json' ? await client.eaas.context() : await client.environments.getFile('env','file.txt');
    expect(result).toMatchObject({success:false, error:{code:'http_error',retryAfterMs:4000},requestId:'req-header'});
  });
  it('exposes delay on sandbox create errors with recovery coordinates', async () => {
    const {client,fetch} = clientFor('60');
    await expect(client.sandboxes.create({idempotencyKey:'create-once'})).rejects.toMatchObject({code:'quota_exceeded',requestId:'req-delay',retryAfterMs:60000,idempotencyKey:'create-once'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('exposes delay from waitUntilReady without changing error code', async () => {
    const {client} = clientFor('5',503);
    await expect(client.environments.waitUntilReady('env')).rejects.toMatchObject({code:'quota_exceeded',retryAfterMs:5000});
  });
});

it.each([['Wed Oct 21 07:28:10 2026',10000],['Wednesday, 21-Oct-26 07:28:10 GMT',10000],['Sun, 31 Feb 2027 07:28:10 GMT',undefined]])('HTTP date %s has UTC/calendar semantics',async(header,delay)=>{
  vi.stubEnv('TZ','Asia/Shanghai');vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-21T07:28:00Z'));
  try { const {client}=clientFor(header as string);const r=await client.eaas.context();expect(r.success).toBe(false);if(!r.success)expect(r.error.retryAfterMs).toBe(delay); }
  finally {vi.unstubAllEnvs();}
});
it.each([true,false])('SSE connection errors expose delay, JSON=%s',async json=>{
  const {connectEaasEvents}=await import('../../src/environment-stream');
  await expect(connectEaasEvents({baseUrl:'https://eaas.invalid',token:'sk-eaas-test',transport:'sse',onEvent:()=>{},fetch:async()=>new Response(json?JSON.stringify(body):'',{status:429,headers:{'Retry-After':'60'}})})).rejects.toMatchObject({retryAfterMs:60000});
});

it('high-level file errors retain delay',async()=>{
 const {SandboxHandle}=await import('../../src/eaas-sandbox');
 const {client}=clientFor('7',503);
 await expect(new SandboxHandle(client.environments,'env').files.read('file.txt')).rejects.toMatchObject({retryAfterMs:7000,requestId:'req-delay',environmentId:'env'});
});
it('does not trust body retry metadata without a valid header',async()=>{
 const client=new PrismerClient({apiKey:'sk-eaas-test',baseUrl:'https://eaas.invalid',fetch:async()=>new Response(JSON.stringify({...body,error:{...body.error,retryAfterMs:9000}}),{status:429})});
 const result=await client.eaas.context();expect(result).toMatchObject(body);if(!result.success)expect(result.error).not.toHaveProperty('retryAfterMs');
});
it('interprets a two-digit HTTP year within fifty years as future',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-21T07:28:00Z'));
 const {client}=clientFor('Wednesday, 21-Oct-75 07:28:10 GMT');
 expect(await client.eaas.context()).toMatchObject({error:{retryAfterMs:1546300810000}});
});
