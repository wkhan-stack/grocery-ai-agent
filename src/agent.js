// ─── Config ───────────────────────────────────────────────────────────────────
//
//  Using Groq (free — sign up at console.groq.com, no credit card needed).
//  Add your key to .env:  VITE_GROQ_KEY=gsk_your_key_here
//
//  To use local Ollama instead, flip USE_GROQ to false.
//  Check Ollama is running first:  curl http://localhost:11434/api/tags

const USE_GROQ = true

const CONFIG = USE_GROQ
  ? {
      url:    'https://api.groq.com/openai/v1/chat/completions',
      model:  'llama-3.3-70b-versatile',
      // Vite uses import.meta.env — NOT process.env
      apiKey: import.meta.env.VITE_GROQ_KEY,
    }
  : {
      url:    'http://localhost:11434/v1/chat/completions',
      model:  'llama3.1',   // run `ollama list` to see installed models
      apiKey: 'ollama',     // Ollama ignores this but the header is required
    }

// ─── Tool definitions (OpenAI-compatible format) ──────────────────────────────

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_products',
      description: `Get all products from the store. Optionally filter by category_id.
        Returns name, price, image, and category for each product.`,
      parameters: {
        type: 'object',
        properties: {
          category_id: {
            type: 'number',
            description: 'Optional. Filter products to this category ID only.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_product',
      description: `Get a single product by ID, including full details,
        ingredients, and description.`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'Product ID' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_categories',
      description: `Get all product categories. Always call this first when the
        user mentions a category by name — you need the ID before filtering products.`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reviews',
      description: `Always call list_products first to get valid product IDs before calling this.`,
      parameters: {
        type: 'object',
        properties: {
          product_id: {
            type: 'number',
            description: 'Product ID to fetch reviews for',
          },
        },
        required: ['product_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'submit_review',
      description: `Submit a new customer review for a product.
        Use only when the user explicitly wants to leave a rating or write a review.`,
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'number' },
          title:      { type: 'string', description: 'Short review headline' },
          content:    { type: 'string', description: 'Full review text' },
          rating: {
            type: 'number',
            minimum: 1,
            maximum: 5,
            description: 'Rating from 1 to 5',
          },
        },
        required: ['product_id', 'title', 'content', 'rating'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'generate_product_content',
      description: `Use AI to generate a structured content analysis for a product
        based on its reviews. Returns a summary and tagged topics.`,
      parameters: {
        type: 'object',
        properties: {
          product_id: { type: 'number' },
        },
        required: ['product_id'],
      },
    },
  },
  {
  type: "function",
  function: {
    name: "search_products_semantic",
    description: `Search products by meaning, not exact keywords. Use this when
      the user describes what they want ('something high in protein', 'quick to
      cook', 'good for weight loss') rather than naming a specific product.
      Prefer this over list_products for any descriptive or natural language query.`,
    parameters: {
      type: "object",
      properties: {
        query:     { type: "string",  description: "What the user is looking for, in their own words" },
        n_results: { type: "number",  description: "How many results to return, default 5" }
      },
      required: ["query"]
    }
  }
  }
]

// ─── Execute tool calls (hits your existing backend — unchanged) ───────────────

async function executeTool(name, input) {
  const BASE = '/api/v1'

  switch (name) {
    case 'list_products': {
      const products = await fetch(`${BASE}/products`).then(r => r.json())
      const valid = Array.isArray(products) ? products.filter(Boolean) : []
      return input.category_id
        ? valid.filter(p => p.category_id === input.category_id)
        : valid
    }
    case 'get_product':
      return fetch(`${BASE}/product/${input.id}`).then(r => r.json())

    case 'list_categories': {
      const data = await fetch(`${BASE}/categories`).then(r => r.json())
      return Array.isArray(data) ? data.filter(Boolean) : []
    }

    case 'get_reviews': {
      const res = await fetch(`${BASE}/reviews/${input.product_id}`)
      if (!res.ok) return []
      const data = await res.json()
      return Array.isArray(data) ? data.filter(Boolean) : []
    }

    case 'submit_review':
      return fetch(`${BASE}/reviews`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...input, approved: true }),
      }).then(r => r.json())

    case 'generate_product_content':
      return fetch(`${BASE}/llama/generate/${input.product_id}`, {
        method: 'POST',
      }).then(r => r.json())
    case "search_products_semantic":
    return fetch(`${BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: input.query, n_results: input.n_results || 5 }),
    }).then(r => r.json())
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

export async function runAgent(userMessage, onStep) {
  const messages = [
    {
      role: 'system',
      content: `You are a helpful shopping assistant for a grocery e-commerce store.
Always use tools to get real data — never guess prices, names, or availability.
When the user mentions a category by name, call list_categories first to find its ID.
Think step by step before calling tools.`,
    },
    { role: 'user', content: userMessage },
  ]

  let iterations = 0
  const MAX_ITERATIONS = 10

  while (iterations < MAX_ITERATIONS) {
    iterations++

    const response = await fetch(CONFIG.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CONFIG.apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.model,
        messages,
        tools: TOOLS,
        tool_choice: 'auto',
        temperature: 0.1,
      }),
    })

    const data = await response.json()
    if (!response.ok) throw new Error(data.error?.message ?? 'API error')

    const choice  = data.choices[0]
    const message = choice.message

    // Done — return the final text response
    if (choice.finish_reason === 'stop') {
      return message.content
    }

    // Tool calls requested
    if (choice.finish_reason === 'tool_calls' && message.tool_calls?.length) {
      messages.push({ role: 'assistant', ...message })

      for (const toolCall of message.tool_calls) {
        const name  = toolCall.function.name
          const input = JSON.parse(toolCall.function.arguments || '{}') || {}  // ← fix here

        onStep?.({ type: 'tool_call',   name, input })
        const result = await executeTool(name, input)
        onStep?.({ type: 'tool_result', name, result })

        messages.push({
          role:         'tool',
          tool_call_id: toolCall.id,
          content:      JSON.stringify(result),
        })
      }
    }
  }

  throw new Error('Agent reached max iterations without completing.')
}
