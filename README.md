# pixmax-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Pixmax** generation API. Gives any MCP client — Claude Desktop, Cursor, Claude Code, your own agent — one set of tools to generate **images, video, text, audio, and 3D** across dozens of models on a single key: Seedream 5, Midjourney, Nano Banana, GPT Image, Qwen, Kling, Veo 3.1, Hailuo, Wan, Hunyuan 3D, ElevenLabs, and more.

Self-contained and dependency-light — it talks straight to `console.pixmax.ai/openapi`. No other services involved.

> Unofficial, community-built. Not affiliated with Pixmax.

---

## Install

Requires **Node 18+** and a Pixmax platform key (`pk_live_…`, created in the Pixmax console).

```bash
npx pixmax-mcp        # run directly
# or
git clone https://github.com/huikku/pixmax-mcp && cd pixmax-mcp && npm install
```

## Configure your MCP client

### Claude Desktop

Add to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "pixmax": {
      "command": "npx",
      "args": ["-y", "pixmax-mcp"],
      "env": { "PIXMAX_API_KEY": "pk_live_your_key_here" }
    }
  }
}
```

### Cursor / Claude Code / other stdio clients

Same idea — run `npx -y pixmax-mcp` with `PIXMAX_API_KEY` in the environment. For Claude Code:

```bash
claude mcp add pixmax -e PIXMAX_API_KEY=pk_live_your_key_here -- npx -y pixmax-mcp
```

## Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PIXMAX_API_KEY` | ✅ | — | Your `pk_live_…` platform key |
| `PIXMAX_CREDIT_USD` | | `0.007` | Credit→USD rate, **display only** (varies by plan) |
| `PIXMAX_PROJECT_UUID` | | auto | Reuse a specific Pixmax project |
| `PIXMAX_BASE_URL` | | `console.pixmax.ai/openapi` | Override the API base |

---

## Tools

| Tool | What it does |
|---|---|
| `list_models` | List models your key can use (filter by type), with estimated credit cost. **Call this first.** |
| `generate_image` | Image gen. `reference_images` (paths or URLs, up to 14, free) for image-to-image / character consistency. |
| `generate_video` | Video gen. `image` for image-to-video. `wait: false` returns a task id for long jobs. |
| `generate_text` | Text/LLM models. Returns the text. |
| `generate_3d` | Text → 3D model (`.glb`) via Hunyuan 3D. |
| `generate_audio` | Speech & music. `lyrics` for MiniMax Music. |
| `get_task` | Poll a task started with `wait: false`. |

Every generate tool accepts `save_to` — a directory to download the result into, because **Pixmax result URLs live on object storage and expire**. Always save anything you want to keep.

### Examples (natural language to your agent)

> "List the Pixmax video models."

> "Generate an image of a neon-lit alley at night with **Seedream 5.0 Pro** at 4K, save it to `./out`."

> "Using `./cleo.png` as a character reference, generate a shot of her on a rooftop in the rain with **Nano Banana Pro**."

> "Animate `./shot.png` into a 5-second clip with **Kling V3**."

---

## Models (what's typically available)

Depends on your account. `list_models` is authoritative. Common ones:

- **Image** — Seedream 5.0 Pro / Lite / 4.5 · Nano Banana / 2 / Pro · GPT Image 2 · Midjourney V7 / V8.1 / Niji 7 · Qwen Image Edit Plus / Max · MiniMax Image · Wan 2.7 Image / Pro
- **Video** — Kling V3 / V3 Omni / O1 / 2.6 · Veo 3.1 · Hailuo 02 / 2.3 · Wan 2.6 / 2.7 · PixVerse C1 / V6 · Vidu Q2 / Q3 · Seedance 1.5 / 2.0
- **Text** — DeepSeek V4 Flash / Pro · Gemini 2.5 / 3 / 3.1 · MiniMax M3 · Doubao Seed 2.x
- **Audio** — ElevenLabs V2 / V3 / Music · MiniMax Speech / Music
- **3D** — Hunyuan 3D Pro 3.0 / 3.1 (text-to-3D)

### Model quirks the server handles for you

- **Veo 3.1** runs at 8s (rejects other durations).
- **Hailuo** runs at 6s or 10s only.
- **Hunyuan 3D** is text-to-3D only.
- **MiniMax Music** requires `lyrics`.
- **Wan 2.7 Image** models require at least one input image.

---

## Cost

Pixmax bills in **credits**. Each tool reports the task's actual credit cost (from the API) and an approximate USD figure using `PIXMAX_CREDIT_USD`. The USD number is display-only — your real rate depends on your subscription tier. Failed and cancelled tasks cost nothing.

## Develop

```bash
npm install
PIXMAX_API_KEY=pk_live_... npm run smoke     # spawns the server, lists tools, runs one real generation
npm run inspect                              # open the MCP Inspector
```

## License

MIT © John Huikku / Alienrobot LLC
