"""Header metadata through real sync/async SDK transports; no network or retries."""
import httpx
import pytest
from prismer.client import PrismerClient, AsyncPrismerClient, EnvironmentsClient, AsyncEnvironmentsClient
from prismer.types import EaasClientError, EaasErrorBody

BODY = {"success": False, "error": {"code": "quota_exceeded", "message": "full", "details": {"active": 10}}, "requestId": "req-delay"}

def response(header="60", status=429, json=True):
    headers = {"x-request-id": "req-header"}
    if header is not None:
        headers["Retry-After"] = header
    return httpx.Response(status, headers=headers, **({"json": BODY} if json else {"text": "unavailable"}))

@pytest.mark.parametrize("header,expected", [("60",60000),("0",0),(None,None),("",None),("-1",None),("1.5",None),("Infinity",None),("9007199254740991",None),("nonsense",None),("Wed, 21 Oct 2026 07:28:10 GMT",10000),("Wed, 21 Oct 2026 07:27:00 GMT",0)])
def test_sync_header_metadata(header, expected, monkeypatch):
    monkeypatch.setattr('prismer.client.time.time',lambda: 1792567680)
    calls=[]
    def handle(request):
        calls.append(request)
        return response(header)
    c=PrismerClient(api_key='sk-eaas-test',base_url='https://eaas.invalid')
    c._client.close()
    c._client=httpx.Client(base_url='https://eaas.invalid',transport=httpx.MockTransport(handle))
    try:
        result=c.environments.create({'ttlSeconds':600})
        assert result['error'].get('retryAfterMs')==expected
        assert result['error']['code']=='quota_exceeded'
        assert result['requestId']=='req-delay'
        assert len(calls)==1
        if expected is None:
            assert 'retryAfterMs' not in result['error']
    finally:
        c.close()

@pytest.mark.asyncio
@pytest.mark.parametrize('status',[402,429,503])
async def test_async_json_and_wait_error(status):
    c=AsyncPrismerClient(api_key='sk-eaas-test',base_url='https://eaas.invalid')
    await c._client.aclose()
    c._client=httpx.AsyncClient(base_url='https://eaas.invalid',transport=httpx.MockTransport(lambda r:response(status=status)))
    try:
        result=await c.eaas.context()
        assert result['error']['retryAfterMs']==60000
        with pytest.raises(EaasClientError) as exc:
            await c.environments.wait_until_ready('env')
        assert exc.value.retry_after_ms==60000
    finally:
        await c.close()

@pytest.mark.parametrize('json',[True,False])
def test_raw_error_and_non_json(json):
    c=EnvironmentsClient(lambda *a,**kw:None,raw_request_fn=lambda *a,**kw:response(json=json))
    result=c.get_file('env','file.txt')
    assert result['error']['retryAfterMs']==60000
    assert result['requestId']==('req-delay' if json else 'req-header')

@pytest.mark.asyncio
async def test_async_raw_error():
    async def raw(*a,**kw):return response(status=503)
    c=AsyncEnvironmentsClient(None,raw_request_fn=raw)
    result=await c.get_file('env','file.txt')
    assert result['error']['retryAfterMs']==60000

def test_typed_error_preserves_metadata():
    error=EaasErrorBody.model_validate({**BODY['error'],'retryAfterMs':60000})
    assert error.retry_after_ms==60000
    assert error.model_dump(by_alias=True)['retryAfterMs']==60000

@pytest.mark.parametrize('header,expected', [('Wed Oct 21 07:28:10 2026',10000),('Sun, 31 Feb 2027 07:28:10 GMT',None),('Wednesday, 21-Oct-75 07:28:10 GMT',1546300810000)])
def test_http_date_utc_and_calendar(header,expected,monkeypatch):
    monkeypatch.setattr('prismer.client.time.time',lambda:1792567680)
    c=EnvironmentsClient(None,raw_request_fn=lambda *a,**kw:response(header))
    assert c.get_file('env','file.txt')['error'].get('retryAfterMs')==expected

@pytest.mark.asyncio
@pytest.mark.parametrize('asynchronous',[False,True])
async def test_non_json_main_transport(asynchronous):
    c=(AsyncPrismerClient if asynchronous else PrismerClient)(api_key='sk-eaas-test',base_url='https://eaas.invalid')
    if asynchronous:
        await c._client.aclose()
        c._client=httpx.AsyncClient(base_url='https://eaas.invalid',transport=httpx.MockTransport(lambda r:response(json=False,status=503)))
        result=await c.eaas.context()
        await c.close()
    else:
        c._client.close()
        c._client=httpx.Client(base_url='https://eaas.invalid',transport=httpx.MockTransport(lambda r:response(json=False,status=503)))
        result=c.eaas.context()
        c.close()
    assert result['error']=={'code':'http_error','message':'request failed with status 503','retryAfterMs':60000}
    assert result['requestId']=='req-header'
