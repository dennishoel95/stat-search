const express = require("express");
const Anthropic = require("@anthropic-ai/sdk").default;
const path = require("path");

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ERROR: No ANTHROPIC_API_KEY found. Set it in Vercel environment variables.");
}

const app = express();
app.use(express.json());

// Diagnostic endpoint — remove after confirming env vars work
app.get("/api/debug-env", (req, res) => {
  res.json({
    hasSitePassword: !!process.env.SITE_PASSWORD,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    nodeEnv: process.env.NODE_ENV || "not set",
  });
});

// Password protection middleware
const SITE_PASSWORD = process.env.SITE_PASSWORD;
if (SITE_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === "/api/login") return next();

    const cookies = req.headers.cookie || "";
    const authMatch = cookies.match(/(?:^|;\s*)stat_auth=([^;]*)/);
    if (authMatch && authMatch[1] === Buffer.from(SITE_PASSWORD).toString("base64")) {
      return next();
    }

    if (!req.path.startsWith("/api/")) {
      return res.send(loginPage());
    }

    res.status(401).json({ error: "Unauthorized" });
  });

  app.post("/api/login", (req, res) => {
    if (req.body.password === SITE_PASSWORD) {
      const token = Buffer.from(SITE_PASSWORD).toString("base64");
      res.setHeader("Set-Cookie", `stat_auth=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
      res.json({ ok: true });
    } else {
      res.status(401).json({ error: "Wrong password" });
    }
  });
}

function loginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>StatSearch — Login</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&display=swap');
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, sans-serif;
      background: #fafaf9;
      color: #1c1917;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .login-box {
      background: #fff;
      border: 1px solid #e7e5e4;
      border-radius: 1rem;
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 360px;
      text-align: center;
    }
    h1 { font-weight: 300; font-size: 1.5rem; margin-bottom: 0.25rem; }
    h1 span { font-weight: 600; background: linear-gradient(135deg, #6366f1, #a855f7); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #78716c; font-size: 0.8rem; margin-bottom: 1.5rem; }
    .field { display: flex; gap: 0.5rem; border: 1px solid #e7e5e4; border-radius: 0.75rem; padding: 0.35rem; transition: border-color 0.2s; }
    .field:focus-within { border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99,102,241,0.08); }
    .field input { flex: 1; border: none; outline: none; font-family: inherit; font-size: 0.9rem; padding: 0.5rem 0.75rem; background: transparent; }
    .field button { background: #6366f1; color: #fff; border: none; border-radius: 0.5rem; padding: 0.5rem 1.25rem; font-family: inherit; font-size: 0.85rem; font-weight: 500; cursor: pointer; transition: background 0.2s; }
    .field button:hover { background: #4f46e5; }
    .error { color: #dc2626; font-size: 0.8rem; margin-top: 0.75rem; display: none; }
  </style>
</head>
<body>
  <div class="login-box">
    <h1><span>StatSearch</span></h1>
    <p class="subtitle">Enter password to continue</p>
    <div class="field">
      <input type="password" id="pw" placeholder="Password" onkeydown="if(event.key==='Enter')login()" autofocus>
      <button onclick="login()">Enter</button>
    </div>
    <p class="error" id="err">Incorrect password</p>
  </div>
  <script>
    async function login() {
      const pw = document.getElementById('pw').value;
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw })
      });
      if (res.ok) { location.reload(); }
      else { document.getElementById('err').style.display = 'block'; }
    }
  </script>
</body>
</html>`;
}

// Serve static files — use includeFiles to ensure public/ is available on Vercel
app.use(express.static(path.join(__dirname, "../public")));

// Fallback: serve index.html for root path
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

const anthropic = new Anthropic({ apiKey });

// PxWeb API base URLs
const BASES = {
  ssb: "https://data.ssb.no/api/v0/en/table",
  scb: "https://api.scb.se/OV0104/v1/doris/en/ssd",
  statfin: "https://pxdata.stat.fi/PXWeb/api/v1/en/StatFin",
};

// Tools for Claude
const tools = [
  {
    name: "list_path",
    description:
      "List contents at a path in the statistical database. Use '/' for top-level categories. Each result has an 'id' (subfolder/table name), 'text' (human label), and 'type' ('l'=folder, 't'=table). Navigate by appending ids to the path, e.g. '/' -> '/be' -> '/be/be01'. For SSB, common top-level ids: 'be'=Population, 'al'=Labour, 'ei'=Energy, 'helse'=Health, 'inntekt'=Income, 'priser'=Prices, 'utdan'=Education.",
    input_schema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["ssb", "scb", "statfin"],
          description: "ssb=Norway, scb=Sweden, statfin=Finland",
        },
        path: {
          type: "string",
          description: "Path to list, e.g. '/' or '/be/be01/folkemengde'",
        },
      },
      required: ["source", "path"],
    },
  },
  {
    name: "get_table_info",
    description:
      "Get metadata for a specific table (type='t'). Returns variable names, codes, and available values. You need this before fetching data.",
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["ssb", "scb", "statfin"] },
        path: { type: "string", description: "Full path to the table" },
      },
      required: ["source", "path"],
    },
  },
  {
    name: "fetch_data",
    description:
      'Fetch data from a table. Build query from metadata. Use filter "item" with specific value codes, or "all" with ["*"] to get everything for a variable. Keep queries small - select only needed values.',
    input_schema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["ssb", "scb", "statfin"] },
        path: { type: "string" },
        query: {
          type: "array",
          items: {
            type: "object",
            properties: {
              code: { type: "string" },
              selection: {
                type: "object",
                properties: {
                  filter: { type: "string" },
                  values: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
      required: ["source", "path", "query"],
    },
  },
];

// Execute a tool call
async function executeTool(name, input) {
  const base = BASES[input.source];
  if (!base) return { error: "Unknown source" };

  try {
    if (name === "list_path") {
      const p = input.path === "/" ? "" : input.path;
      const url = `${base}${p}`;
      const resp = await fetch(url);
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      const data = await resp.json();
      if (Array.isArray(data)) {
        return data.slice(0, 30).map((d) => ({
          id: d.id,
          text: d.text,
          type: d.type,
        }));
      }
      return data;
    }

    if (name === "get_table_info") {
      const url = `${base}${input.path}`;
      const resp = await fetch(url);
      if (!resp.ok) return { error: `HTTP ${resp.status}` };
      const data = await resp.json();
      if (data.variables) {
        return {
          title: data.title,
          variables: data.variables.map((v) => ({
            code: v.code,
            text: v.text,
            values: v.values?.slice(0, 30),
            valueTexts: v.valueTexts?.slice(0, 30),
            totalValues: v.values?.length,
          })),
        };
      }
      return data;
    }

    if (name === "fetch_data") {
      const url = `${base}${input.path}`;
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: input.query,
          response: { format: "json" },
        }),
      });
      if (!resp.ok) {
        const text = await resp.text();
        return { error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };
      }
      const data = await resp.json();
      if (data.data && data.data.length > 80) {
        data.data = data.data.slice(0, 80);
        data._note = "Truncated to 80 rows";
      }
      return data;
    }

    return { error: "Unknown tool" };
  } catch (err) {
    return { error: err.message };
  }
}

