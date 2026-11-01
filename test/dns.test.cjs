const assert = require('node:assert/strict');
const { test } = require('node:test');
const axios = require('axios');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
const createServer = require('../dist/index.js').default;

const hostsXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse xmlns="http://api.namecheap.com/xml.response" Status="OK">
  <Errors />
  <CommandResponse Type="namecheap.domains.dns.getHosts">
    <DomainDNSGetHostsResult Domain="example.com" IsUsingOurDNS="true" EmailType="FWD">
      <Host HostId="1" Name="@" Type="URL" Address="https://example.org/?a=1&amp;b=2" MXPref="10" TTL="1800" />
      <Host HostId="2" Name="@" Type="TXT" Address="v=spf1 include:spf.efwd.registrar-servers.com ~all" MXPref="10" TTL="1800" />
    </DomainDNSGetHostsResult>
  </CommandResponse>
</ApiResponse>`;

const setHostsXml = `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse xmlns="http://api.namecheap.com/xml.response" Status="OK">
  <Errors />
  <CommandResponse Type="namecheap.domains.dns.setHosts">
    <DomainDNSSetHostsResult Domain="example.com" IsSuccess="true" />
  </CommandResponse>
</ApiResponse>`;

async function connect(t, responseXml = hostsXml) {
  const requests = [];
  const originalCreate = axios.create;
  t.mock.method(axios, 'create', config => originalCreate({
    ...config,
    adapter: async request => {
      requests.push(request);
      return { data: responseXml, status: 200, statusText: 'OK', headers: {}, config: request };
    },
  }));
  const server = createServer({ config: {
    NAMECHEAP_API_KEY: 'test-key',
    NAMECHEAP_API_USER: 'test-user',
    NAMECHEAP_CLIENT_IP: '192.0.2.1',
    NAMECHEAP_USE_SANDBOX: true,
  } });
  const client = new Client({ name: 'dns-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return { client, requests };
}

test('gethosts reads host records and preserves XML; getlist reads nameservers', async t => {
  const { client, requests } = await connect(t);
  const result = await client.callTool({
    name: 'namecheap_dns_gethosts', arguments: { sld: 'example', tld: 'com' },
  });
  assert.deepEqual(JSON.parse(result.content[0].text), { raw: hostsXml });
  assert.equal(requests[0].method, 'get');
  assert.equal(requests[0].params.Command, 'namecheap.domains.dns.getHosts');
  assert.equal(requests[0].params.SLD, 'example');
  assert.equal(requests[0].params.TLD, 'com');
  assert.equal(requests[0].baseURL, 'https://api.sandbox.namecheap.com/xml.response');

  await client.callTool({
    name: 'namecheap_dns_getlist', arguments: { sld: 'example', tld: 'com' },
  });
  assert.equal(requests[1].params.Command, 'namecheap.domains.dns.getList');
  const { tools } = await client.listTools();
  assert.match(tools.find(tool => tool.name === 'namecheap_dns_getlist').description, /nameservers/);
});

test('sethosts form encoding preserves every supplied record field and explicit email mode', async t => {
  const { client, requests } = await connect(t, setHostsXml);
  // Exercise wire encoding of each record type; the provider validates zone/mail combinations.
  const hosts = [
    { hostname: '@', recordType: 'URL', address: 'https://example.org/?a=1&b=two+three' },
    { hostname: 'www', recordType: 'URL301', address: 'https://example.org/' },
    { hostname: 'frame', recordType: 'FRAME', address: 'https://example.org/' },
    { hostname: 'alias', recordType: 'ALIAS', address: 'example.org.' },
    { hostname: '@', recordType: 'MX', address: 'eforward1.registrar-servers.com.', mxPriority: 10 },
    { hostname: 'mail', recordType: 'MXE', address: '192.0.2.2', mxPriority: 0 },
    { hostname: '@', recordType: 'TXT', address: 'v=spf1 include:spf.efwd.registrar-servers.com ~all' },
    { hostname: '_token', recordType: 'TXT', address: 'value="a+b=c&d"' },
    { hostname: '@', recordType: 'CAA', address: '0 issue "letsencrypt.org"' },
    { hostname: 'v6', recordType: 'AAAA', address: '2001:db8::1' },
    { hostname: 'cdn', recordType: 'CNAME', address: 'example.org.' },
    { hostname: 'delegated', recordType: 'NS', address: 'ns.example.org.' },
    { hostname: 'app', recordType: 'A', address: '192.0.2.3' },
    { hostname: 'infra', recordType: 'A', address: '192.0.2.3' },
  ].map((host, index) => ({ ...host, ttl: index === 0 ? 600 : 1800 }));

  const result = await client.callTool({ name: 'namecheap_dns_sethosts', arguments: {
    sld: 'example', tld: 'com', emailType: 'FWD', hosts,
  } });
  assert.deepEqual(JSON.parse(result.content[0].text), { raw: setHostsXml });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.method, 'post');
  assert.equal(request.params, null);
  assert.match(request.headers.get('Content-Type'), /^application\/x-www-form-urlencoded/);
  const body = new URLSearchParams(request.data);
  assert.equal(body.get('Command'), 'namecheap.domains.dns.setHosts');
  assert.equal(body.get('SLD'), 'example');
  assert.equal(body.get('TLD'), 'com');
  assert.equal(body.get('EmailType'), 'FWD');
  assert.equal(body.get('ApiKey'), 'test-key');
  assert.equal(body.get('ApiUser'), 'test-user');
  assert.equal(body.get('UserName'), 'test-user');
  assert.equal(body.get('ClientIp'), '192.0.2.1');
  assert.equal([...body.keys()].filter(key => /^HostName\d+$/.test(key)).length, hosts.length);
  for (const [index, host] of hosts.entries()) {
    const number = index + 1;
    assert.equal(body.get(`HostName${number}`), host.hostname);
    assert.equal(body.get(`RecordType${number}`), host.recordType);
    assert.equal(body.get(`Address${number}`), host.address);
    assert.equal(body.get(`TTL${number}`), String(host.ttl));
    assert.equal(body.get(`MXPref${number}`), host.mxPriority === undefined ? null : String(host.mxPriority));
  }
});

test('sethosts leaves optional email mode absent and rejects unsupported SRV before HTTP', async t => {
  const { client, requests } = await connect(t, setHostsXml);
  const host = { hostname: 'app', recordType: 'A', address: '192.0.2.3' };
  await client.callTool({ name: 'namecheap_dns_sethosts', arguments: {
    sld: 'example', tld: 'com', hosts: [host],
  } });
  const body = new URLSearchParams(requests[0].data);
  assert.equal(body.has('EmailType'), false);
  assert.equal(body.get('TTL1'), '1800');
  const result = await client.callTool({ name: 'namecheap_dns_sethosts', arguments: {
    sld: 'example', tld: 'com', hosts: [{ ...host, recordType: 'SRV' }],
  } });
  assert.equal(result.isError, true);
  assert.equal(requests.length, 1);

  for (const emailType of ['NONE', 'MXE', 'MX', 'FWD', 'OX', 'GMAIL']) {
    await client.callTool({ name: 'namecheap_dns_sethosts', arguments: {
      sld: 'example', tld: 'com', emailType, hosts: [host],
    } });
    assert.equal(new URLSearchParams(requests.at(-1).data).get('EmailType'), emailType);
  }
});
