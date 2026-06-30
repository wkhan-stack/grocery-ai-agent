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
    },
    {
  name: "search_products_semantic",
  description: `Search products by meaning, not keywords. Use this when the
    user describes what they want ('something high in protein', 'healthy
    snack', 'good for weight loss') rather than naming a specific product.
    Always prefer this over list_products for descriptive queries.`,
  inputSchema: {
    type: "object",
    properties: {
      query:     { type: "string", description: "What the user is looking for, in their own words" },
      n_results: { type: "number", description: "How many results to return, default 5" }
    },
    required: ["query"]
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
      case "search_products_semantic": {
        const res = await axios.post(`${BASE}/search`, {
          query:     args.query,
          n_results: args.n_results || 5,
        });
        data = res.data;
        break;
      }
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