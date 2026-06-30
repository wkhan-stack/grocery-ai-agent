// ─── Config ───────────────────────────────────────────────────────────────────

// Orchestrator uses 70B for complex routing decisions
const ORCHESTRATOR_CONFIG = {
  url:    "https://api.groq.com/openai/v1/chat/completions",
  model:  "llama-3.3-70b-versatile",
  // model:  "llama-3.1-8b-instant",
  apiKey: import.meta.env.VITE_GROQ_KEY,
}

// Specialists use 8B — faster, higher rate limit (30K TPM free), good enough for tool calls
const SPECIALIST_CONFIG = {
  url:    "https://api.groq.com/openai/v1/chat/completions",
  model:  "llama-3.1-8b-instant",
  apiKey: import.meta.env.VITE_GROQ_KEY,
}


const BASE = "/api/v1"
let _validProductIds = new Set()

// Reads Groq's suggested wait time from the error message and retries
async function callGroq(config, body, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization:  `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    const data = await response.json()

    if (response.status === 429) {
      const msg   = data.error?.message ?? ""
      const match = msg.match(/try again in (\d+)ms/)
      const wait  = match ? parseInt(match[1]) + 200 : 1500 * (attempt + 1)
      console.log(`Rate limited — waiting ${wait}ms`)
      await new Promise(r => setTimeout(r, wait))
      continue
    }

    if (!response.ok) throw new Error(data.error?.message ?? "API error")
    return data
  }
  throw new Error("Rate limit: still limited after retries. Wait a moment and try again.")
}

// ─── Shared backend tool executor ─────────────────────────────────────────────
// All three specialists share this function — they just get different subsets
// of tools exposed to them via their TOOLS array.

async function executeTool(name, input) {
  switch (name) {
    case "search_products_semantic":
      return fetch(`${BASE}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: input.query, n_results: input.n_results || 5 }),
      }).then(r => r.json())

    case "list_products": {
  const products = await fetch(`${BASE}/products`).then(r => r.json())
  const valid = Array.isArray(products) ? products.filter(Boolean) : []
  // Store every real ID we've seen this query
  valid.forEach(p => _validProductIds.add(Number(p.id)))
  return input.category_id
    ? valid.filter(p => p.category_id === input.category_id)
    : valid
}

    case "get_product": {
  const id = Number(input.id)
  if (_validProductIds.size > 0 && !_validProductIds.has(id)) {
    return {
      error: `Product ID ${id} does not exist.`,
      hint:  `Valid product IDs in the database: ${[..._validProductIds].join(', ')}. Use one of these.`,
    }
  }
  return fetch(`${BASE}/product/${id}`).then(r => r.json())
}

    case "list_categories": {
      const data = await fetch(`${BASE}/categories`).then(r => r.json())
      return Array.isArray(data) ? data.filter(Boolean) : []
    }

    case "get_reviews": {
  const id = Number(input.product_id)
  if (_validProductIds.size > 0 && !_validProductIds.has(id)) {
    return {
      error: `Product ID ${id} does not exist.`,
      hint:  `Valid product IDs in the database: ${[..._validProductIds].join(', ')}. Use one of these.`,
    }
  }
  const res = await fetch(`${BASE}/reviews/${id}`)
  if (!res.ok) return []
  const data = await res.json()
  return Array.isArray(data) ? data.filter(Boolean) : []
}

    case "submit_review":
      return fetch(`${BASE}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...input, approved: true }),
      }).then(r => r.json())

    case "generate_product_content":
      return fetch(`${BASE}/llama/generate/${input.product_id}`, {
        method: "POST",
      }).then(r => r.json())

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ─── Generic agent loop ───────────────────────────────────────────────────────
// Reused by all three specialists. Each one passes its own system prompt,
// task, and allowed tools — the loop is identical for all of them.

// Add `config` as the first parameter
async function runAgentLoop(config, systemPrompt, task, tools, onStep, maxIterations = 6) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user",   content: task },
  ]

  const seenCalls = new Set()  // prevents the same tool+args being called twice
  let iterations = 0

  while (iterations < maxIterations) {
    iterations++

    const data = await callGroq(config, {
      model:       config.model,
      messages,
      tools,
      tool_choice: iterations >= maxIterations - 1 ? "none" : "auto",  // force answer near limit
      temperature: 0.1,
    })

    const choice  = data.choices[0]
    const message = choice.message

    if (choice.finish_reason === "stop") return message.content

    if (choice.finish_reason === "tool_calls" && message.tool_calls?.length) {
      messages.push({ role: "assistant", ...message })

      for (const toolCall of message.tool_calls) {
        const name  = toolCall.function.name
        const input = JSON.parse(toolCall.function.arguments || "{}") || {}

        // Skip if we've already called this exact tool with these exact args
        const callKey = `${name}:${JSON.stringify(input)}`
        if (seenCalls.has(callKey)) {
          messages.push({
            role:         "tool",
            tool_call_id: toolCall.id,
            content:      "Already retrieved. Use the previous result.",
          })
          continue
        }
        seenCalls.add(callKey)

        onStep?.({ type: "tool_call",   name, input })
        const result = await executeTool(name, input)
        onStep?.({ type: "tool_result", name, result })

        messages.push({
          role:         "tool",
          tool_call_id: toolCall.id,
          content:      JSON.stringify(result),
        })
      }
    }
  }

  return "Specialist could not complete within iteration limit."
}

// ─── Specialist: Product agent ────────────────────────────────────────────────
// Handles finding, searching, browsing, and comparing products.

const PRODUCT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_products_semantic",
      description: "Search products by meaning. Use for descriptive queries like 'high protein', 'healthy snack', 'quick to cook'.",
      parameters: {
        type: "object",
        properties: {
          query:     { type: "string", description: "What the user is looking for, in their words" },
          n_results: { type: "number", description: "How many results, default 5" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_products",
      description: "Get all products, optionally filtered by category_id.",
      parameters: {
        type: "object",
        properties: {
          category_id: { type: "number", description: "Optional category ID filter" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_product",
      description: "Get full details for a single product by ID.",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Product ID" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_categories",
      description: "Get all product categories. Always call this first when a category name is mentioned.",
      parameters: { type: "object", properties: {} },
    },
  },
]

function runProductAgent(task, onStep) {
  return runAgentLoop(
    SPECIALIST_CONFIG,
    `You are a product specialist for a grocery store.
RULES — follow exactly:
1. Call list_categories FIRST if a category name is mentioned.
2. Call list_products (with category_id if known) to get real products and their IDs.
3. Use ONLY the exact "id" numbers returned in tool results. Never invent IDs.
4. Do NOT call get_product unless you already have a valid id from list_products.
5. Stop calling tools once you have enough data to answer.
6. Return the product names, IDs, and prices in your response.`,
    task, PRODUCT_TOOLS, onStep,
  )
}

// ─── Specialist: Review agent ─────────────────────────────────────────────────
// Handles reading and submitting product reviews.
// Given list_products/get_product access so it can resolve a product name to an
// ID when the orchestrator passes a name instead of a numeric ID.

// Replace REVIEW_TOOLS — remove list_products entirely
const REVIEW_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_reviews",
      description: "Get reviews for a product using its exact numeric ID provided in the task.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "number", description: "Exact product ID given in the task" },
        },
        required: ["product_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_review",
      description: "Submit a review using an exact product ID provided in the task.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "number" },
          title:      { type: "string" },
          content:    { type: "string" },
          rating:     { type: "number", minimum: 1, maximum: 5 },
        },
        required: ["product_id", "title", "content", "rating"],
      },
    },
  },
]

function runReviewAgent(task, onStep) {
  return runAgentLoop(
    SPECIALIST_CONFIG,
    `You are a review specialist for a grocery store.
RULES — follow exactly:
1. The task will give you explicit product IDs — use ONLY those IDs.
2. Call get_reviews using only the exact IDs provided in the task.
3. NEVER guess, invent, or generate product IDs.
4. NEVER call list_products to search for more products — the IDs are already given.
5. If no IDs are provided in the task, say "No product IDs were provided" and stop.`,
    task, REVIEW_TOOLS, onStep,
  )
}

// ─── Specialist: Content agent ────────────────────────────────────────────────
// Handles AI-powered product content generation and analysis.

const CONTENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_product",
      description: "Verify a product exists using its exact numeric ID provided in the task.",
      parameters: {
        type: "object",
        properties: { id: { type: "number", description: "Exact product ID given in the task" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_product_content",
      description: "Generate AI analysis using the exact product ID provided in the task.",
      parameters: {
        type: "object",
        properties: { product_id: { type: "number" } },
        required: ["product_id"],
      },
    },
  },
]

function runContentAgent(task, onStep) {
  return runAgentLoop(
    SPECIALIST_CONFIG,
        `You are an AI content analyst for a grocery store.
    RULES — follow exactly:
    1. The task will give you an explicit product ID — use ONLY that ID.
    2. Call get_product first to confirm it exists, then generate_product_content.
    3. NEVER guess or invent product IDs.
    4. If no ID is provided in the task, say "No product ID was provided" and stop.`,
    task, CONTENT_TOOLS, onStep,
  )
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────
// The only function exported and called by AgentChat.
// Analyses the user's intent and delegates to the right specialist(s).
// For complex queries it can call multiple specialists in sequence and
// synthesise their answers into one response.

const ORCHESTRATOR_TOOLS = [
  {
    type: "function",
    function: {
      name: "ask_product_agent",
      description: `Delegate to the product specialist. Use for:
- Finding, searching, or filtering products
- Browsing by category
- Comparing prices across products or categories
- Getting product details`,
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "A clear, specific task for the product specialist" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_review_agent",
      description: `Delegate to the review specialist. Use for:
- Reading or summarising product reviews
- Checking average ratings or sentiment
- Submitting a new review on behalf of the user`,
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "A clear, specific task for the review specialist" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_content_agent",
      description: `Delegate to the AI content specialist. Use for:
- Generating AI-powered product content analysis
- Explaining what the AI analysis reveals about a product`,
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "A clear, specific task for the content specialist" },
        },
        required: ["task"],
      },
    },
  },
]

export async function runAgent(userMessage, onStep) {
  _validProductIds = new Set()
  const messages = [
    {
      role: "system",
      content: `You are the orchestrator for a grocery AI assistant.
Call specialists to gather data, then synthesise a final answer.
Never answer directly from memory — always use specialists to get real data.

CRITICAL RULE FOR COMPARISONS AND REVIEWS:
Step 1 — Always call ask_product_agent FIRST to find products and their real IDs.
Step 2 — Pass those exact IDs explicitly in the task to ask_review_agent or ask_content_agent.

Example of a correct task for ask_review_agent:
"Get reviews for product ID 1 (Kidney Beans) and product ID 5 (Whole Milk)"

Example of a WRONG task for ask_review_agent (never do this):
"Find the best reviewed dairy product"  ← no IDs given, causes hallucination

Always include the numeric ID and product name in any task you pass to specialists.
Call each specialist at most once. After receiving all results, write your final answer.

Routing:
- Products, prices, search, categories → ask_product_agent
- Reviews, ratings, submitting feedback → ask_review_agent
- AI content analysis                  → ask_content_agent`,
    },
    { role: "user", content: userMessage },
  ]

  const MAX_SPECIALIST_CALLS = 3
  let specialistCalls = 0

  // Phase 1: gather data — allow at most 3 specialist calls
  while (specialistCalls < MAX_SPECIALIST_CALLS) {
    const data = await callGroq(ORCHESTRATOR_CONFIG, {
      model:       ORCHESTRATOR_CONFIG.model,
      messages,
      tools:       ORCHESTRATOR_TOOLS,
      tool_choice: "auto",
      temperature: 0.1,
    })

    const choice  = data.choices[0]
    const message = choice.message

    // Orchestrator produced a final answer on its own — done
    if (choice.finish_reason === "stop") return message.content

    if (choice.finish_reason === "tool_calls" && message.tool_calls?.length) {
      messages.push({ role: "assistant", ...message })

      for (const toolCall of message.tool_calls) {
  const name  = toolCall.function.name
  const input = JSON.parse(toolCall.function.arguments || "{}") || {}
  let task    = input.task

  // JavaScript injects real IDs — never trust the LLM to copy them correctly
  if (
    (name === "ask_review_agent" || name === "ask_content_agent") &&
    _validProductIds.size > 0
  ) {
    const realIds    = [..._validProductIds]
    const hasRealId  = realIds.some(id => task.includes(String(id)))

    if (!hasRealId) {
      const idList = realIds.map(id => `ID ${id}`).join(", ")
      task = `${task}\n\n[SYSTEM OVERRIDE: Ignore any product IDs in the task above. The ONLY valid product IDs in this database are: ${idList}. You must use exclusively these IDs.]`
    }
  }

  onStep?.({ type: "routing", name, task: input.task })

  let result
  try {
    switch (name) {
      case "ask_product_agent":
        result = await runProductAgent(task, onStep)
        break
      case "ask_review_agent":
        result = await runReviewAgent(task, onStep)
        break
      case "ask_content_agent":
        result = await runContentAgent(task, onStep)
        break
      default:
        result = `Unknown specialist: ${name}`
    }
  } catch (err) {
    result = `Specialist error: ${err.message}`
  }

  onStep?.({ type: "specialist_done", name })

  messages.push({
    role:         "tool",
    tool_call_id: toolCall.id,
    content:      result,
  })
}
    }
  }

  // Phase 2: force synthesis — tool calls are now disabled
  messages.push({
    role:    "user",
    content: "You have all the data you need. Write your final answer to the user now. Do not call any more specialists.",
  })

  const final = await callGroq(ORCHESTRATOR_CONFIG, {
    model:       ORCHESTRATOR_CONFIG.model,
    messages,
    tool_choice: "none",  // hard block on further tool calls
    temperature: 0.1,
  })

  return final.choices[0].message.content
}