# AI Agents & MCP — Implementation Guide

A practical guide to understanding and implementing AI agents using Claude and the
Model Context Protocol (MCP) in your React e-commerce app.

---

## Part 1 — Core concepts

### What is an AI agent?

A regular chatbot responds to one message and stops. An AI agent **loops**:
it receives a task, reasons about what steps are needed, calls tools to get real
data or take real actions, observes the results, and repeats until the task is done.

```
Regular chatbot:  User → LLM → Response

AI agent:         User → LLM ──→ Tool call ──→ Result
                               ↑                   │
                               └──── Next call ←───┘
                                          ↓
                                   Final response
```

### The ReAct pattern

The most common agent pattern is **ReAct** (Reason + Act):

1. **Reason** — think about what steps are needed
2. **Act** — call a tool
3. **Observe** — read the result
4. **Repeat** — reason about next step, or respond if done

Claude does this natively. You give it tools with descriptions; it decides
when and how to use them.

### What MCP adds

Without MCP you write code that decides which API to call and when. With MCP:

- Claude **decides** which tool to call based on the query
- Tools are **discoverable** — Claude reads their JSON schemas at runtime
- The same MCP server works with **any MCP-compatible AI**
- Multi-step chains happen **automatically** without orchestration code

---

## Part 2 — Writing good tool descriptions

The description is what Claude reads to decide whether to call a tool. Be specific.

```js
// Bad — Claude will not know when or why to use this
{
  name: "get_data",
  description: "Gets data"
}

// Good — Claude knows exactly when and why
{
  name: "get_product",
  description: `Retrieve a single product by ID, including name, price,
    description, ingredients, and image URL. Use when the user asks about
    a specific product or you already know the product ID. Requires the
    product's numeric ID.`,
  input_schema: {
    type: "object",
    properties: {
      id: { type: "number", description: "The product's numeric ID" }
    },
    required: ["id"]
  }
}
```

---

## Part 3 — MCP server setup

The MCP server is a separate Node.js process that declares your tools and
executes them when Claude calls them. Your backend at `127.0.0.1:7000` is
completely unchanged.

### Install

```bash
mkdir ecommerce-mcp-server
cd ecommerce-mcp-server
npm init -y
npm install @modelcontextprotocol/sdk axios
```

Add `"type": "module"` to `package.json`.

### server.js

```js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";

const BASE = "http://127.0.0.1:7000/api/v1";