const systemPrompt = `You are a statistics assistant helping users find Nordic statistics via PxWeb APIs.

LANGUAGE: Always respond in the same language the user writes in. If they write in Norwegian, respond in Norwegian. If in Swedish, respond in Swedish. Match their language exactly.

Sources: SSB (Norway), SCB (Sweden), StatFin (Finland). Default to SSB.

IMPORTANT: Be efficient with tool calls. Navigate directly when you can:
- For SSB population: list_path "/" to see categories, then drill into "be" (Population)
- Tables have type "t", folders have type "l"
- When you find a table (type "t"), use get_table_info to see its variables
- Then fetch_data with appropriate filters
- Try to reach data in 3-4 tool calls maximum

Present results as clean markdown tables.

TRANSPARENCY REQUIREMENTS — follow these strictly:
1. Always include a direct verification link to the source table. Build it from the source and path:
   - SSB: https://data.ssb.no/api/v0/en/table{path} (API) and https://www.ssb.no/statbank/table/{tableId}/ (web UI, tableId is the last segment e.g. "07459")
   - SCB: https://api.scb.se/OV0104/v1/doris/en/ssd{path} (API) and https://www.statistikdatabasen.scb.se/pxweb/en/ssd{path} (web UI)
   - StatFin: https://pxdata.stat.fi/PXWeb/api/v1/en/StatFin{path} (API) and https://pxdata.stat.fi/PXWeb/pxweb/en/StatFin{path} (web UI)
   Present the web UI link so users can browse the table themselves.

2. Clearly label what is raw data from the source vs what is your own analysis:
   - Numbers in tables are directly from the statistical agency — say "Data from [agency name]"
   - Any summaries, interpretations, key findings, trends, or commentary you write must be labeled as "AI-generated summary" or "AI analysis". For example: "**AI-generated summary:** Norway's population grew by 12% over this period."
   - Never present your interpretations as if they came from the statistical agency.

3. Briefly tell the user how to find the table themselves: e.g. "To find this table: go to [web UI link], navigate to [category] > [subcategory] > [table name]."`;


// Chat endpoint
app.post("/api/chat", async (req, res) => {
  const { messages } = req.body;

  try {
    let currentMessages = [...messages];
    let finalResponse = "";

    // Agentic loop with generous limit
    for (let i = 0; i < 15; i++) {
      console.log(`[${i}] Calling Claude...`);
      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages: currentMessages,
      });

      // Collect any text
      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      const toolUses = response.content.filter((b) => b.type === "tool_use");

      // If no tool calls, we're done
      if (toolUses.length === 0) {
        finalResponse = text;
        break;
      }

      // If stop_reason is end_turn (text + tools), capture text and still run tools
      if (response.stop_reason === "end_turn") {
        finalResponse = text;
        break;
      }

      // Execute tools
      const toolResults = [];
      for (const tu of toolUses) {
        console.log(`  -> ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)})`);
        const result = await executeTool(tu.name, tu.input);
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify(result),
        });
      }

      currentMessages.push({ role: "assistant", content: response.content });
      currentMessages.push({ role: "user", content: toolResults });
    }

    res.json({ response: finalResponse });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// For local development
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3456;
  app.listen(PORT, () => {
    console.log(`StatSearch running at http://localhost:${PORT}`);
  });
}

// Export for Vercel serverless
module.exports = app;
