import React, { useState, useRef, useEffect } from 'react'
import { Input, Button, Avatar, Tag, Spin } from 'antd'
// import {
//   UserOutlined,
//   RobotOutlined,
//   SendOutlined,
//   ThunderboltOutlined,
// } from '@ant-design/icons'
import { UserOutlined, RobotOutlined, SendOutlined, ThunderboltOutlined, ApartmentOutlined } from '@ant-design/icons'
import { runAgent } from '../agents'
import './AgentChat.css'

const { TextArea } = Input

const SUGGESTIONS = [
  'What dairy products do you have?',
  "What's the cheapest product in each category?",
  'Which product has the best reviews?',
  'Compare prices between meat and vegetables',
  'Submit a 5-star review for product 1 saying it was excellent',
]

export default function AgentChat() {
  const [messages, setMessages] = useState([])
  const [steps,    setSteps]    = useState([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, steps])

  const send = async (text) => {
    const query = (text ?? input).trim()
    if (!query || loading) return

    setInput('')
    setLoading(true)
    setSteps([])
    setMessages(prev => [...prev, { role: 'user', content: query }])

    try {
      const answer = await runAgent(query, (step) => {
        setSteps(prev => [...prev, step])
      })
      setMessages(prev => [...prev, { role: 'assistant', content: answer }])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Something went wrong: ${err.message}`,
      }])
    } finally {
      setLoading(false)
      setSteps([])
    }
  }

  const isWelcome = messages.length === 0

  return (
    <div className="chat-container">

      {/* ── Welcome screen ─────────────────────────────────────────────── */}
      {isWelcome && (
        <div className="welcome">
          <div className="welcome-icon">
            <RobotOutlined />
          </div>
          <h2>Grocery Assistant</h2>
          <p>Ask me anything about products, prices, and reviews.</p>
          <div className="suggestions">
            {SUGGESTIONS.map((s, i) => (
              <button key={i} className="suggestion-chip" onClick={() => send(s)}>
                <ThunderboltOutlined className="chip-icon" />
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Message list ───────────────────────────────────────────────── */}
      {!isWelcome && (
        <div className="messages">
          {messages.map((m, i) => (
            <div key={i} className={`message message-${m.role}`}>
              <Avatar
                icon={m.role === 'user' ? <UserOutlined /> : <RobotOutlined />}
                className={`avatar avatar-${m.role}`}
              />
              <div className="bubble">{m.content}</div>
            </div>
          ))}

          {/* Tool call progress indicators */}
          {/* {loading && steps.length > 0 && (
            <div className="tool-steps">
              {steps.map((s, i) => (
                <Tag
                  key={i}
                  color={s.type === 'tool_call' ? 'orange' : 'green'}
                  style={{ fontSize: 12 }}
                >
                  {s.type === 'tool_call'
                    ? `Calling ${s.name}…`
                    : `✓ ${s.name}`}
                </Tag>
              ))}
            </div>
          )} */}

          {loading && steps.length > 0 && (
          <div className="tool-steps">
            {steps.map((s, i) => {
              const LABELS = {
                ask_product_agent: 'Product agent',
                ask_review_agent:  'Review agent',
                ask_content_agent: 'Content agent',
              }
              if (s.type === 'routing') return (
                <div key={i} style={{ display:'flex', alignItems:'center', gap:6 }}>
                  <ApartmentOutlined style={{ color:'#722ed1', fontSize:12 }} />
                  <Tag color="purple" style={{ fontSize:11, margin:0 }}>{LABELS[s.name]}</Tag>
                  <span style={{ fontSize:11, color:'#9ca3af', fontStyle:'italic' }}>
                    {s.task?.slice(0, 70)}{s.task?.length > 70 ? '…' : ''}
                  </span>
                </div>
              )
              if (s.type === 'tool_call')      return <Tag key={i} color="orange" style={{ fontSize:11 }}>{s.name}…</Tag>
              if (s.type === 'tool_result')    return <Tag key={i} color="green"  style={{ fontSize:11 }}>✓ {s.name}</Tag>
              if (s.type === 'specialist_done') return <Tag key={i} color="blue"  style={{ fontSize:11 }}>{LABELS[s.name]} done</Tag>
              return null
            })}
          </div>
          )}

          {/* Thinking indicator */}
          {loading && (
            <div className="message message-assistant">
              <Avatar icon={<RobotOutlined />} className="avatar avatar-assistant" />
              <div className="bubble thinking">
                <Spin size="small" />
                <span>Thinking…</span>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}

      {/* ── Input bar ──────────────────────────────────────────────────── */}
      <div className="input-bar">
        <TextArea
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Ask about products, prices, reviews… (Enter to send)"
          autoSize={{ minRows: 1, maxRows: 5 }}
          disabled={loading}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={() => send()}
          disabled={loading || !input.trim()}
          style={{ height: 40, width: 40, borderRadius: 10 }}
        />
      </div>

    </div>
  )
}