const server = new Server(
  { name: "ecommerce-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Declare available tools ──────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list_products",
      description: `Get all products from the store. Optionally filter by
        category_id. Returns name, price, image, and category for each product.`,
      inputSchema: {
        type: "object",
        properties: {
          category_id: {
            type: "number",
            description: "Optional. Limit results to this category ID only."
          }
        }
      }
    },
    {
      name: "get_product",
      description: `Get a single product by ID, including full details,
        ingredients, and description.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "Product ID" }
        },
        required: ["id"]
      }
    },
    {
      name: "list_categories",
      description: `Get all product categories. Call this first when the user
        mentions a category by name — you need the ID before you can filter
        products.`,
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "get_reviews",
      description: `Get all customer reviews for a product. Returns title,
        content, rating, and date for each review.`,
      inputSchema: {
        type: "object",
        properties: {
          product_id: {
            type: "number",
            description: "Product ID to fetch reviews for"
          }
        },
        required: ["product_id"]
      }
    },
    {
      name: "submit_review",
      description: `Submit a new customer review for a product. Use when the
        user explicitly wants to leave a rating or write a review.`,
      inputSchema: {
        type: "object",
        properties: {
          product_id: { type: "number" },
          title:      { type: "string", description: "Short review headline" },
          content:    { type: "string", description: "Full review text" },
          rating: {
            type: "number",
            minimum: 1,
            maximum: 5,
            description: "Rating from 1 to 5"
          }
        },
        required: ["product_id", "title", "content", "rating"]
      }
    },
    {
      name: "generate_product_content",
      description: `Use AI to generate a structured content analysis for a
        product based on its reviews. Returns a summary and tagged topics.`,
      inputSchema: {
        type: "object",
        properties: {
          product_id: { type: "number" }
        },
        required: ["product_id"]
      }
    }
  ]
}));

// ── Execute tool calls ───────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let data;

    switch (name) {
      case "list_products": {
        const res = await axios.get(`${BASE}/products`);
        data = args.category_id
          ? res.data.filter(p => p.category_id === args.category_id)
          : res.data;
        break;
      }
      case "get_product":
        ({ data } = await axios.get(`${BASE}/product/${args.id}`));
        break;
      case "list_categories":
        ({ data } = await axios.get(`${BASE}/categories`));
        break;
      case "get_reviews":
        ({ data } = await axios.get(`${BASE}/reviews/${args.product_id}`));
        break;
      case "submit_review":
        ({ data } = await axios.post(`${BASE}/reviews`, {
          ...args,
          approved: true
        }));
        break;
      case "generate_product_content":
        ({ data } = await axios.post(`${BASE}/llama/generate/${args.product_id}`));
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true
    };
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("MCP server running");
```

### Run it

```bash
node server.js
```

---

## Part 4 — The agent loop in React

### Environment setup

Create `.env` in your React project root:

```
REACT_APP_ANTHROPIC_KEY=sk-ant-your-key-here
```

Add `.env` to `.gitignore` immediately — never commit API keys.

### src/agent.js

This is the core loop. It sends a message to Claude, handles tool calls by
calling your backend, then feeds results back to Claude until it's done.

```js
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL   = "claude-sonnet-4-6";

// Tool schemas — mirror what the MCP server exposes.
// In a production setup these would be fetched from the MCP server at startup.
const TOOLS = [
  {
    name: "list_products",
    description: "Get all products. Optionally filter by category_id.",
    input_schema: {
      type: "object",
      properties: {
        category_id: { type: "number", description: "Optional category ID" }
      }
    }
  },
  {
    name: "get_product",
    description: "Get a single product by ID with full details.",
    input_schema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"]
    }
  },
  {
    name: "list_categories",
    description: `Get all product categories. Always call this first when
      a category name is mentioned — you need the ID to filter products.`,
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "get_reviews",
    description: "Get all reviews for a product.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "number" }
      },
      required: ["product_id"]
    }
  },
  {
    name: "submit_review",
    description: "Submit a customer review for a product.",
    input_schema: {
      type: "object",
      properties: {
        product_id: { type: "number" },
        title:      { type: "string" },
        content:    { type: "string" },
        rating:     { type: "number", minimum: 1, maximum: 5 }
      },
      required: ["product_id", "title", "content", "rating"]
    }
  },
  {
    name: "generate_product_content",
    description: "Use AI to generate a structured content analysis for a product.",
    input_schema: {
      type: "object",
      properties: { product_id: { type: "number" } },
      required: ["product_id"]
    }
  }
];

// Execute a tool by calling your existing backend directly
async function executeTool(name, input) {
  const BASE = "http://127.0.0.1:7000/api/v1";

  switch (name) {
    case "list_products": {
      const products = await fetch(`${BASE}/products`).then(r => r.json());
      return input.category_id
        ? products.filter(p => p.category_id === input.category_id)
        : products;
    }
    case "get_product":
      return fetch(`${BASE}/product/${input.id}`).then(r => r.json());
    case "list_categories":
      return fetch(`${BASE}/categories`).then(r => r.json());
    case "get_reviews":
      return fetch(`${BASE}/reviews/${input.product_id}`).then(r => r.json());
    case "submit_review":
      return fetch(`${BASE}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, approved: true })
      }).then(r => r.json());
    case "generate_product_content":
      return fetch(`${BASE}/llama/generate/${input.product_id}`, {
        method: "POST"
      }).then(r => r.json());
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// The agent loop
// onStep is an optional callback so the UI can show which tools are being called
export async function runAgent(userMessage, onStep) {
  const apiKey  = process.env.REACT_APP_ANTHROPIC_KEY;
  const messages = [{ role: "user", content: userMessage }];
  let iterations = 0;
  const MAX_ITERATIONS = 10; // safety guard against infinite loops

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: `You are a helpful shopping assistant for an e-commerce grocery store.
Always use tools to get real data — never guess prices, names, or availability.
When the user mentions a category by name, call list_categories first to find its ID.`,
        messages,
        tools: TOOLS
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message ?? "API error");

    // Claude finished — return the final text
    if (data.stop_reason === "end_turn") {
      return data.content.find(b => b.type === "text")?.text ?? "Done.";
    }

    // Claude wants to call tools
    if (data.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: data.content });

      const toolResults = [];
      for (const block of data.content) {
        if (block.type !== "tool_use") continue;

        onStep?.({ type: "tool_call",   name: block.name, input: block.input });
        const result = await executeTool(block.name, block.input);
        onStep?.({ type: "tool_result", name: block.name, result });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result)
        });
      }

      messages.push({ role: "user", content: toolResults });
    }
  }

  throw new Error("Agent reached max iterations without completing.");
}
```

### src/AgentChat.js

```jsx
import React, { useState, useRef, useEffect } from "react";
import { runAgent } from "./agent";
import "./AgentChat.css";

