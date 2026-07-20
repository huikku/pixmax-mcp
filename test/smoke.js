/**
 * E2E smoke test: spawn the MCP server over stdio as a real MCP client would,
 * list its tools, and run one cheap generation. Requires PIXMAX_API_KEY.
 *
 *   PIXMAX_API_KEY=pk_live_... node test/smoke.js
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const transport = new StdioClientTransport({
    command: 'node',
    args: [join(root, 'src/index.js')],
    env: { ...process.env },
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('✅ tools:', tools.map((t) => t.name).join(', '));

console.log('\n— list_models (image) —');
const lm = await client.callTool({ name: 'list_models', arguments: { node_type: 'GENERATE_IMAGE' } });
console.log(lm.content[0].text.split('\n').slice(0, 5).join('\n'), '\n...');

console.log('\n— generate_image (Seedream Lite, ~5cr) —');
const g = await client.callTool({
    name: 'generate_image',
    arguments: { prompt: 'a single red paper lantern on a plain grey background, product photo', model: 'JIMENG_5_LITE', resolution: '2K' },
});
console.log(g.content[0].text);

await client.close();
console.log('\n✅ smoke passed');
process.exit(0);