const SUGGESTIONS = [
  "What's the cheapest dairy product?",
  "Compare prices between meat and vegetables",
  "Give product 1 a 5-star review saying it was excellent"
];

export default function AgentChat() {
  const [messages, setMessages] = useState([{
    role: "assistant",
    content: "Hi! Ask me anything about our products — I can search, compare prices, and help you leave reviews."
  }]);
  const [steps,   setSteps]   = useState([]);
  const [input,   setInput]   = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, steps]);

  const send = async (text) => {
    const query = (text ?? input).trim();
    if (!query || loading) return;
    setInput("");
    setLoading(true);
    setSteps([]);
    setMessages(prev => [...prev, { role: "user", content: query }]);

    try {
      const answer = await runAgent(query, (step) => {
        setSteps(prev => [...prev, step]);
      });
      setMessages(prev => [...prev, { role: "assistant", content: answer }]);
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: "assistant", content: `Something went wrong: ${err.message}` }
      ]);
    } finally {
      setLoading(false);
      setSteps([]);
    }
  };

  return (
    <div className="agent-chat">
      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>{m.content}</div>
        ))}

        {loading && steps.length > 0 && (
          <div className="tool-steps">
            {steps.map((s, i) => (
              <div key={i} className={`step step-${s.type}`}>
                {s.type === "tool_call"
                  ? `Calling ${s.name}…`
                  : `Got result from ${s.name}`}
              </div>
            ))}
          </div>
        )}

        {loading && (
          <div className="msg msg-assistant thinking">Thinking…</div>
        )}
        <div ref={bottomRef} />
      </div>

      {messages.length === 1 && (
        <div className="suggestions">
          {SUGGESTIONS.map((s, i) => (
            <button key={i} className="suggestion" onClick={() => send(s)}>
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="chat-input">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Ask about products, compare prices, leave a review…"
          disabled={loading}
        />
        <button onClick={() => send()} disabled={loading || !input.trim()}>
          Send
        </button>
      </div>
    </div>
  );
}
```

### src/AgentChat.css

```css
.agent-chat {
  display: flex;
  flex-direction: column;
  height: 520px;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  overflow: hidden;
  font-family: 'Segoe UI', sans-serif;
  background: #fff;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.msg {
  padding: 10px 14px;
  border-radius: 10px;
  max-width: 85%;
  font-size: 14px;
  line-height: 1.5;
}

.msg-user {
  background: #dbeafe;
  color: #1e40af;
  align-self: flex-end;
}

.msg-assistant {
  background: #f3f4f6;
  color: #1f2937;
  align-self: flex-start;
}

.msg-assistant.thinking {
  color: #9ca3af;
  font-style: italic;
}

.tool-steps {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-self: flex-start;
}

.step {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
}

.step-tool_call   { background: #fef3c7; color: #92400e; }
.step-tool_result { background: #d1fae5; color: #065f46; }

.suggestions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 16px 12px;
}

.suggestion {
  text-align: left;
  padding: 8px 12px;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  background: #fff;
  color: #374151;
  font-size: 13px;
  cursor: pointer;
}

.suggestion:hover { background: #f9fafb; }

.chat-input {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid #e5e7eb;
}

.chat-input input {
  flex: 1;
  padding: 10px 14px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
}

.chat-input input:focus { border-color: #3b82f6; }

.chat-input button {
  padding: 10px 20px;
  background: #1e40af;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
}

.chat-input button:disabled { opacity: 0.5; cursor: not-allowed; }
```

---

## Part 5 — Wire it into the app

In `App.js`:

```jsx
import AgentChat from "./AgentChat";

// Inside <Routes>:
<Route path="/agent" element={<AgentChat />} />
```

In `Navbar.js`, add to `menuItems`:

```js
{
  label: <NavLink to="/agent">AI Assistant</NavLink>,
  key: "agent"
}
```

---

## Part 6 — Example conversations

These all work with the agent above. Each shows what tool calls happen behind
the scenes.

**Comparison query (3 tool calls)**
```
User:  "Which is cheaper on average — dairy or vegetables?"

Agent: list_categories()
       → finds Dairy id=2, Vegetables id=4
Agent: list_products({ category_id: 2 })
       → dairy products with prices
Agent: list_products({ category_id: 4 })
       → vegetable products with prices
Agent: "Dairy products average $4.12/lb; vegetables average $2.87/lb.
        Vegetables are cheaper on average."
```

**Review submission (2 tool calls)**
```
User:  "Leave a 5-star review for product 3 — say the quality was great"

Agent: get_product({ id: 3 })
       → confirms product exists: "Organic Tomatoes"
Agent: submit_review({ product_id: 3, title: "Great quality",
                       content: "The quality was great.", rating: 5 })
Agent: "Done — I've submitted your 5-star review for Organic Tomatoes."
```

**Best-reviewed product (N+1 tool calls)**
```
User:  "Which product has the best average rating?"

Agent: list_products()            → all products
Agent: get_reviews({ id: 1 })
Agent: get_reviews({ id: 2 })
       … (one call per product)
Agent: "Greek Yogurt has the best average rating at 4.8 stars (12 reviews)."
```

---

## Part 7 — Security checklist

**Never ship the API key in React.** Move to a backend proxy:

```js
// server-side Express route (add to your existing backend)
app.post("/api/agent", async (req, res) => {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_KEY,   // server-side only
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(req.body)
  });
  res.json(await response.json());
});
```

Then point `agent.js` at `/api/agent` instead of the Anthropic URL directly.

Other checklist items:
- The `MAX_ITERATIONS = 10` guard in `agent.js` prevents runaway loops
- Validate and sanitize MCP tool inputs before calling the backend
- Add per-user rate limiting on the proxy to prevent abuse
- Only expose tools appropriate for the user's role (e.g. admin-only `create_product`)

---

## Part 8 — Replace Gemini.js (optional)

Once the agent is running, `Gemini.js` can be retired. The
`generate_product_content` MCP tool does exactly the same thing. In
`ProductDetail.js`, replace:

```jsx
<Gemini id={id} />
```

with a call through the agent:

```jsx
// On page load, ask the agent to generate content for this product
const [aiContent, setAiContent] = useState(null);

useEffect(() => {
  runAgent(`Generate AI content analysis for product ${id}`)
    .then(setAiContent);
}, [id]);

// Render aiContent in place of <Gemini />
```

---

## Part 9 — Next steps

**Streaming** — use the Anthropic streaming API so Claude's response appears
word-by-word. Add `stream: true` to the request body and handle the SSE stream.

**Conversation memory** — pass previous `messages` into `runAgent` to give
the agent context across turns in the same session. Store in React state.

**More tools** — natural next additions:
- `search_products_by_keyword(query)` for search
- `get_product_recommendations(product_id)` for related items
- `check_inventory(product_id)` when stock tracking is added

---

## Resources

- Anthropic agents overview — https://docs.anthropic.com/en/docs/agents-overview
- Tool use (function calling) — https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- MCP specification — https://modelcontextprotocol.io
- MCP TypeScript SDK — https://github.com/modelcontextprotocol/typescript-sdk
- Claude API reference — https://docs.anthropic.com/en/api/messages
